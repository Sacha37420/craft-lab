"""Ce qui sort de l'app : le service `storage` et les fournisseurs IA.

Tenu ici :
  • vers `storage`, c'est le jeton de l'utilisateur courant qui est transmis, tel
    quel, et le chemin du fichier est décidé par le serveur, jamais par le client ;
  • une clé de fournisseur IA appartient à un utilisateur : chiffrée en base,
    jamais relue par l'API, jamais utilisée pour la requête d'un autre.
"""
from __future__ import annotations

import base64
import json
import unittest

import requests
from django.core.files.uploadedfile import SimpleUploadedFile

from api.models import AIProviderConfig, Item, Monster, SpriteAsset

from .base import (
    STORAGE, CraftTestCase, colonnes_brutes, make_block, make_monster, make_weapon,
    reponse, token,
)

PNG = b'\x89PNG\r\n\x1a\n' + b'octets-de-test'
PNG_B64 = base64.b64encode(PNG).decode()


class IconesTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.tok = token('alice')
        self.arme = make_weapon()
        self.url = f'/api/weapons/{self.arme.pk}/icon/'

    def test_l_icone_part_vers_storage_avec_le_jeton_de_l_appelant(self):
        self.storage_ok()
        resp = self.call('post', self.url, self.tok, {'image_base64': PNG_B64, 'mime_type': 'image/png'})
        self.assertEqual(resp.status_code, 200, resp.content)

        self.storage_post.assert_called_once()
        (url,), kwargs = self.storage_post.call_args
        chemin = f'icons/weapon/{self.arme.pk}.png'
        self.assertEqual(url, f'{STORAGE}/api/files/craft-lab/')
        # Le jeton de l'utilisateur, transmis tel quel : pas de compte de service.
        self.assertEqual(kwargs['headers'], {'Authorization': f'Bearer {self.tok}'})
        self.assertEqual(kwargs['data'], {'relative_path': chemin})
        self.assertEqual(kwargs['files']['file'], (f'{self.arme.pk}.png', PNG, 'image/png'))
        self.assertTrue(kwargs['timeout'])

        self.assertEqual(Item.objects.get().icon_path, chemin)
        self.assertEqual(resp.json()['icon_url'], f'/api/files/craft-lab/content/{chemin}')

    def test_le_chemin_ne_vient_jamais_du_client(self):
        self.storage_ok()
        self.call('post', self.url, self.tok, {
            'image_base64': PNG_B64, 'relative_path': '../../autre-partage/x.png',
            'icon_path': '/etc/passwd', 'path': 'x',
        })
        self.assertEqual(self.storage_post.call_args.kwargs['data'],
                         {'relative_path': f'icons/weapon/{self.arme.pk}.png'})
        self.assertEqual(Item.objects.get().icon_path, f'icons/weapon/{self.arme.pk}.png')

    def test_une_regeneration_ecrase_le_meme_fichier(self):
        self.storage_ok()
        for _ in range(2):
            self.call('post', self.url, self.tok, {'image_base64': PNG_B64})
        chemins = {c.kwargs['data']['relative_path'] for c in self.storage_post.call_args_list}
        self.assertEqual(chemins, {f'icons/weapon/{self.arme.pk}.png'})

    def test_fichier_envoye_directement(self):
        self.storage_ok()
        fichier = SimpleUploadedFile('dessin.webp', PNG, content_type='image/webp')
        resp = self.call('post', self.url, self.tok, {'file': fichier}, fmt='multipart')
        self.assertEqual(resp.status_code, 200, resp.content)
        nom, octets, mime = self.storage_post.call_args.kwargs['files']['file']
        self.assertEqual((octets, mime), (PNG, 'image/webp'))

    def test_image_absente_ou_illisible_refusee_sans_appeler_storage(self):
        for data in ({}, {'image_base64': ''}, {'image_base64': 'pas du base64 !!'},
                     {'image_base64': PNG_B64[:-3] + '$$$'}):
            with self.subTest(data=data):
                self.assertEqual(self.call('post', self.url, self.tok, data).status_code, 400)
        self.storage_post.assert_not_called()
        self.assertEqual(Item.objects.get().icon_path, '')

    def test_refus_ou_panne_de_storage_ne_change_rien(self):
        cas = {
            'refus': dict(return_value=reponse(403, text='interdit')),
            'erreur': dict(return_value=reponse(500, text='panne')),
            'reponse_200_au_lieu_de_201': dict(return_value=reponse(200)),
            'injoignable': dict(side_effect=requests.ConnectionError('coupé')),
            'delai': dict(side_effect=requests.Timeout('trop long')),
        }
        for nom, comportement in cas.items():
            with self.subTest(cas=nom):
                self.storage_post.reset_mock(return_value=True, side_effect=True)
                self.storage_post.configure_mock(**comportement)
                resp = self.call('post', self.url, self.tok, {'image_base64': PNG_B64})
                self.assertEqual(resp.status_code, 502)
                self.assertNotIn(self.tok, resp.content.decode())
                self.assertEqual(Item.objects.get().icon_path, '')

    def test_icone_de_monstre_et_sa_fiche_dans_la_bibliotheque(self):
        """Une seule fiche par monstre, mise à jour à chaque régénération."""
        self.storage_ok()
        monstre = make_monster()
        url = f'/api/monsters/{monstre.pk}/icon/'
        self.call('post', url, self.tok, {'image_base64': PNG_B64})
        chemin = f'icons/monster/{monstre.pk}.png'
        self.assertEqual(Monster.objects.get().icon_path, chemin)
        fiche = SpriteAsset.objects.get()
        self.assertEqual((fiche.file_path, fiche.category, fiche.source, fiche.created_by_email),
                         (chemin, 'monster-creature', 'ai-generated', 'alice@ssolab.local'))

        fichier = SimpleUploadedFile('m.png', PNG, content_type='image/png')
        self.call('post', url, token('bob', ['amis']), {'file': fichier}, fmt='multipart')
        fiche = SpriteAsset.objects.get()                 # toujours une seule
        self.assertEqual((fiche.source, fiche.created_by_email), ('upload', 'bob@ssolab.local'))

    def test_panne_de_storage_sur_un_monstre_ne_cree_pas_de_fiche(self):
        self.storage_post.side_effect = requests.ConnectionError('coupé')
        monstre = make_monster()
        resp = self.call('post', f'/api/monsters/{monstre.pk}/icon/', self.tok, {'image_base64': PNG_B64})
        self.assertEqual(resp.status_code, 502)
        self.assertEqual(SpriteAsset.objects.count(), 0)
        self.assertEqual(Monster.objects.get().icon_path, '')


