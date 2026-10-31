"""Chantier « failles » (2026-10-31) : coffre des clés IA, envois bornés, comptes d'exemple.

Tenu ici :
  • F7/I3 — les clés IA sont chiffrées par `VAULT_ENCRYPTION_KEY`, plus par une
    clé dérivée de `SECRET_KEY` ; l'ancien chiffrement et les valeurs en clair
    historiques se relisent puis sont rechiffrés par la migration 0021 ; une
    valeur indéchiffrable se lit comme absente et reste intacte en base ;
  • F9 — une icône ou un sprite fait au plus 10 485 760 octets (413, avant tout
    appel à storage, et avant toute lecture du corps quand `Content-Length` le
    dit déjà) et doit se décoder entièrement par Pillow (400 sinon) ;
  • 0022 retire les comptes d'exemple de 0002, seulement s'ils n'ont rien laissé
    d'autre.
"""
from __future__ import annotations

import base64
import hashlib
import importlib
import struct
import zlib
from types import SimpleNamespace
from unittest import mock

from cryptography.fernet import Fernet, InvalidToken
from django.apps import apps as django_apps
from django.conf import settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import override_settings

from api import fields, limits
from api.models import AIProviderConfig, Department, Item, Monster, SpriteAsset, UserRecord, World

from .base import CLE_COFFRE, CraftTestCase, image, make_monster, make_weapon, token

coffre_0021 = importlib.import_module('api.migrations.0021_rechiffrer_coffre')
comptes_0022 = importlib.import_module('api.migrations.0022_retirer_comptes_exemple')


# ── F7 / I3 — coffre ──────────────────────────────────────────────────────────
def ancienne_cle() -> Fernet:
    """Le chiffrement d'avant le chantier, refait ici à partir du SECRET_KEY des réglages."""
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest()))


def brut(pk: int) -> str:
    with connection.cursor() as cur:
        cur.execute('SELECT api_key FROM ai_provider_configs WHERE id = %s', [pk])
        return cur.fetchone()[0]


def poser_brut(pk: int, valeur: str) -> None:
    with connection.cursor() as cur:
        cur.execute('UPDATE ai_provider_configs SET api_key = %s WHERE id = %s', [valeur, pk])


def migrer_coffre() -> dict:
    return coffre_0021.rechiffrer(django_apps, SimpleNamespace(connection=connection))


class CoffreTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.conf = AIProviderConfig.objects.create(owner_email='alice@ssolab.local', provider='claude')

    def relue(self) -> str:
        return AIProviderConfig.objects.get(pk=self.conf.pk).api_key

    def assertSousLaSeuleNouvelleCle(self, valeur: str) -> None:
        stocke = brut(self.conf.pk)
        self.assertEqual(Fernet(CLE_COFFRE).decrypt(stocke.encode()).decode(), valeur)
        with self.assertRaises(InvalidToken):
            ancienne_cle().decrypt(stocke.encode())

    def test_une_nouvelle_valeur_est_chiffree_par_la_cle_du_coffre(self):
        self.conf.api_key = 'sk-nouvelle'
        self.conf.save()
        self.assertSousLaSeuleNouvelleCle('sk-nouvelle')

    def test_l_ancien_chiffrement_se_relit_puis_est_rechiffre(self):
        poser_brut(self.conf.pk, ancienne_cle().encrypt(b'sk-ancienne').decode())
        self.assertEqual(self.relue(), 'sk-ancienne')
        compte = migrer_coffre()
        self.assertEqual(compte[fields.REWRITTEN], 1)
        self.assertSousLaSeuleNouvelleCle('sk-ancienne')
        self.assertEqual(self.relue(), 'sk-ancienne')

    def test_une_valeur_historique_en_clair_se_relit_puis_est_chiffree(self):
        poser_brut(self.conf.pk, 'sk-en-clair-historique')
        self.assertEqual(self.relue(), 'sk-en-clair-historique')
        migrer_coffre()
        self.assertTrue(brut(self.conf.pk).startswith('gAAAAA'))
        self.assertSousLaSeuleNouvelleCle('sk-en-clair-historique')

    def test_une_valeur_indechiffrable_se_lit_comme_absente_et_reste_intacte(self):
        perdue = Fernet(Fernet.generate_key()).encrypt(b'sk-perdue').decode()
        poser_brut(self.conf.pk, perdue)
        with self.assertLogs('api.fields', 'WARNING') as journal:
            self.assertEqual(self.relue(), '')
        self.assertNotIn(perdue, '\n'.join(journal.output))
        self.assertIn('AIProviderConfig.api_key', '\n'.join(journal.output))

        with self.assertLogs('api.fields', 'WARNING') as journal:
            compte = migrer_coffre()
        self.assertEqual((compte[fields.UNREADABLE], compte[fields.REWRITTEN]), (1, 0))
        self.assertEqual(brut(self.conf.pk), perdue)          # jamais écrasée par ''
        self.assertNotIn(perdue, '\n'.join(journal.output))

        # Et l'API la dit « non configurée » — pas un texte chiffré présenté comme une clé.
        resp = self.get('/api/ai-config/claude/', token('alice'))
        self.assertEqual(resp.json()['has_key'], False)

    def test_une_valeur_deja_sous_la_nouvelle_cle_n_est_pas_reecrite(self):
        self.conf.api_key = 'sk-deja'
        self.conf.save()
        avant = brut(self.conf.pk)
        compte = migrer_coffre()
        self.assertEqual((compte[fields.ALREADY_NEW], compte[fields.REWRITTEN]), (1, 0))
        self.assertEqual(brut(self.conf.pk), avant)

    def test_faire_tourner_secret_key_ne_detruit_plus_les_cles(self):
        self.conf.api_key = 'sk-durable'
        self.conf.save()
        with override_settings(SECRET_KEY='une-toute-autre-cle-django'):
            self.assertEqual(self.relue(), 'sk-durable')

    def test_sans_cle_de_coffre_rien_ne_se_chiffre(self):
        with override_settings(VAULT_ENCRYPTION_KEY=''):
            with self.assertRaises(RuntimeError):
                fields.encrypt('sk')

    def test_aucune_reponse_d_api_ne_porte_la_cle(self):
        tok = token('alice')
        reponses = [
            self.call('put', '/api/ai-config/claude/', tok, {'api_key': 'sk-SECRETE-ALICE', 'model_name': 'm'}),
            self.get('/api/ai-config/claude/', tok),
            self.get('/api/ai-config/mistral/', tok),
        ]
        stocke = brut(self.conf.pk)
        for resp in reponses:
            corps = resp.content.decode()
            self.assertEqual(resp.status_code, 200, corps)
            for interdit in ('sk-SECRETE-ALICE', stocke, CLE_COFFRE, 'api_key'):
                self.assertNotIn(interdit, corps)


