from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AIProviderConfigView,
    ArtifactViewSet,
    BlockViewSet,
    CatalogueAssistantView,
    DepartmentListView,
    DepthTierViewSet,
    GameMapViewSet,
    ImageAssistantView,
    ItemViewSet,
    MeView,
    MonsterViewSet,
    PortalViewSet,
    ProjectileViewSet,
    StatusEffectViewSet,
    ToolViewSet,
    UserListView,
    WeaponViewSet,
    WorldViewSet,
)

router = DefaultRouter()
router.register('items', ItemViewSet, basename='item')
router.register('status-effects', StatusEffectViewSet, basename='status-effect')
router.register('weapons', WeaponViewSet, basename='weapon')
router.register('projectiles', ProjectileViewSet, basename='projectile')
router.register('artifacts', ArtifactViewSet, basename='artifact')
router.register('tools', ToolViewSet, basename='tool')
router.register('blocks', BlockViewSet, basename='block')
router.register('monsters', MonsterViewSet, basename='monster')
router.register('game-maps', GameMapViewSet, basename='game-map')
router.register('depth-tiers', DepthTierViewSet, basename='depth-tier')
router.register('portals', PortalViewSet, basename='portal')
router.register('worlds', WorldViewSet, basename='world')

urlpatterns = [
    path('me/',          MeView.as_view()),
    path('departments/', DepartmentListView.as_view()),
    path('users/',       UserListView.as_view()),
    path('ai-config/<str:provider>/', AIProviderConfigView.as_view()),
    path('catalogue-assistant/suggest/', CatalogueAssistantView.as_view()),
    path('image-assistant/generate/', ImageAssistantView.as_view()),
    path('', include(router.urls)),
]
