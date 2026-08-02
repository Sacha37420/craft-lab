import base64
import binascii

from django.db.models import ProtectedError
from django.shortcuts import get_object_or_404
from rest_framework import generics, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from . import catalogue_ai
from .ai_client import AIError, AINotConfigured
from .image_client import IMAGE_PROVIDERS, generate_image
from .storage_client import StorageClientError, upload_bytes
from .models import (
    PROVIDER_CHOICES,
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
from .serializers import (
    AIProviderConfigSerializer,
    ArtifactEffectSerializer,
    ArtifactSerializer,
    BlockDropSerializer,
    BlockSerializer,
    DepartmentSerializer,
    DepthTierBlockRateSerializer,
    DepthTierMonsterSpawnSerializer,
    DepthTierSerializer,
    GameMapSerializer,
    ItemSerializer,
    MonsterDropSerializer,
    MonsterSerializer,
    MonsterSkillSerializer,
    ProjectileSerializer,
    RecipeIngredientSerializer,
    StatusEffectSerializer,
    ToolSerializer,
    UserRecordSerializer,
    WeaponProjectileSerializer,
    WeaponSerializer,
)

_VALID_PROVIDERS = {key for key, _ in PROVIDER_CHOICES}


class MeView(APIView):
    """
    permission_classes = [IsAuthenticated]
    GET /api/me/
    Retourne l'identité de l'utilisateur authentifié (depuis le JWT + DB).
    Crée un UserRecord à la première visite.
    """

    def get(self, request):
        email    = request.user.email
        username = request.user.username
        groups   = request.user.claims.get('groups', [])

        record, created = UserRecord.objects.get_or_create(
            email=email,
            defaults={'display_name': username},
        )

        return Response({
            'email':        email,
            'username':     username,
            'groups':       groups,
            'display_name': record.display_name,
            'department':   DepartmentSerializer(record.department).data
                            if record.department else None,
            'registered_at': record.registered_at,
            'is_new':        created,
        })


class DepartmentListView(generics.ListAPIView):
    """GET /api/departments/ — liste tous les départements."""

    queryset         = Department.objects.all()
    serializer_class = DepartmentSerializer


class UserListView(generics.ListAPIView):
    """GET /api/users/ — liste tous les utilisateurs enregistrés."""

    queryset         = UserRecord.objects.select_related('department')
    serializer_class = UserRecordSerializer


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 2 : assistant IA texte (cahier des charges section 2)
# ──────────────────────────────────────────────────────────────────────────────


class AIProviderConfigView(APIView):
    """
    GET/PUT /api/ai-config/<provider>/ — configuration IA de l'utilisateur
    courant pour un fournisseur donné (claude ou mistral). Repris tel quel du
    patron robot-lab.
    """

    def _get_or_create(self, request, provider):
        if provider not in _VALID_PROVIDERS:
            raise NotFound(f"Fournisseur inconnu : '{provider}'.")
        config, _ = AIProviderConfig.objects.get_or_create(
            owner_email=request.user.email, provider=provider,
        )
        return config

    def get(self, request, provider):
        config = self._get_or_create(request, provider)
        return Response(AIProviderConfigSerializer(config).data)

    def put(self, request, provider):
        config = self._get_or_create(request, provider)
        serializer = AIProviderConfigSerializer(config, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(AIProviderConfigSerializer(config).data)


class CatalogueAssistantView(APIView):
    """
    POST /api/catalogue-assistant/suggest/ — suggestion IA (nom, description,
    stats) pour la catégorie et les champs déjà saisis fournis dans le corps
    (`{category, provider, partial}`). Ne persiste rien : c'est au frontend
    d'appliquer, ou non, la suggestion au formulaire avant un enregistrement
    explicite (même principe que l'assistant de robot-lab).
    """

    def post(self, request):
        category = request.data.get('category')
        provider = request.data.get('provider')
        partial = request.data.get('partial') or {}

        if category not in catalogue_ai.CATEGORY_SPECS:
            raise NotFound(f"Catégorie inconnue : '{category}'.")
        if provider not in _VALID_PROVIDERS:
            raise NotFound(f"Fournisseur inconnu : '{provider}'.")

        try:
            result = catalogue_ai.suggest(request.user.email, provider, category, partial)
        except AINotConfigured as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_409_CONFLICT)
        except AIError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        return Response(result)


class ImageAssistantView(APIView):
    """
    POST /api/image-assistant/generate/ — génère une image (`{prompt,
    provider}`, provider parmi gemini/mistral/openai) et la renvoie en
    base64, sans rien persister (cf. cahier des charges section 2 : « ne
    jamais écraser l'image existante avant validation explicite »). L'upload
    effectif vers storage + association à l'entité se fait séparément, via
    l'action `icon` du ViewSet concerné (`ItemCategoryViewSetMixin`), au
    clic sur « Utiliser cette image » — ou via un upload manuel direct sur
    cette même action, pour l'utilisateur qui préfère produire l'image
    ailleurs (autre outil IA, dessin...) et l'importer telle quelle.
    """

    def post(self, request):
        prompt = (request.data.get('prompt') or '').strip()
        provider = request.data.get('provider')
        if not prompt:
            raise ValidationError({'prompt': 'Requis.'})
        if provider not in IMAGE_PROVIDERS:
            raise NotFound(f"Fournisseur image inconnu : '{provider}'.")

        try:
            image_bytes, mime_type = generate_image(request.user.email, provider, prompt)
        except AINotConfigured as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_409_CONFLICT)
        except AIError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        return Response({
            'image_base64': base64.b64encode(image_bytes).decode('ascii'),
            'mime_type': mime_type,
        })


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 1 : édition du catalogue
#
# Catalogue unique partagé par le groupe requis de l'app (cf. CLAUDE.md racine,
# façon carto-lab) : IsAuthenticated (déjà le défaut global, cf. settings.py)
# suffit, aucun cloisonnement par utilisateur — tout membre du groupe lit/écrit
# tout le catalogue.
# ──────────────────────────────────────────────────────────────────────────────


