"""Serrure de l'API (Verrou 2) — vrais jetons signés, classe d'authentification réelle."""
from __future__ import annotations

from django.urls import URLPattern, URLResolver
from rest_framework.permissions import AllowAny

from api import urls as api_urls
from api.views import VerifyRelayTicketView

from .base import AUTRE_RSA, CLE_RELAIS, CraftTestCase, make_weapon, make_world, token

LECTURES = [
    '/api/me/', '/api/ai-config/claude/',
    '/api/items/', '/api/status-effects/', '/api/weapons/', '/api/projectiles/',
    '/api/artifacts/', '/api/tools/', '/api/blocks/', '/api/monsters/',
    '/api/game-maps/', '/api/depth-tiers/', '/api/portals/', '/api/worlds/',
    '/api/sprite-assets/', '/api/rig-templates/',
]


def vues(patterns=None):
    """Toutes les classes de vue routées, routeur DRF compris."""
    for pattern in patterns if patterns is not None else api_urls.urlpatterns:
        if isinstance(pattern, URLResolver):
            yield from vues(pattern.url_patterns)
        elif isinstance(pattern, URLPattern):
            yield getattr(pattern.callback, 'cls', None) or pattern.callback.view_class


class PorteTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.monde = make_world()
        self.arme = make_weapon()

    def test_sans_jeton_tout_est_refuse(self):
        ecritures = [
            ('post', '/api/worlds/'),
            ('delete', f'/api/worlds/{self.monde.id}/'),
            ('get', f'/api/worlds/{self.monde.id}/character/'),
            ('post', f'/api/worlds/{self.monde.id}/save/'),
            ('post', f'/api/worlds/{self.monde.id}/relay-ticket/'),
            ('post', '/api/weapons/'),
            ('delete', f'/api/weapons/{self.arme.pk}/'),
            ('post', f'/api/weapons/{self.arme.pk}/icon/'),
            ('post', '/api/sprite-assets/'),
            ('put', '/api/ai-config/claude/'),
            ('post', '/api/catalogue-assistant/suggest/'),
            ('post', '/api/image-assistant/generate/'),
        ]
        for method, path in [('get', p) for p in LECTURES] + ecritures:
            with self.subTest(method=method, path=path):
                self.assertRefuse(self.call(method, path))
        self.storage_post.assert_not_called()

    def test_la_verification_de_ticket_est_la_seule_vue_sans_jeton(self):
        """Inventaire tiré d'api/urls.py : toute vue ajoutée en AllowAny ou sans
        authentification fait rougir ce test."""
        ouvertes = {
            cls for cls in vues()
            if AllowAny in cls.permission_classes or list(cls.authentication_classes) == []
        }
        self.assertEqual(ouvertes, {VerifyRelayTicketView})
        self.assertGreater(len(set(vues())), 15)

    def test_un_membre_entre(self):
        for groups in (['famille'], ['amis'], ['developers', 'autre']):
            with self.subTest(groups=groups):
                resp = self.get('/api/me/', token('alice', groups))
                self.assertEqual(resp.status_code, 200)
                self.assertEqual(resp.json()['email'], 'alice@ssolab.local')
        for path in LECTURES:
            with self.subTest(path=path):
                self.assertEqual(self.get(path, token('alice')).status_code, 200)

    def test_jeton_d_un_autre_client_refuse(self):
        """`admin-cli` : client public du realm avec password grant — le
        contournement contre lequel le contrôle `azp` existe."""
        for azp in ('admin-cli', 'storage', 'oauth-hub', 'craft-lab-admin', 'CRAFT-LAB', None):
            with self.subTest(azp=azp):
                self.assertRefuse(self.get('/api/worlds/', token('alice', azp=azp)),
                                  'autre client')

    def test_hors_des_groupes_requis_refuse(self):
        for groups in ([], None, ['admins'], ['Famille']):
            with self.subTest(groups=groups):
                self.assertRefuse(self.get('/api/worlds/', token('lea', groups)),
                                  'Accès réservé aux membres')

    def test_sans_email_refuse(self):
        for email in (None, ''):
            with self.subTest(email=email):
                self.assertRefuse(self.get('/api/worlds/', token('alice', email=email)),
                                  "claim 'email'")

    def test_jeton_expire_refuse(self):
        self.assertRefuse(self.get('/api/worlds/', token('alice', exp_in=-30)), 'Token invalide')

    def test_signature_d_une_autre_cle_refusee(self):
        self.assertRefuse(self.get('/api/worlds/', token('alice', key=AUTRE_RSA)),
                          'Token invalide')

    def test_algorithmes_autres_que_rs256_refuses(self):
        sans_signature = token('alice', key=None, algorithm='none')
        hmac = token('alice', key='secret-devinable-de-trente-deux-octets!', algorithm='HS256')
        for nom, tok in (('none', sans_signature), ('HS256', hmac)):
            with self.subTest(alg=nom):
                self.assertRefuse(self.get('/api/worlds/', tok), 'Token invalide')

    def test_jeton_altere_refuse(self):
        entete, _, signature = token('lea', ['admins']).split('.')
        _, corps_membre, _ = token('lea', ['famille']).split('.')
        self.assertRefuse(self.get('/api/worlds/', f'{entete}.{corps_membre}.{signature}'),
                          'Token invalide')

    def test_ni_jeton_dans_l_url_ni_cle_de_relais_a_la_place_du_jeton(self):
        tok = token('alice')
        self.assertRefuse(self.get('/api/worlds/', None, {'token': tok}))
        resp = self.call('get', '/api/worlds/', None, HTTP_X_RELAY_KEY=CLE_RELAIS)
        self.assertRefuse(resp)


class AnnuaireTests(CraftTestCase):
    """L'annuaire hérité du gabarit (`/api/users/`, `/api/departments/`) n'existe
    plus : retiré de tout le lab le 2026-10-12."""

    def test_l_annuaire_du_gabarit_n_existe_plus(self):
        for uid in ('alice', 'bob'):
            self.assertEqual(self.get('/api/me/', token(uid)).status_code, 200)
        for chemin in ('/api/users/', '/api/departments/'):
            self.assertEqual(self.get(chemin, token('carole')).status_code, 404)
        # Chacun continue de lire sa propre adresse.
        self.assertEqual(self.get('/api/me/', token('alice')).json()['email'], 'alice@ssolab.local')
