import base64
import binascii
import hmac
import mimetypes
import uuid

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.shortcuts import get_object_or_404
from rest_framework import generics, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from . import catalogue_ai
from .ai_client import TEXT_PROVIDERS, AIError, AINotConfigured
from .image_client import IMAGE_PROVIDERS, generate_image
from .storage_client import StorageClientError, upload_bytes
from .models import (
    PROVIDER_CHOICES,
    AIProviderConfig,
    Artifact,
    ArtifactEffect,
    Block,
    BlockDrop,
    Character,
    Department,
    DepthTier,
    DepthTierBlockRate,
    DepthTierMonsterSpawn,
    GameMap,
    Item,
    Monster,
    MonsterDrop,
    MonsterSkill,
    Portal,
    Projectile,
    RecipeIngredient,
    RelayTicket,
    RigTemplate,
    SpriteAsset,
    StatusEffect,
    Tool,
    UserRecord,
    Weapon,
    WeaponProjectile,
    World,
)
from .serializers import (
    AIProviderConfigSerializer,
    ArtifactEffectSerializer,
    ArtifactSerializer,
    BlockDropSerializer,
    BlockSerializer,
    CharacterSerializer,
    DepartmentSerializer,
    DepthTierBlockRateSerializer,
    DepthTierMonsterSpawnSerializer,
    DepthTierSerializer,
    GameMapSerializer,
    PortalSerializer,
    ItemSerializer,
    MonsterDropSerializer,
    MonsterSerializer,
    MonsterSkillSerializer,
    ProjectileSerializer,
    RecipeIngredientSerializer,
    RigTemplateSerializer,
    SpriteAssetSerializer,
    StatusEffectSerializer,
    ToolSerializer,
    UserRecordSerializer,
    WeaponProjectileSerializer,
    WeaponSerializer,
    WorldDetailSerializer,
    WorldSerializer,
)

_VALID_PROVIDERS = {key for key, _ in PROVIDER_CHOICES}

# Borne haute de `segment_count` (apply-template) : celle du champ « Nombre de
# segments » de l'interface (monster-builder.component.html, max="20").
MAX_RIG_SEGMENTS = 20


