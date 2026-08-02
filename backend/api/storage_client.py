"""Client minimal de l'API fichiers de l'app storage.

Un seul partage fixe ouvert en lecture/écriture à tout le groupe Keycloak
requis (Share.required_groups='famille,amis,developers', même groupes que
KEYCLOAK_REQUIRED_GROUPS de cette app — cf. CLAUDE.md racine, patron
carto-lab) : le token de l'utilisateur courant est simplement forwardé vers
storage (azp='craft-lab' doit figurer dans KEYCLOAK_TRUSTED_CLIENTS côté
storage), pas de compte de service ici — aucune tâche asynchrone sans
utilisateur connecté n'écrit dans ce partage à ce stade (génération et
upload d'icône se font tous les deux dans la requête HTTP de l'utilisateur).
"""
from __future__ import annotations

import requests
from django.conf import settings

_TIMEOUT = 30


class StorageClientError(RuntimeError):
    """Erreur de communication avec l'API storage."""


def _namespace_url(suffix: str = '') -> str:
    return f"{settings.STORAGE_INTERNAL_URL}/api/files/{settings.STORAGE_NAMESPACE}/{suffix}"


def upload_bytes(auth_header: str, relative_path: str, data: bytes, content_type: str) -> dict:
    """Dépose `data` dans le partage craft-lab, sous `relative_path`.
    Retourne le JSON de StoredFileSerializer (storage/backend/api/views.py)."""
    filename = relative_path.rsplit('/', 1)[-1]
    files = {'file': (filename, data, content_type or 'application/octet-stream')}
    payload = {'relative_path': relative_path}
    try:
        resp = requests.post(
            _namespace_url(), headers={'Authorization': auth_header},
            data=payload, files=files, timeout=_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise StorageClientError(f'storage injoignable : {exc}') from exc
    if resp.status_code != 201:
        raise StorageClientError(f'Upload storage échoué (HTTP {resp.status_code}) : {resp.text[:200]}')
    return resp.json()
