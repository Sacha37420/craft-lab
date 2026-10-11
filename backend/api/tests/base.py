"""Socle commun des tests de craft-lab (même patron qu'oauth-hub).

RÉEL : la classe d'authentification (signature RS256, expiration, `azp`,
groupes, email), les vues, les sérialiseurs, le champ chiffré, PostgreSQL.

SIMULÉ, et seulement cela :
  • le téléchargement du JWKS de Keycloak (clé RSA locale) ;
  • l'appel HTTP à `storage` (`requests.post` d'`api.storage_client`) ;
  • les SDK des fournisseurs IA (les fonctions d'appel d'`ai_client` et
    d'`image_client`), et l'attente entre deux tentatives.
Par défaut ces trois sorties lèvent : un test qui partirait sur le réseau sans
l'avoir prévu échoue bruyamment au lieu d'attendre.
"""
from __future__ import annotations

import json
import time
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.db import connection as db
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from api import ai_client, image_client
from api.authentication import KeycloakJWTAuthentication
from api.models import Block, GameMap, Item, Monster, Weapon, World

APP = 'craft-lab'
CLE_RELAIS = 'cle-relais-de-test-0123456789abcdef'
STORAGE = 'http://storage.test:8000'
MEMBRE = ['famille']
REGLES = {'tiers': [{'depthIndex': 0, 'voidRate': 0.1}], 'monsterSpawns': []}

_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)
AUTRE_RSA = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _LocalJwks:
    """Remplace le TÉLÉCHARGEMENT du JWKS ; la vérification reste réelle."""

    class _Key:
        key = _RSA.public_key()

    def get_signing_key_from_jwt(self, token):
        return self._Key()


_ABSENT = object()


def token(uid: str = 'alice', groups=MEMBRE, azp=APP, *, email=_ABSENT,
          exp_in: int = 300, key=_RSA, algorithm: str = 'RS256') -> str:
    """Un jeton tel que Keycloak l'émettrait, signé par la clé locale."""
    claims = {
        'preferred_username': uid,
        'exp': int(time.time()) + exp_in,
        'iat': int(time.time()) - 5,
    }
    if groups is not None:
        claims['groups'] = groups
    if azp is not None:
        claims['azp'] = azp
    if email is _ABSENT:
        email = f'{uid}@ssolab.local'
    if email is not None:
        claims['email'] = email
    return jwt.encode(claims, key, algorithm=algorithm)


def reponse(status: int = 201, payload=None, text: str = ''):
    r = mock.Mock()
    r.status_code = status
    r.text = text
    r.json.return_value = payload if payload is not None else {}
    return r


def colonnes_brutes(table: str) -> str:
    """Le contenu de la table tel qu'un dump SQL le montrerait."""
    with db.cursor() as cursor:
        cursor.execute(f'SELECT * FROM {table}')
        return json.dumps(cursor.fetchall(), default=str)


# ── Fabriques ─────────────────────────────────────────────────────────────────
def make_weapon(name: str = 'Épée', **extra) -> Weapon:
    item = Item.objects.create(name=name, category=Item.Category.WEAPON)
    return Weapon.objects.create(item=item, style='melee', damage=5, **extra)


def make_block(name: str = 'Pierre', **extra) -> Block:
    item = Item.objects.create(name=name, category=Item.Category.BLOCK)
    return Block.objects.create(item=item, hardness=2, **extra)


def make_monster(name: str = 'Gobelin', **extra) -> Monster:
    return Monster.objects.create(name=name, attack_type='melee', **extra)


def make_map(name: str = 'Surface') -> GameMap:
    return GameMap.objects.create(name=name)


def make_world(name: str = 'Partie', owner: str = 'alice', **extra) -> World:
    return World.objects.create(
        name=name, seed=42, generation_rules=REGLES,
        created_by_email=f'{owner}@ssolab.local', **extra,
    )


@override_settings(
    KEYCLOAK_CLIENT_ID=APP,
    KEYCLOAK_REQUIRED_GROUPS='famille,amis,developers',
    RELAY_INTERNAL_KEY=CLE_RELAIS,
    STORAGE_INTERNAL_URL=STORAGE,
    STORAGE_NAMESPACE='craft-lab',
    SECRET_KEY='cle-django-de-test-sans-rapport-avec-le-service',
)
class CraftTestCase(TestCase):

    def setUp(self) -> None:
        super().setUp()
        self._patch_object(KeycloakJWTAuthentication, '_get_jwks_client',
                           classmethod(lambda cls: _LocalJwks()))

        # Réseau fermé par défaut.
        self.storage_post = self._patch(
            'api.storage_client.requests.post',
            side_effect=AssertionError('appel à storage non simulé'),
        )

        def sdk_non_simule(*args, **kwargs):
            raise AssertionError('appel à un fournisseur IA non simulé')

        for table in (ai_client._CALLERS, image_client._CALLERS):
            patcher = mock.patch.dict(table, {name: sdk_non_simule for name in table})
            patcher.start()
            self.addCleanup(patcher.stop)
        self.attente = self._patch('time.sleep')

    def _patch(self, target: str, **kwargs):
        patcher = mock.patch(target, **kwargs)
        started = patcher.start()
        self.addCleanup(patcher.stop)
        return started

    def _patch_object(self, obj, name, value):
        patcher = mock.patch.object(obj, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    # ── Appels ────────────────────────────────────────────────────────────────
    def call(self, method: str, path: str, tok: str | None = None, data=None,
             fmt: str = 'json', tolere_500: bool = False, **extra):
        client = APIClient(raise_request_exception=not tolere_500)
        if tok is not None:
            extra['HTTP_AUTHORIZATION'] = f'Bearer {tok}'
        if method == 'get':
            return client.get(path, data or {}, **extra)
        return getattr(client, method)(path, data or {}, format=fmt, **extra)

    def get(self, path: str, tok: str | None = None, data=None):
        return self.call('get', path, tok, data)

    def ia_texte(self, provider: str, appel) -> None:
        """Remplace l'appel au SDK texte de ce fournisseur (rétabli en fin de test)."""
        ai_client._CALLERS[provider] = appel

    def ia_image(self, provider: str, appel) -> None:
        image_client._CALLERS[provider] = appel

    def storage_ok(self) -> None:
        self.storage_post.side_effect = None
        self.storage_post.return_value = reponse(201, {'id': 1})

    def assertRefuse(self, resp, fragment: str | None = None) -> None:
        self.assertIn(resp.status_code, (401, 403), getattr(resp, 'data', resp))
        if fragment is not None:
            self.assertIn(fragment, str(resp.json().get('detail', '')))