def _save_child(serializer, **parent):
    """Enregistre une ligne de sous-liste soumise à une contrainte d'unicité
    avec son parent (un ingrédient par recette, un projectile par arme, un block
    ou un monstre par palier). Le parent n'est pas un champ du sérialiseur, donc
    DRF ne voit pas la contrainte : un doublon n'était arrêté que par la base
    (IntegrityError, erreur 500). Le point de sauvegarde garde la transaction
    en cours utilisable."""
    try:
        with transaction.atomic():
            serializer.save(**parent)
    except IntegrityError as exc:
        raise ValidationError('Cette ligne figure déjà dans la liste.') from exc


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
        if provider not in TEXT_PROVIDERS:
            # Fournisseur d'images seulement : sans ce refus, KeyError (500).
            raise ValidationError(
                {'provider': f"'{provider}' ne génère que des images — choisissez "
                             f"{' ou '.join(sorted(TEXT_PROVIDERS))} pour une suggestion de texte."},
            )

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
        _save_child(serializer, item=item)
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
        _save_child(serializer, weapon=weapon)
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

    queryset = Monster.objects.all().select_related('projectile__item').prefetch_related('skills', 'drops__dropped_item')
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

        # Lot 10 (bis) : une icône de monstre (IA/upload/composite du montage par pièces) est aussi un
        # asset "monstre assemblé" réutilisable ailleurs — upsert par file_path (déterministe par
        # monstre, cf. relative_path ci-dessus) plutôt qu'une nouvelle ligne à chaque régénération,
        # jamais via SpriteAssetViewSet (source cc0-bundled mise à part, c'est le seul chemin
        # d'écriture qui ne passe pas par cette action générique).
        SpriteAsset.objects.update_or_create(
            file_path=relative_path,
            defaults={
                'name': monster.name,
                'category': SpriteAsset.Category.MONSTER_CREATURE,
                'source': SpriteAsset.Source.UPLOAD if upload is not None else SpriteAsset.Source.AI_GENERATED,
                'created_by_email': getattr(request.user, 'email', '') or '',
            },
        )
        return Response(self.get_serializer(monster).data)

    @action(detail=True, methods=['post'], url_path='apply-template')
    def apply_template(self, request, pk=None):
        """
        Lot 11 — matérialise un `RigTemplate` en vrai `Monster.rig` (remplace intégralement le rig
        existant, comme un nouveau montage manuel depuis zéro — cf. cahier des charges : "positions/
        chorégraphies par défaut copiées telles quelles dans Monster.rig, éditables ensuite avec les
        outils déjà existants"). Ne touche à rien d'autre (stats, icon_path...).

        Body : `{"template_id": <int>, "slot_assets": {"<slot_key>": <SpriteAsset id>, ...},
        "segment_count"?: <int>}` — `segment_count` uniquement pertinent pour un gabarit à slot
        repeatable (Ver/serpent), ignoré sinon.
        """
        monster = self.get_object()
        template_id = request.data.get('template_id')
        slot_assets = request.data.get('slot_assets') or {}
        segment_count = request.data.get('segment_count')

        try:
            template = RigTemplate.objects.get(pk=template_id)
        except (RigTemplate.DoesNotExist, ValueError, TypeError):
            raise NotFound(f"Gabarit inconnu : '{template_id}'.")

        # Validé avant toute construction : `int()` sans garde finissait en
        # erreur 500, et sans borne haute un entier énorme faisait construire
        # autant de pièces en mémoire. En dessous de 1, le plancher historique
        # (max(1, …) plus bas) est conservé.
        if segment_count not in (None, ''):
            if isinstance(segment_count, bool):
                raise ValidationError({'segment_count': 'Doit être un nombre entier.'})
            try:
                segment_count = int(segment_count)
            except (TypeError, ValueError):
                raise ValidationError({'segment_count': 'Doit être un nombre entier.'})
            if segment_count > MAX_RIG_SEGMENTS:
                raise ValidationError(
                    {'segment_count': f'Au plus {MAX_RIG_SEGMENTS} segments.'},
                )

        parts = []
        # slot_key -> partId (slot simple) ou slot_key -> [partId, ...] (slot repeatable, un id par segment).
        slot_to_part_ids: dict = {}
        for slot in template.slots:
            slot_key = slot['slot_key']
            asset_id = slot_assets.get(slot_key)
            if asset_id is None:
                if slot.get('required', True):
                    raise ValidationError({'slot_assets': f"Image requise pour le slot '{slot_key}'."})
                continue
            if slot.get('repeatable'):
                count = max(1, int(segment_count or slot.get('default_count') or 1))
                part_ids = []
                for i in range(count):
                    part_id = str(uuid.uuid4())
                    part_ids.append(part_id)
                    parts.append({
                        'id': part_id, 'assetId': asset_id,
                        'x': slot['default_x'] * i, 'y': slot['default_y'] * i,
                        'flip': False, 'isWeapon': False, 'collidesTerrain': False,
                    })
                slot_to_part_ids[slot_key] = part_ids
            else:
                part_id = str(uuid.uuid4())
                slot_to_part_ids[slot_key] = part_id
                parts.append({
                    'id': part_id, 'assetId': asset_id,
                    'x': slot['default_x'], 'y': slot['default_y'],
                    'flip': False, 'isWeapon': False, 'collidesTerrain': False,
                })

        skills = []
        for skill in template.default_skills:
            new_steps = []
            for step in skill['steps']:
                new_poses = {}
                for slot_key, pose_or_wave in step['poses'].items():
                    mapped = slot_to_part_ids.get(slot_key)
                    if mapped is None:
                        continue  # slot optionnel non choisi par l'utilisateur — ignoré.
                    if isinstance(mapped, list):
                        # Slot repeatable : `pose_or_wave` est une liste de longueur `wavelength` (une
                        # "photo" de la vague à cette étape) — le segment i lit toujours l'entrée
                        # i % wavelength ; cf. RigTemplate.default_skills (models.py) pour le détail.
                        wavelength = len(pose_or_wave)
                        for i, part_id in enumerate(mapped):
                            new_poses[part_id] = dict(pose_or_wave[i % wavelength])
                    else:
                        new_poses[mapped] = dict(pose_or_wave)
                new_steps.append({'durationMs': step['durationMs'], 'poses': new_poses})
            skills.append({'id': str(uuid.uuid4()), 'name': skill['name'], 'type': skill['type'], 'steps': new_steps})

        monster.rig = {'parts': parts, 'skills': skills}
        monster.save(update_fields=['rig'])
        return Response(self.get_serializer(monster).data)


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 11 : gabarits de monstre
# ──────────────────────────────────────────────────────────────────────────────


class RigTemplateViewSet(viewsets.ReadOnlyModelViewSet):
    """Lecture seule — les gabarits sont semés par migration (`0016_rigtemplate_bipede.py` et
    suivantes), aucune UI d'édition dans ce lot (cf. RigTemplateSerializer)."""

    queryset = RigTemplate.objects.all()
    serializer_class = RigTemplateSerializer


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
        _save_child(serializer, depth_tier=tier)
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
        _save_child(serializer, depth_tier=tier)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['delete'], url_path=r'monster-spawns/(?P<spawn_id>\d+)')
    def monster_spawns_delete(self, request, pk=None, spawn_id=None):
        tier = self.get_object()
        spawn = get_object_or_404(DepthTierMonsterSpawn, pk=spawn_id, depth_tier=tier)
        spawn.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 10 : bibliothèque d'assets centralisée