class BibliothequeTests(CraftTestCase):
    """`/api/sprite-assets/` — ce que le client choisit, et ce qu'il ne choisit pas."""

    def setUp(self) -> None:
        super().setUp()
        self.tok = token('alice')

    def creer(self, **data):
        return self.call('post', '/api/sprite-assets/', self.tok,
                         {'name': 'Bras', 'category': 'monster-part', 'image_base64': PNG_B64, **data})

    def test_source_et_chemin_sont_decides_par_le_serveur(self):
        self.storage_ok()
        resp = self.creer(source='cc0-bundled', file_path='../../ailleurs.png',
                          created_by_email='bob@ssolab.local', slot_hint='arm', tags='rouge, gros ,')
        self.assertEqual(resp.status_code, 201, resp.content)
        fiche = SpriteAsset.objects.get()
        self.assertEqual((fiche.source, fiche.created_by_email, fiche.slot_hint, fiche.tags),
                         ('ai-generated', 'alice@ssolab.local', 'arm', ['rouge', 'gros']))
        self.assertRegex(fiche.file_path, r'^sprite-assets/monster-part/[0-9a-f]{32}\.png$')
        (url,), kwargs = self.storage_post.call_args
        self.assertEqual(url, f'{STORAGE}/api/files/craft-lab/')
        self.assertEqual(kwargs['data'], {'relative_path': fiche.file_path})
        self.assertEqual(kwargs['headers'], {'Authorization': f'Bearer {self.tok}'})
        self.assertEqual(resp.json()['asset_url'], f'/api/files/craft-lab/content/{fiche.file_path}')

    def test_un_fichier_envoye_est_marque_upload(self):
        self.storage_ok()
        fichier = SimpleUploadedFile('bras.png', PNG, content_type='image/png')
        resp = self.call('post', '/api/sprite-assets/', self.tok,
                         {'name': 'Bras', 'category': 'monster-part', 'file': fichier,
                          'source': 'cc0-bundled'}, fmt='multipart')
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(SpriteAsset.objects.get().source, 'upload')

    def test_deux_depots_deux_chemins(self):
        self.storage_ok()
        self.creer()
        self.creer()
        self.assertEqual(len(set(SpriteAsset.objects.values_list('file_path', flat=True))), 2)

    def test_saisies_refusees_avant_tout_envoi(self):
        for data in ({'category': 'inconnue'}, {'category': '../../x'}, {'category': None},
                     {'name': ''}, {'name': '   '}, {'image_base64': ''},
                     {'image_base64': 'pas du base64 !!'}):
            with self.subTest(data=data):
                self.assertEqual(self.creer(**data).status_code, 400)
        self.storage_post.assert_not_called()
        self.assertEqual(SpriteAsset.objects.count(), 0)

    def test_panne_de_storage_ne_cree_pas_de_fiche(self):
        self.storage_post.side_effect = None
        self.storage_post.return_value = reponse(403, text='interdit')
        self.assertEqual(self.creer().status_code, 502)
        self.assertEqual(SpriteAsset.objects.count(), 0)

    def test_source_et_chemin_ne_se_modifient_pas(self):
        fiche = SpriteAsset.objects.create(name='Bras', category='monster-part', source='upload',
                                           file_path='sprite-assets/monster-part/abc.png',
                                           created_by_email='alice@ssolab.local')
        resp = self.call('patch', f'/api/sprite-assets/{fiche.pk}/', token('bob', ['amis']), {
            'name': 'Bras gauche', 'source': 'cc0-bundled', 'file_path': 'icons/weapon/1.png',
            'created_by_email': 'bob@ssolab.local',
        })
        self.assertEqual(resp.status_code, 200, resp.content)
        fiche.refresh_from_db()
        self.assertEqual((fiche.name, fiche.source, fiche.file_path, fiche.created_by_email),
                         ('Bras gauche', 'upload', 'sprite-assets/monster-part/abc.png',
                          'alice@ssolab.local'))

    def test_adresse_d_une_image_embarquee_ou_stockee(self):
        SpriteAsset.objects.create(name='A', category='block', source='cc0-bundled', file_path='b/a.png')
        SpriteAsset.objects.create(name='B', category='block', source='upload', file_path='b/b.png',
                                   tags=['rouge'], slot_hint='body')
        SpriteAsset.objects.create(name='Casque', category='other', source='upload', file_path='c.png')
        adresses = {a['name']: a['asset_url'] for a in self.get('/api/sprite-assets/', self.tok).json()}
        self.assertEqual(adresses['A'], 'assets/sprite-library/b/a.png')       # statique, sans storage
        self.assertEqual(adresses['B'], '/api/files/craft-lab/content/b/b.png')

        def noms(**filtre):
            return sorted(a['name'] for a in self.get('/api/sprite-assets/', self.tok, filtre).json())
        self.assertEqual(noms(category='block'), ['A', 'B'])
        self.assertEqual(noms(tag='rouge'), ['B'])
        self.assertEqual(noms(slot_hint='body'), ['B'])
        self.assertEqual(noms(search='cas'), ['Casque'])


