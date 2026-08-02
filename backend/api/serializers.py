from django.conf import settings
from rest_framework import serializers

from .models import (
    AIProviderConfig,
    Artifact,
    ArtifactEffect,
    Block,
    BlockDrop,
    Department,
    DepthTier,
    DepthTierBlockRate,
    DepthTierMonsterSpawn,
    GameMap,
    Item,
    Monster,
    MonsterDrop,
    MonsterSkill,
    Projectile,
    RecipeIngredient,
    StatusEffect,
    Tool,
    UserRecord,
    Weapon,
    WeaponProjectile,
)


class AIProviderConfigSerializer(serializers.ModelSerializer):
    """La clé API est en écriture seule : jamais renvoyée déchiffrée au frontend."""

    api_key = serializers.CharField(write_only=True, required=False, allow_blank=True)
    has_key = serializers.SerializerMethodField()

    class Meta:
        model = AIProviderConfig
        fields = ['provider', 'api_key', 'model_name', 'has_key', 'updated_at']
        read_only_fields = ['provider', 'updated_at']

    def get_has_key(self, obj) -> bool:
        return bool(obj.api_key)


class DepartmentSerializer(serializers.ModelSerializer):
    member_count = serializers.IntegerField(source='members.count', read_only=True)

    class Meta:
        model = Department
        fields = ['id', 'name', 'description', 'member_count']


class UserRecordSerializer(serializers.ModelSerializer):
    department = DepartmentSerializer(read_only=True)

    class Meta:
        model = UserRecord
        fields = ['email', 'display_name', 'department', 'registered_at']


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 1 : édition du catalogue
# ──────────────────────────────────────────────────────────────────────────────


def _icon_url(icon_path: str) -> str | None:
    """
    Chemin storage relatif (pas de domaine, pas de préfixe Caddy '/storage-api'
    — c'est au frontend de préfixer avec son storageApiUrl et d'ajouter le
    token, cf. `ApiService.iconUrl()`) — même forme que `LabStorage.url()`
    d'atelier-3d, le seul des trois patrons du lab réellement vérifié en
    usage (cf. mémoire de session : carto-lab construit une URL absolue mais
    ne l'utilise jamais nulle part).
    """
    if not icon_path:
        return None
    return f'/api/files/{settings.STORAGE_NAMESPACE}/content/{icon_path}'


class StatusEffectSerializer(serializers.ModelSerializer):
    class Meta:
        model = StatusEffect
        fields = ['id', 'code', 'name', 'description']


class ItemSerializer(serializers.ModelSerializer):
    """
    Lecture seule, tout le catalogue confondu — sert aux sélecteurs
    inter-catégories (ingrédient d'une recette, objet dropé par un block...),
    jamais à créer/modifier un objet directement (cf. WeaponViewSet et
    consorts, qui créent l'Item ET son extension de catégorie ensemble).
    """

    icon_url = serializers.SerializerMethodField()

    class Meta:
        model = Item
        fields = ['id', 'name', 'category', 'icon_path', 'icon_url']
        read_only_fields = fields

    def get_icon_url(self, obj) -> str | None:
        return _icon_url(obj.icon_path)


class RecipeIngredientSerializer(serializers.ModelSerializer):
    ingredient_name = serializers.CharField(source='ingredient.name', read_only=True)
    ingredient_category = serializers.CharField(source='ingredient.category', read_only=True)

    class Meta:
        model = RecipeIngredient
        fields = ['id', 'ingredient', 'ingredient_name', 'ingredient_category', 'quantity']


class BlockDropSerializer(serializers.ModelSerializer):
    dropped_item_name = serializers.CharField(source='dropped_item.name', read_only=True)

    class Meta:
        model = BlockDrop
        fields = ['id', 'dropped_item', 'dropped_item_name', 'quantity', 'chance']


class ArtifactEffectSerializer(serializers.ModelSerializer):
    effect_type_display = serializers.CharField(source='get_effect_type_display', read_only=True)

    class Meta:
        model = ArtifactEffect
        fields = ['id', 'effect_type', 'effect_type_display', 'parameters']


class WeaponProjectileSerializer(serializers.ModelSerializer):
    projectile_name = serializers.CharField(source='projectile.item.name', read_only=True)

    class Meta:
        model = WeaponProjectile
        fields = ['id', 'projectile', 'projectile_name', 'consumption_per_shot']