# ──────────────────────────────────────────────────────────────────────────────


class SpriteAssetViewSet(viewsets.ModelViewSet):
    """
    Lecture filtrable (`?category=`, `?slot_hint=`, `?search=` sur le nom, `?tag=`) ; création par
    upload (`file` multipart) ou image déjà produite ailleurs (`image_base64`+`mime_type`, même
    contrat que ItemCategoryViewSetMixin.icon) — jamais les deux à la fois. `source` est déduit du
    champ effectivement fourni, jamais choisi librement par le client : `cc0-bundled` est réservé à
    la commande de gestion `import_sprite_library`, jamais atteignable via cette action.
    """

    queryset = SpriteAsset.objects.all()
    serializer_class = SpriteAssetSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        category = self.request.query_params.get('category')
        if category:
            qs = qs.filter(category=category)
        slot_hint = self.request.query_params.get('slot_hint')
        if slot_hint:
            qs = qs.filter(slot_hint=slot_hint)
        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(name__icontains=search)
        tag = self.request.query_params.get('tag')
        if tag:
            qs = qs.filter(tags__contains=[tag])
        return qs

    def create(self, request, *args, **kwargs):
        upload = request.FILES.get('file')
        if upload is not None:
            image_bytes = upload.read()
            mime_type = upload.content_type or 'image/png'
            source = SpriteAsset.Source.UPLOAD
        else:
            image_base64 = request.data.get('image_base64')
            if not image_base64:
                raise ValidationError({'image_base64': 'Requis (ou "file" en multipart).'})
            try:
                image_bytes = base64.b64decode(image_base64, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValidationError({'image_base64': "Image invalide (base64 non décodable)."}) from exc
            mime_type = request.data.get('mime_type') or 'image/png'
            source = SpriteAsset.Source.AI_GENERATED

        name = (request.data.get('name') or '').strip()
        if not name:
            raise ValidationError({'name': 'Requis.'})
        category = request.data.get('category')
        valid_categories = {c for c, _ in SpriteAsset.Category.choices}
        if category not in valid_categories:
            raise ValidationError({'category': f"Doit être l'une de : {', '.join(sorted(valid_categories))}."})
        slot_hint = request.data.get('slot_hint') or ''

        tags_raw = request.data.get('tags')
        if isinstance(tags_raw, list):
            tags = [str(t).strip() for t in tags_raw if str(t).strip()]
        elif isinstance(tags_raw, str) and tags_raw:
            tags = [t.strip() for t in tags_raw.split(',') if t.strip()]
        else:
            tags = []

        ext = mimetypes.guess_extension(mime_type) or '.png'
        relative_path = f'sprite-assets/{category}/{uuid.uuid4().hex}{ext}'
        try:
            upload_bytes(request.headers.get('Authorization', ''), relative_path, image_bytes, mime_type)
        except StorageClientError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_502_BAD_GATEWAY)

        asset = SpriteAsset.objects.create(
            name=name, category=category, slot_hint=slot_hint, file_path=relative_path,
            source=source, tags=tags, created_by_email=getattr(request.user, 'email', '') or '',
        )
        return Response(self.get_serializer(asset).data, status=status.HTTP_201_CREATED)


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 5 : portails
# ──────────────────────────────────────────────────────────────────────────────


class PortalViewSet(viewsets.ModelViewSet):
    """
    CRUD direct (comme GameMap/DepthTier) — rien ne référence un Portal en
    PROTECT dans le schéma actuel, pas de perform_destroy particulier requis.
    """

    queryset = Portal.objects.select_related('destination_map')
    serializer_class = PortalSerializer


# ──────────────────────────────────────────────────────────────────────────────
# CRAFT-LAB — Lot 7 : persistance des mondes et personnages
# ──────────────────────────────────────────────────────────────────────────────