class StatusEffectViewSet(viewsets.ModelViewSet):
    """
    CRUD de la liste extensible d'effets de statut (poison, feu, gel...) —
    référencée par ArtifactEffect (immunité, 1.4.6) et Block (effet de
    contact d'un liquide, 1.7).
    """

    queryset = StatusEffect.objects.all()
    serializer_class = StatusEffectSerializer


class ItemViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Lecture seule, tout le catalogue confondu — alimente les sélecteurs
    inter-catégories (ingrédient de recette, objet dropé par un block...).
    Filtrable par `?category=block|weapon|projectile|artifact|tool`.
    """

    queryset = Item.objects.all()
    serializer_class = ItemSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        category = self.request.query_params.get('category')
        if category:
            qs = qs.filter(category=category)
        return qs


class ItemCategoryViewSetMixin:
    """
    Partagé par les 5 ViewSets de catégories d'objets (Weapon/Projectile/
    Artifact/Tool/Block, extensions 1-1 d'un Item — cf. api/models.py et
    ItemExtensionSerializer) :
      - suppression en cascade jusqu'à l'Item (pas seulement la ligne
        d'extension, sous peine d'objet orphelin `category=X` sans ligne
        Weapon/Block/... correspondante) ;
      - action `recipe` (RecipeIngredient, porté par Item — même recette de
        craft quelle que soit la catégorie concrète). Même patron que
        `RecetteViewSet.lignes` (restauration/backend/api/views.py) ;
      - action `icon` (Lot 3) : upload vers storage + association à l'Item,
        déclenché au clic sur « Utiliser cette image » (jamais automatique —
        cf. ImageAssistantView, qui ne fait QUE générer/prévisualiser).
    """

    def perform_destroy(self, instance):
        try:
            instance.item.delete()
        except ProtectedError as exc:
            raise ValidationError(
                'Cet objet est référencé ailleurs dans le catalogue (recette, '
                'table de drop, ou règle de génération de carte) — retirez ces '
                'références avant de le supprimer.',
            ) from exc

    @action(detail=True, methods=['get', 'post'], url_path='recipe')
    def recipe(self, request, pk=None):
        item = self.get_object().item
        if request.method == 'GET':
            qs = item.recipe_ingredients.select_related('ingredient')
            return Response(RecipeIngredientSerializer(qs, many=True).data)
        serializer = RecipeIngredientSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(item=item)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'recipe/(?P<ingredient_id>\d+)')
    def recipe_delete(self, request, pk=None, ingredient_id=None):
        item = self.get_object().item
        ingredient = get_object_or_404(RecipeIngredient, pk=ingredient_id, item=item)
        ingredient.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'], url_path='icon')
    def icon(self, request, pk=None):
        """
        Deux façons d'arriver ici, jamais mélangées dans un même appel :
          - `image_base64`/`mime_type` en JSON — image proposée par
            ImageAssistantView, choisie via « Utiliser cette image » ;
          - `file` en multipart — upload manuel direct, pour l'utilisateur
            qui a produit l'image ailleurs (autre outil IA, dessin...) et
            l'importe telle quelle, sans passer par un fournisseur configuré.
        """
        item = self.get_object().item
        upload = request.FILES.get('file')
        if upload is not None:
            image_bytes = upload.read()
            mime_type = upload.content_type or 'image/png'
        else:
            image_base64 = request.data.get('image_base64')
            if not image_base64:
                raise ValidationError({'image_base64': 'Requis (ou "file" en multipart).'})
            try:
                image_bytes = base64.b64decode(image_base64, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValidationError({'image_base64': "Image invalide (base64 non décodable)."}) from exc
            mime_type = request.data.get('mime_type') or 'image/png'

        # Chemin stable par item (pas par génération) : une régénération
        # écrase le même fichier storage (upsert, cf. FileListUploadView côté
        # storage), aucun blob orphelin ne s'accumule.
        relative_path = f'icons/{item.category}/{item.id}.png'
        try:
            upload_bytes(request.headers.get('Authorization', ''), relative_path, image_bytes, mime_type)
        except StorageClientError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        item.icon_path = relative_path
        item.save(update_fields=['icon_path'])
        return Response(self.get_serializer(self.get_object()).data)


class WeaponViewSet(ItemCategoryViewSetMixin, viewsets.ModelViewSet):
    queryset = Weapon.objects.select_related('item').prefetch_related('projectiles__projectile__item')
    serializer_class = WeaponSerializer

    @action(detail=True, methods=['get', 'post'], url_path='projectiles')
    def projectiles(self, request, pk=None):
        weapon = self.get_object()
        if request.method == 'GET':
            qs = weapon.projectiles.select_related('projectile__item')
            return Response(WeaponProjectileSerializer(qs, many=True).data)
        serializer = WeaponProjectileSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(weapon=weapon)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'projectiles/(?P<link_id>\d+)')
    def projectiles_delete(self, request, pk=None, link_id=None):
        weapon = self.get_object()
        link = get_object_or_404(WeaponProjectile, pk=link_id, weapon=weapon)
        link.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectileViewSet(ItemCategoryViewSetMixin, viewsets.ModelViewSet):
    queryset = Projectile.objects.select_related('item')
    serializer_class = ProjectileSerializer


class ArtifactViewSet(ItemCategoryViewSetMixin, viewsets.ModelViewSet):
    queryset = Artifact.objects.select_related('item').prefetch_related('effects')
    serializer_class = ArtifactSerializer

    @action(detail=True, methods=['get', 'post'], url_path='effects')
    def effects(self, request, pk=None):
        artifact = self.get_object()
        if request.method == 'GET':
            qs = artifact.effects.all()
            return Response(ArtifactEffectSerializer(qs, many=True).data)
        serializer = ArtifactEffectSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(artifact=artifact)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'effects/(?P<effect_id>\d+)')
    def effects_delete(self, request, pk=None, effect_id=None):
        artifact = self.get_object()
        effect = get_object_or_404(ArtifactEffect, pk=effect_id, artifact=artifact)
        effect.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ToolViewSet(ItemCategoryViewSetMixin, viewsets.ModelViewSet):
    queryset = Tool.objects.select_related('item')
    serializer_class = ToolSerializer


class BlockViewSet(ItemCategoryViewSetMixin, viewsets.ModelViewSet):
    queryset = Block.objects.select_related('item', 'contact_status_effect').prefetch_related('drops__dropped_item')
    serializer_class = BlockSerializer

    @action(detail=True, methods=['get', 'post'], url_path='drops')
    def drops(self, request, pk=None):
        block = self.get_object()
        if request.method == 'GET':
            qs = block.drops.select_related('dropped_item')
            return Response(BlockDropSerializer(qs, many=True).data)
        serializer = BlockDropSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(block=block)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'drops/(?P<drop_id>\d+)')
    def drops_delete(self, request, pk=None, drop_id=None):
        block = self.get_object()
        drop = get_object_or_404(BlockDrop, pk=drop_id, block=block)
        drop.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 4 : monstres et cartes
# ──────────────────────────────────────────────────────────────────────────────


class MonsterViewSet(viewsets.ModelViewSet):
    """
    Monster n'est pas un Item (cf. MonsterSerializer) : pas de recette, pas de
    suppression en cascade vers une table parente — juste ses propres
    skills/drops/icône, avec les mêmes patrons d'action que le reste du
    catalogue.
    """

    queryset = Monster.objects.all().prefetch_related('skills', 'drops__dropped_item')
    serializer_class = MonsterSerializer

    def perform_destroy(self, instance):
        try:
            instance.delete()
        except ProtectedError as exc:
            raise ValidationError(
                'Ce monstre est référencé par une règle de génération de carte '
                '(chance de spawn à un palier) — retirez-la avant de le supprimer.',
            ) from exc

    @action(detail=True, methods=['get', 'post'], url_path='skills')
    def skills(self, request, pk=None):
        monster = self.get_object()
        if request.method == 'GET':
            return Response(MonsterSkillSerializer(monster.skills.all(), many=True).data)
        serializer = MonsterSkillSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(monster=monster)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'skills/(?P<skill_id>\d+)')
    def skills_delete(self, request, pk=None, skill_id=None):
        monster = self.get_object()
        skill = get_object_or_404(MonsterSkill, pk=skill_id, monster=monster)
        skill.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['get', 'post'], url_path='drops')
    def drops(self, request, pk=None):
        monster = self.get_object()
        if request.method == 'GET':
            qs = monster.drops.select_related('dropped_item')
            return Response(MonsterDropSerializer(qs, many=True).data)
        serializer = MonsterDropSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(monster=monster)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'drops/(?P<drop_id>\d+)')
    def drops_delete(self, request, pk=None, drop_id=None):
        monster = self.get_object()
        drop = get_object_or_404(MonsterDrop, pk=drop_id, monster=monster)
        drop.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['post'], url_path='icon')
    def icon(self, request, pk=None):
        """Même logique que ItemCategoryViewSetMixin.icon, sans indirection
        par .item : Monster porte icon_path directement (cf. models.py)."""
        monster = self.get_object()
        upload = request.FILES.get('file')
        if upload is not None:
            image_bytes = upload.read()
            mime_type = upload.content_type or 'image/png'
        else:
            image_base64 = request.data.get('image_base64')
            if not image_base64:
                raise ValidationError({'image_base64': 'Requis (ou "file" en multipart).'})
            try:
                image_bytes = base64.b64decode(image_base64, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValidationError({'image_base64': "Image invalide (base64 non décodable)."}) from exc
            mime_type = request.data.get('mime_type') or 'image/png'

        relative_path = f'icons/monster/{monster.id}.png'
        try:
            upload_bytes(request.headers.get('Authorization', ''), relative_path, image_bytes, mime_type)
        except StorageClientError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        monster.icon_path = relative_path
        monster.save(update_fields=['icon_path'])
        return Response(self.get_serializer(monster).data)


class GameMapViewSet(viewsets.ModelViewSet):
    """Une carte (1.9) — CRUD simple, les paliers vivent sur DepthTierViewSet."""

    queryset = GameMap.objects.all()
    serializer_class = GameMapSerializer


class DepthTierViewSet(viewsets.ModelViewSet):
    """
    Paliers de profondeur d'une carte — filtrable par `?game_map=<id>`.
    `block_rates`/`monster_spawns` gérés via des actions dédiées, même
    patron que `recipe`/`drops` sur les catégories d'objets.
    """

    queryset = DepthTier.objects.select_related('game_map')
    serializer_class = DepthTierSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        game_map = self.request.query_params.get('game_map')
        if game_map:
            qs = qs.filter(game_map=game_map)
        return qs

    @action(detail=True, methods=['get', 'post'], url_path='block-rates')
    def block_rates(self, request, pk=None):
        tier = self.get_object()
        if request.method == 'GET':
            qs = tier.block_rates.select_related('block__item')
            return Response(DepthTierBlockRateSerializer(qs, many=True).data)
        serializer = DepthTierBlockRateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(depth_tier=tier)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'block-rates/(?P<rate_id>\d+)')
    def block_rates_delete(self, request, pk=None, rate_id=None):
        tier = self.get_object()
        rate = get_object_or_404(DepthTierBlockRate, pk=rate_id, depth_tier=tier)
        rate.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=['get', 'post'], url_path='monster-spawns')
    def monster_spawns(self, request, pk=None):
        tier = self.get_object()
        if request.method == 'GET':
            qs = tier.monster_spawns.select_related('monster')
            return Response(DepthTierMonsterSpawnSerializer(qs, many=True).data)
        serializer = DepthTierMonsterSpawnSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(depth_tier=tier)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'monster-spawns/(?P<spawn_id>\d+)')
    def monster_spawns_delete(self, request, pk=None, spawn_id=None):
        tier = self.get_object()
        spawn = get_object_or_404(DepthTierMonsterSpawn, pk=spawn_id, depth_tier=tier)
        spawn.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
