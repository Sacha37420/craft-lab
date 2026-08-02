from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AIProviderConfigView,
    ArtifactViewSet,
    BlockViewSet,
    CatalogueAssistantView,
    DepartmentListView,
    ItemViewSet,
    MeView,
    ProjectileViewSet,
    StatusEffectViewSet,
    ToolViewSet,
    UserListView,
    WeaponViewSet,
)

router = DefaultRouter()
router.register('items', ItemViewSet, basename='item')
router.register('status-effects', StatusEffectViewSet, basename='status-effect')
router.register('weapons', WeaponViewSet, basename='weapon')
router.register('projectiles', ProjectileViewSet, basename='projectile')
router.register('artifacts', ArtifactViewSet, basename='artifact')
router.register('tools', ToolViewSet, basename='tool')
router.register('blocks', BlockViewSet, basename='block')

urlpatterns = [
    path('me/',          MeView.as_view()),
    path('departments/', DepartmentListView.as_view()),
    path('users/',       UserListView.as_view()),
    path('ai-config/<str:provider>/', AIProviderConfigView.as_view()),
    path('catalogue-assistant/suggest/', CatalogueAssistantView.as_view()),
    path('', include(router.urls)),
]