def cle(uid: str, provider: str, valeur: str, model: str = '') -> AIProviderConfig:
    return AIProviderConfig.objects.create(
        owner_email=f'{uid}@ssolab.local', provider=provider, api_key=valeur, model_name=model)


class ClesIATests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.bob = token('bob', ['amis'])

    def test_la_cle_s_ecrit_mais_ne_se_relit_pas(self):
        resp = self.call('put', '/api/ai-config/claude/', self.alice,
                         {'api_key': 'sk-CLE-EN-CLAIR-ALICE', 'model_name': 'modele-x'})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['has_key'], True)
        self.assertNotIn('api_key', resp.json())
        relu = self.get('/api/ai-config/claude/', self.alice)
        self.assertNotIn('EN-CLAIR', relu.content.decode())
        self.assertEqual((relu.json()['has_key'], relu.json()['model_name']), (True, 'modele-x'))

    def test_la_cle_est_chiffree_en_base(self):
        self.call('put', '/api/ai-config/claude/', self.alice, {'api_key': 'sk-CLE-EN-CLAIR-ALICE'})
        self.assertNotIn('EN-CLAIR', colonnes_brutes('ai_provider_configs'))
        self.assertEqual(AIProviderConfig.objects.get().api_key, 'sk-CLE-EN-CLAIR-ALICE')

    def test_chacun_sa_cle(self):
        self.call('put', '/api/ai-config/claude/', self.alice, {'api_key': 'sk-alice'})
        vu_par_bob = self.get('/api/ai-config/claude/', self.bob).json()
        self.assertEqual(vu_par_bob['has_key'], False)
        self.call('put', '/api/ai-config/claude/', self.bob,
                  {'api_key': 'sk-bob', 'owner_email': 'alice@ssolab.local', 'provider': 'mistral'})
        cles = {(c.owner_email, c.provider): c.api_key for c in AIProviderConfig.objects.all()}
        self.assertEqual(cles, {('alice@ssolab.local', 'claude'): 'sk-alice',
                                ('bob@ssolab.local', 'claude'): 'sk-bob'})

    def test_modifier_le_modele_ne_touche_pas_a_la_cle(self):
        self.call('put', '/api/ai-config/claude/', self.alice, {'api_key': 'sk-alice'})
        self.call('put', '/api/ai-config/claude/', self.alice, {'model_name': 'autre'})
        self.assertEqual(AIProviderConfig.objects.get().api_key, 'sk-alice')

    def test_fournisseur_inconnu(self):
        for method in ('get', 'put'):
            with self.subTest(method=method):
                self.assertEqual(self.call(method, '/api/ai-config/skynet/', self.alice).status_code, 404)
        self.assertEqual(AIProviderConfig.objects.count(), 0)


class AssistantsTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.bob = token('bob', ['amis'])
        self.appels = []

    def faux_texte(self, reponse_ia):
        def appel(api_key, model, system, message, schema, history):
            self.appels.append({'api_key': api_key, 'model': model, 'system': system,
                                'message': message, 'schema': schema})
            if isinstance(reponse_ia, list):
                suivant = reponse_ia.pop(0)
                if isinstance(suivant, Exception):
                    raise suivant
                return suivant
            return reponse_ia
        return appel

    def suggerer(self, tok=None, **data):
        corps = {'category': 'weapon', 'provider': 'claude', 'partial': {'name': 'Arc'}, **data}
        return self.call('post', '/api/catalogue-assistant/suggest/', tok or self.alice, corps,
                         tolere_500=True)

    # ── Assistant texte ───────────────────────────────────────────────────────
    def test_la_suggestion_utilise_la_cle_de_l_appelant_et_ne_persiste_rien(self):
        cle('alice', 'claude', 'sk-alice', 'modele-alice')
        cle('bob', 'claude', 'sk-bob')
        make_weapon('Épée du catalogue')
        proposition = {'name': 'Arc long', 'description': 'd', 'rationale': 'r',
                       'style': 'ranged', 'damage': 6}
        self.ia_texte('claude', self.faux_texte(json.dumps(proposition)))
        resp = self.suggerer()
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json(), proposition)
        appel, = self.appels
        self.assertEqual((appel['api_key'], appel['model']), ('sk-alice', 'modele-alice'))
        # Le catalogue existant sert de contexte ; la saisie en cours part dans le message.
        self.assertIn('Épée du catalogue', appel['system'])
        self.assertIn('Arc', appel['message'])
        self.assertEqual(set(appel['schema']['required']),
                         {'name', 'description', 'rationale', 'style', 'damage'})
        # Rien n'est écrit : c'est l'utilisateur qui enregistre.
        self.assertEqual(list(Item.objects.values_list('name', flat=True)), ['Épée du catalogue'])

    def test_sans_cle_personnelle_pas_d_appel(self):
        """La clé d'alice ne sert jamais la requête de bob."""
        cle('alice', 'claude', 'sk-alice')
        cle('bob', 'claude', '')
        self.ia_texte('claude', self.faux_texte('{}'))
        resp = self.suggerer(self.bob)
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(self.appels, [])

    def test_categorie_ou_fournisseur_inconnu(self):
        cle('alice', 'claude', 'sk-alice')
        for data in ({'category': 'vaisseau'}, {'category': None}, {'provider': 'skynet'},
                     {'provider': None}):
            with self.subTest(data=data):
                self.assertEqual(self.suggerer(**data).status_code, 404)

    def test_echec_du_fournisseur_rendu_en_502(self):
        cle('alice', 'claude', 'sk-alice')
        for nom, reponse_ia in (('json_invalide', ['pas du json']),
                                ('cle_refusee', [RuntimeError('401 invalid x-api-key')])):
            with self.subTest(cas=nom):
                self.ia_texte('claude', self.faux_texte(reponse_ia))
                resp = self.suggerer()
                self.assertEqual(resp.status_code, 502)
                self.assertNotIn('sk-alice', resp.content.decode())
        self.attente.assert_not_called()          # une clé refusée ne se retente pas

    def test_erreur_passagere_retentee_puis_abandonnee(self):
        cle('alice', 'claude', 'sk-alice')
        self.ia_texte('claude', self.faux_texte([RuntimeError('429 rate limit'), '{"name": "ok"}']))
        self.assertEqual(self.suggerer().json(), {'name': 'ok'})
        self.assertEqual(self.attente.call_count, 1)

        self.attente.reset_mock()
        self.appels.clear()
        self.ia_texte('claude', self.faux_texte([RuntimeError('503')] * 5))
        self.assertEqual(self.suggerer().status_code, 502)
        self.assertEqual(len(self.appels), 3)     # un essai et deux reprises, pas davantage

    @unittest.expectedFailure
    def test_fournisseur_d_images_demande_en_texte(self):
        """DÉFAUT — `gemini` et `openai` sont des fournisseurs valides (images)
        mais n'ont pas d'appel texte : avec une clé enregistrée, l'assistant de
        catalogue finit en KeyError, HTTP 500, au lieu d'un refus lisible."""
        cle('alice', 'gemini', 'cle-gemini')
        resp = self.suggerer(provider='gemini')
        self.assertLess(resp.status_code, 500)

    # ── Assistant image ───────────────────────────────────────────────────────
    def generer(self, tok=None, **data):
        corps = {'prompt': 'un bloc de pierre', 'provider': 'gemini', **data}
        return self.call('post', '/api/image-assistant/generate/', tok or self.alice, corps)

    def test_l_image_est_rendue_sans_etre_enregistree(self):
        cle('alice', 'gemini', 'cle-gemini-alice')
        vus = []

        def faux(api_key, model, prompt):
            vus.append((api_key, prompt))
            return PNG, 'image/png'
        self.ia_image('gemini', faux)
        resp = self.generer()
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json(), {'image_base64': PNG_B64, 'mime_type': 'image/png'})
        self.assertEqual(vus, [('cle-gemini-alice', 'un bloc de pierre')])
        # Ni dépôt dans storage, ni fiche : rien avant « Utiliser cette image ».
        self.storage_post.assert_not_called()
        self.assertEqual(SpriteAsset.objects.count(), 0)

    def test_generation_refusee(self):
        cle('alice', 'gemini', 'cle-gemini-alice')
        self.assertEqual(self.generer(prompt='   ').status_code, 400)
        self.assertEqual(self.generer(provider='claude').status_code, 404)      # pas un fournisseur d'images
        self.assertEqual(self.generer(self.bob).status_code, 409)               # bob n'a pas de clé
        self.assertEqual(self.generer(provider='openai').status_code, 409)