class WorldViewSet(viewsets.ModelViewSet):
    """
    Un monde est un objet partagé par tout le groupe autorisé (même catalogue
    partagé que le reste de l'app — aucune app du lab avec cloisonnement de
    lecture par utilisateur, cf. CLAUDE.md) : n'importe quel membre peut
    lister/créer/reprendre/supprimer n'importe quelle partie sauvegardée. Ce
    qui est propre à chaque joueur, c'est son `Character` dans ce monde
    (action `character` ci-dessous), pas le monde lui-même.
    """

    queryset = World.objects.all()

    def get_serializer_class(self):
        return WorldSerializer if self.action == 'list' else WorldDetailSerializer

    def perform_create(self, serializer):
        serializer.save(created_by_email=self.request.user.email)

    @action(detail=True, methods=['get', 'put'], url_path='character')
    def character(self, request, pk=None):
        """
        GET : récupère (en la créant si besoin — get_or_create) l'avancement
        de l'utilisateur courant dans ce monde. PUT : le met à jour en entier
        (position/PV/inventaire/arme équipée) — utilisé par `save` côté client
        au moment de sauvegarder/quitter, jamais d'auto-save côté serveur.

        Le GET renvoie aussi `created` : distingue « je viens de créer cette
        ligne, ses valeurs par défaut (x=0, y=0) ne correspondent à rien de
        réel » d'un vrai personnage sauvegardé à cette position précise.
        Important en multijoueur (Lot 8) : un deuxième joueur qui rejoint un
        monde tout juste créé par un autre, avant sa première sauvegarde,
        n'a pas encore de ligne Character — sans ce indicateur le client
        prendrait (0,0) pour une vraie position et y ferait apparaître le
        joueur, au lieu de repasser par la recherche de spawn normale.
        """
        world = self.get_object()
        char, created = Character.objects.get_or_create(world=world, owner_email=request.user.email)
        if request.method == 'GET':
            data = CharacterSerializer(char).data
            data['created'] = created
            return Response(data)
        serializer = CharacterSerializer(char, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    @action(detail=True, methods=['post'], url_path='save')
    def save_progress(self, request, pk=None):
        """
        Sauvegarde combinée monde + personnage en un seul appel — c'est ce
        que `Sauvegarder`/`Quitter` appellent côté client, plutôt que deux
        requêtes séparées qui pourraient réussir partiellement. `block_diff`
        est FUSIONNÉ (pas remplacé) avec l'existant : le client n'envoie que
        les cellules changées depuis le dernier chargement, jamais tout le
        diff accumulé.
        """
        world = self.get_object()
        diff_updates = request.data.get('block_diff')
        char_data = request.data.get('character')
        # `block_diff` : objet {"x,y": id de block ou null} (cf. World). Tout autre
        # forme est refusée ici — `dict.update` levait, donc erreur 500.
        if diff_updates is not None and (
            not isinstance(diff_updates, dict)
            or any(
                value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)))
                for value in diff_updates.values()
            )
        ):
            raise ValidationError(
                {'block_diff': 'Doit être un objet {"x,y": identifiant de block ou null}.'},
            )
        # Une seule transaction : un personnage refusé (400) ne doit pas laisser
        # le terrain déjà modifié derrière lui — c'est tout l'objet de cet appel.
        with transaction.atomic():
            if diff_updates:
                world.block_diff.update(diff_updates)
                world.save(update_fields=['block_diff', 'updated_at'])
            if char_data:
                char, _ = Character.objects.get_or_create(world=world, owner_email=request.user.email)
                serializer = CharacterSerializer(char, data=char_data, partial=True)
                serializer.is_valid(raise_exception=True)
                serializer.save()
        return Response({'saved': True})

    @action(detail=True, methods=['post'], url_path='relay-ticket')
    def relay_ticket(self, request, pk=None):
        """
        POST /api/worlds/<id>/relay-ticket/ — appelé par le navigateur (JWT
        Keycloak normal, donc déjà filtré par groupe requis comme toute API
        du lab) juste avant d'ouvrir la connexion WebSocket vers `relay/`
        (Lot 8). Voir RelayTicket pour le raisonnement complet.
        """
        world = self.get_object()
        ticket = RelayTicket.objects.create(world=world, owner_email=request.user.email)
        return Response({'ticket': ticket.token, 'world_id': world.id})


class VerifyRelayTicketView(APIView):
    """
    POST /api/internal/verify-relay-ticket/ — appelé par `relay/`, jamais par
    un navigateur : authentifié par secret partagé (header X-Relay-Key), même
    famille de pattern que X-Engine-Key/VerifyTicketView de robot-lab.
    Consomme le ticket (usage unique) et renvoie ce qu'il faut à `relay/`
    pour rattacher la connexion WS au bon monde/utilisateur.

    Body : {token: str}
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        key = request.headers.get('X-Relay-Key', '')
        # Comparaison en temps constant (sur des octets : `compare_digest`
        # refuse une chaîne non ASCII).
        expected = settings.RELAY_INTERNAL_KEY
        if not expected or not hmac.compare_digest(key.encode(), expected.encode()):
            return Response({'detail': 'Clé invalide.'}, status=status.HTTP_403_FORBIDDEN)

        token = (request.data.get('token') or '').strip()
        try:
            ticket = RelayTicket.objects.select_related('world').get(token=token)
        except RelayTicket.DoesNotExist:
            return Response({'detail': 'Ticket inconnu.'}, status=status.HTTP_404_NOT_FOUND)

        if not ticket.is_valid():
            return Response({'detail': 'Ticket expiré ou déjà utilisé.'}, status=status.HTTP_410_GONE)

        ticket.consume()
        return Response({'world_id': ticket.world_id, 'owner_email': ticket.owner_email})