class ItemExtensionSerializer(serializers.ModelSerializer):
    """
    Base commune aux 5 catégories d'objets (Weapon/Projectile/Artifact/Tool/
    Block) : chacune est une extension 1-1 d'un Item (cf. api/models.py).
    Gère la création/mise à jour combinée Item + extension en un seul appel,
    pour qu'un formulaire d'édition corresponde à un seul appel API — même
    principe que `Plat` (restauration), qui est lui une table unique. Les
    listes associées à l'Item (recette de craft, et pour Block/Artifact/Weapon
    leurs enfants propres) sont gérées via des actions dédiées sur le
    ViewSet (cf. `ItemCategoryViewSetMixin` dans views.py), pas ici.

    Chaque sous-classe fixe uniquement `item_category` (`Item.Category.*`).
    """

    item_category: str = ''

    id = serializers.IntegerField(source='item.id', read_only=True)
    name = serializers.CharField(source='item.name')
    description = serializers.CharField(source='item.description', required=False, allow_blank=True)
    icon_path = serializers.CharField(source='item.icon_path', read_only=True)
    icon_url = serializers.SerializerMethodField()
    created_at = serializers.DateTimeField(source='item.created_at', read_only=True)
    updated_at = serializers.DateTimeField(source='item.updated_at', read_only=True)

    def get_icon_url(self, obj) -> str | None:
        return _icon_url(obj.item.icon_path)

    def validate(self, attrs):
        item_data = attrs.get('item') or {}
        name = item_data.get('name')
        if name:
            qs = Item.objects.filter(name=name)
            if self.instance is not None:
                qs = qs.exclude(pk=self.instance.item_id)
            if qs.exists():
                raise serializers.ValidationError(
                    {'name': 'Un objet du catalogue porte déjà ce nom.'},
                )
        return attrs

    def create(self, validated_data):
        item_data = validated_data.pop('item')
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        item = Item.objects.create(
            category=self.item_category,
            created_by_email=getattr(user, 'email', '') or '',
            **item_data,
        )
        return self.Meta.model.objects.create(item=item, **validated_data)

    def update(self, instance, validated_data):
        item_data = validated_data.pop('item', {})
        for attr, value in item_data.items():
            setattr(instance.item, attr, value)
        instance.item.save()
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()
        return instance


class WeaponSerializer(ItemExtensionSerializer):
    item_category = Item.Category.WEAPON

    class Meta:
        model = Weapon
        fields = [
            'id', 'name', 'description', 'icon_path', 'icon_url', 'style', 'damage',
            'attack_range', 'attack_rate', 'created_at', 'updated_at',
        ]


class ProjectileSerializer(ItemExtensionSerializer):
    item_category = Item.Category.PROJECTILE

    class Meta:
        model = Projectile
        fields = [
            'id', 'name', 'description', 'icon_path', 'icon_url', 'damage', 'effects',
            'created_at', 'updated_at',
        ]


class ArtifactSerializer(ItemExtensionSerializer):
    item_category = Item.Category.ARTIFACT

    class Meta:
        model = Artifact
        fields = ['id', 'name', 'description', 'icon_path', 'icon_url', 'created_at', 'updated_at']


class ToolSerializer(ItemExtensionSerializer):
    item_category = Item.Category.TOOL

    class Meta:
        model = Tool
        fields = [
            'id', 'name', 'description', 'icon_path', 'icon_url', 'tool_type', 'power',
            'speed', 'created_at', 'updated_at',
        ]


class BlockSerializer(ItemExtensionSerializer):
    item_category = Item.Category.BLOCK

    contact_status_effect_name = serializers.CharField(
        source='contact_status_effect.name', read_only=True, default=None,
    )

    class Meta:
        model = Block
        fields = [
            'id', 'name', 'description', 'icon_path', 'icon_url', 'is_generated', 'is_liquid',
            'hardness', 'flow_behavior', 'contact_status_effect',
            'contact_status_effect_name', 'created_at', 'updated_at',
        ]


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 4 : monstres et cartes
# ──────────────────────────────────────────────────────────────────────────────


class MonsterSkillSerializer(serializers.ModelSerializer):
    class Meta:
        model = MonsterSkill
        fields = ['id', 'name', 'description', 'parameters']


class MonsterDropSerializer(serializers.ModelSerializer):
    dropped_item_name = serializers.CharField(source='dropped_item.name', read_only=True)

    class Meta:
        model = MonsterDrop
        fields = ['id', 'dropped_item', 'dropped_item_name', 'quantity', 'chance']


class MonsterSerializer(serializers.ModelSerializer):
    """
    Contrairement aux 5 catégories d'objets, un Monster n'est pas une
    extension d'Item (cf. api/models.py) — name/description/icon_path lui
    sont propres, pas de recette de craft, mais les mêmes enfants
    (skills/drops) et la même génération d'icône que le reste du catalogue.
    """

    icon_url = serializers.SerializerMethodField()

    class Meta:
        model = Monster
        fields = [
            'id', 'name', 'description', 'icon_path', 'icon_url', 'level',
            'detection_range', 'detection_condition', 'attack_type', 'attack_damage',
            'attack_rate', 'movement_patterns', 'created_at', 'updated_at',
        ]

    def get_icon_url(self, obj) -> str | None:
        return _icon_url(obj.icon_path)


class GameMapSerializer(serializers.ModelSerializer):
    class Meta:
        model = GameMap
        fields = ['id', 'name', 'description', 'created_at', 'updated_at']


class DepthTierBlockRateSerializer(serializers.ModelSerializer):
    block_name = serializers.CharField(source='block.item.name', read_only=True)

    class Meta:
        model = DepthTierBlockRate
        fields = ['id', 'block', 'block_name', 'rate']


class DepthTierMonsterSpawnSerializer(serializers.ModelSerializer):
    monster_name = serializers.CharField(source='monster.name', read_only=True)

    class Meta:
        model = DepthTierMonsterSpawn
        fields = ['id', 'monster', 'monster_name', 'spawn_chance']


class DepthTierSerializer(serializers.ModelSerializer):
    """
    CRUD direct (pas de combinaison Item+extension ici, DepthTier est déjà
    une table simple) — `block_rates`/`monster_spawns` restent gérés via des
    actions dédiées sur DepthTierViewSet, même patron que `recipe`/`drops`.
    """

    class Meta:
        model = DepthTier
        fields = ['id', 'game_map', 'depth_index', 'void_rate']
