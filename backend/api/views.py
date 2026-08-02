from django.db.models import ProtectedError
from django.shortcuts import get_object_or_404
from rest_framework import generics, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    Artifact,
    ArtifactEffect,
    Block,
    BlockDrop,
    Department,
    Item,
    Projectile,
    RecipeIngredient,
    StatusEffect,
    Tool,
    UserRecord,
    Weapon,
    WeaponProjectile,
)
from .serializers import (
    ArtifactEffectSerializer,
    ArtifactSerializer,
    BlockDropSerializer,
    BlockSerializer,
    DepartmentSerializer,
    ItemSerializer,
    ProjectileSerializer,
    RecipeIngredientSerializer,
    StatusEffectSerializer,
    ToolSerializer,
    UserRecordSerializer,
    WeaponProjectileSerializer,
    WeaponSerializer,
)


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
        `RecetteViewSet.lignes` (restauration/backend/api/views.py).
    """

    def perform_destroy(self, instance):
        try:
            instance.item.delete()
        except ProtectedError as exc:
            raise ValidationError(
                'Cet objet est référencé (recette ou table de drop) ailleurs '
                'dans le catalogue — retirez ces références avant de le supprimer.',
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