# ── F9 — envois d'icônes et de sprites ────────────────────────────────────────
LIMITE = 10 * 1024 * 1024        # 10 485 760 octets, contrat § 7


def png_de_taille(n: int) -> bytes:
    """Un PNG valide de exactement `n` octets : une vraie petite image, plus un
    morceau auxiliaire privé (`prVt`, ignoré par les décodeurs) qui fait le poids."""
    base = image('PNG')
    entete, reste = base[:33], base[33:]           # signature (8) + IHDR (25)
    bourrage = n - len(base) - 12                   # longueur + type + CRC = 12 octets
    assert bourrage >= 0
    donnees = b'\0' * bourrage
    morceau = struct.pack('>I', bourrage) + b'prVt' + donnees + struct.pack('>I', zlib.crc32(b'prVt' + donnees))
    png = entete + morceau + reste
    assert len(png) == n
    return png


class EnvoisTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.tok = token('alice')
        self.storage_ok()
        self.routes = {
            'icone_objet': (f'/api/weapons/{make_weapon().pk}/icon/', {}),
            'icone_monstre': (f'/api/monsters/{make_monster().pk}/icon/', {}),
            'bibliotheque': ('/api/sprite-assets/', {'name': 'Bras', 'category': 'monster-part'}),
        }

    def envoyer(self, route: str, octets: bytes, forme: str = 'multipart', **extra):
        url, champs = self.routes[route]
        if forme == 'multipart':
            fichier = SimpleUploadedFile('icone.png', octets, content_type='image/png')
            return self.call('post', url, self.tok, {**champs, 'file': fichier}, fmt='multipart', **extra)
        return self.call('post', url, self.tok, {**champs, 'image_base64': base64.b64encode(octets).decode()}, **extra)

    def assertRienVersStorage(self) -> None:
        self.storage_post.assert_not_called()
        self.assertEqual(SpriteAsset.objects.count(), 0)
        self.assertEqual(Item.objects.get().icon_path, '')
        self.assertEqual(Monster.objects.get().icon_path, '')

    def test_la_limite_est_de_10_mo(self):
        self.assertEqual(settings.IMAGE_MAX_BYTES, 10485760)
        # Django laisse passer ce que nos contrôles bornent eux-mêmes.
        self.assertEqual(settings.FILE_UPLOAD_MAX_MEMORY_SIZE, 10485760)
        self.assertGreaterEqual(settings.DATA_UPLOAD_MAX_MEMORY_SIZE, limits.base64_length(10485760))
        self.assertEqual(limits.body_max_bytes(), limits.base64_length(10485760) + limits.BODY_OVERHEAD_BYTES)

    def test_exactement_10_mo_accepte(self):
        octets = png_de_taille(LIMITE)
        for route in self.routes:
            for forme in ('multipart', 'base64'):
                with self.subTest(route=route, forme=forme):
                    self.storage_post.reset_mock()
                    resp = self.envoyer(route, octets, forme)
                    self.assertIn(resp.status_code, (200, 201), resp.content[:300])
                    _, envoyes, mime = self.storage_post.call_args.kwargs['files']['file']
                    self.assertEqual((len(envoyes), mime), (LIMITE, 'image/png'))

    def test_un_octet_de_plus_refuse_en_413(self):
        octets = png_de_taille(LIMITE + 1)
        for route in self.routes:
            for forme in ('multipart', 'base64'):
                with self.subTest(route=route, forme=forme):
                    resp = self.envoyer(route, octets, forme)
                    self.assertEqual(resp.status_code, 413, resp.content[:300])
                    self.assertEqual(int(resp.json()['max_bytes']), LIMITE)
        self.assertRienVersStorage()

    def test_content_length_geant_refuse_sans_lire_le_corps(self):
        for route in self.routes:
            with self.subTest(route=route), \
                    mock.patch('rest_framework.parsers.DjangoMultiPartParser') as multipart, \
                    mock.patch('rest_framework.parsers.JSONParser.parse') as json_parse:
                resp = self.envoyer(route, image('PNG'), CONTENT_LENGTH=str(10 ** 12))
                self.assertEqual(resp.status_code, 413, resp.content[:300])
                multipart.assert_not_called()
                json_parse.assert_not_called()
        # Juste au-dessus du plus gros envoi légitime : refusé aussi.
        resp = self.envoyer('icone_objet', image('PNG'), 'base64', CONTENT_LENGTH=str(limits.body_max_bytes() + 1))
        self.assertEqual(resp.status_code, 413)
        self.assertRienVersStorage()

    def test_png_tronque_refuse_en_400(self):
        complet = image('PNG', size=(64, 64))
        for route in self.routes:
            for coupe in (len(complet) // 2, len(complet) - 12):      # au milieu de IDAT ; sans IEND
                with self.subTest(route=route, coupe=coupe):
                    self.assertEqual(self.envoyer(route, complet[:coupe]).status_code, 400)
        self.assertRienVersStorage()

    def test_texte_renomme_en_png_refuse_en_400(self):
        for route in self.routes:
            for forme in ('multipart', 'base64'):
                with self.subTest(route=route, forme=forme):
                    resp = self.envoyer(route, b'ceci est un fichier texte\n' * 50, forme)
                    self.assertEqual(resp.status_code, 400, resp.content[:300])
        self.assertRienVersStorage()

    def test_bombe_de_decompression_refusee_en_400(self):
        # Peu d'octets, beaucoup de pixels : au-delà du plafond de Pillow (gardé tel quel).
        with mock.patch('PIL.Image.MAX_IMAGE_PIXELS', 100):
            resp = self.envoyer('icone_objet', image('PNG', size=(20, 20)))
        self.assertEqual(resp.status_code, 400, resp.content[:300])
        self.assertRienVersStorage()


# ── 0022 — comptes d'exemple ──────────────────────────────────────────────────
class ComptesExempleTests(CraftTestCase):
    """La base de test a déjà joué 0002 puis 0022 : on resème l'exemple à la main."""

    def setUp(self) -> None:
        super().setUp()
        UserRecord.objects.filter(email__in=comptes_0022.EXAMPLE_EMAILS).delete()
        Department.objects.filter(name__in=list(comptes_0022.EXAMPLE_DEPARTMENTS)).delete()
        depts = [Department.objects.create(name=n, description=d)
                 for n, d in comptes_0022.EXAMPLE_DEPARTMENTS.items()]
        for email, dept in zip(comptes_0022.EXAMPLE_EMAILS, depts):
            UserRecord.objects.create(email=email, display_name=email.split('@')[0], department=dept)
        UserRecord.objects.create(email='sacha@ssolab.local', display_name='sacha')

    def migrer(self) -> dict:
        return comptes_0022.retirer(django_apps, None)

    def test_l_exemple_seul_est_retire(self):
        compte = self.migrer()
        self.assertEqual((compte['deleted_users'], compte['deleted_departments']), (3, 3))
        self.assertEqual(list(UserRecord.objects.values_list('email', flat=True)), ['sacha@ssolab.local'])
        self.assertEqual(Department.objects.count(), 0)

    def test_rien_n_est_retire_si_un_compte_d_exemple_a_cree_quelque_chose(self):
        traces = {
            'cle_ia': lambda: AIProviderConfig.objects.create(owner_email='bob@example.com', provider='claude'),
            'partie': lambda: World.objects.create(name='p', seed=1, generation_rules={},
                                                   created_by_email='charlie@example.com'),
            'objet': lambda: Item.objects.create(name='x', category=Item.Category.BLOCK,
                                                 created_by_email='alice@example.com'),
        }
        for nom, creer in traces.items():
            with self.subTest(trace=nom):
                obj = creer()
                with self.assertLogs('api.migrations.0022_retirer_comptes_exemple', 'WARNING'):
                    compte = self.migrer()
                self.assertEqual(compte['deleted_users'], 0)
                self.assertEqual(UserRecord.objects.count(), 4)
                self.assertEqual(Department.objects.count(), 3)
                obj.delete()

    def test_un_departement_qui_a_d_autres_membres_est_garde(self):
        UserRecord.objects.filter(email='sacha@ssolab.local').update(
            department=Department.objects.get(name='Qualité'))
        compte = self.migrer()
        self.assertEqual((compte['deleted_users'], compte['deleted_departments']), (3, 2))
        self.assertEqual(list(Department.objects.values_list('name', flat=True)), ['Qualité'])
