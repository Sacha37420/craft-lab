"""Mondes, personnages et tickets de relais.

Règle de l'app, écrite dans `WorldViewSet` : un monde est PARTAGÉ par tout le
groupe autorisé ; ce qui appartient à un joueur, c'est son personnage dans ce
monde, et le ticket qui l'attache à une connexion du relais.
"""
from __future__ import annotations

import hmac
from datetime import timedelta
from unittest import mock

from django.test import override_settings
from django.utils import timezone

from api.models import Character, RelayTicket, World

from .base import CLE_RELAIS, REGLES, CraftTestCase, make_world, token

VERIFIER = '/api/internal/verify-relay-ticket/'


class MondesTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.bob = token('bob', ['amis'])

    def test_le_createur_vient_du_jeton(self):
        resp = self.call('post', '/api/worlds/', self.alice, {
            'name': 'Monde', 'seed': 7, 'generation_rules': REGLES,
            'created_by_email': 'bob@ssolab.local',
        })
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertEqual(World.objects.get().created_by_email, 'alice@ssolab.local')
        # Et il ne se réattribue pas après coup.
        monde = World.objects.get()
        self.call('patch', f'/api/worlds/{monde.id}/', self.bob,
                  {'created_by_email': 'bob@ssolab.local'})
        self.assertEqual(World.objects.get().created_by_email, 'alice@ssolab.local')

    def test_creation_incomplete_refusee(self):
        for data in ({'name': 'M', 'seed': 1}, {'name': 'M', 'generation_rules': REGLES},
                     {'seed': 1, 'generation_rules': REGLES},
                     {'name': 'M', 'seed': 'graine', 'generation_rules': REGLES}):
            with self.subTest(data=data):
                self.assertEqual(self.call('post', '/api/worlds/', self.alice, data).status_code, 400)
        self.assertEqual(World.objects.count(), 0)

    def test_la_liste_ne_porte_pas_le_terrain(self):
        monde = make_world(block_diff={'1,2': 5})
        ligne = self.get('/api/worlds/', self.alice).json()[0]
        self.assertNotIn('block_diff', ligne)
        self.assertNotIn('generation_rules', ligne)
        detail = self.get(f'/api/worlds/{monde.id}/', self.alice).json()
        self.assertEqual(detail['block_diff'], {'1,2': 5})
        self.assertEqual(detail['generation_rules'], REGLES)

    def test_un_monde_est_partage_par_tout_le_groupe(self):
        """Décision écrite dans WorldViewSet : n'importe quel membre reprend ou
        supprime n'importe quelle partie. Ce test la fixe — la changer est une
        décision, pas un effet de bord."""
        monde = make_world(owner='alice')
        Character.objects.create(world=monde, owner_email='alice@ssolab.local')
        self.assertEqual(self.get(f'/api/worlds/{monde.id}/', self.bob).status_code, 200)
        self.assertEqual(self.call('delete', f'/api/worlds/{monde.id}/', self.bob).status_code, 204)
        self.assertEqual(World.objects.count(), 0)
        self.assertEqual(Character.objects.count(), 0)     # les personnages suivent

    def test_monde_inconnu(self):
        for method, suffix in (('get', ''), ('get', 'character/'), ('post', 'save/'),
                               ('post', 'relay-ticket/')):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.call(method, f'/api/worlds/99999/{suffix}', self.alice).status_code,
                                 404)
        self.assertEqual(Character.objects.count(), 0)
        self.assertEqual(RelayTicket.objects.count(), 0)


class PersonnagesTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.bob = token('bob', ['amis'])
        self.monde = make_world()
        self.url = f'/api/worlds/{self.monde.id}/character/'

    def test_chacun_son_personnage_dans_le_meme_monde(self):
        self.call('put', self.url, self.alice, {'position_x': 120, 'position_y': 30, 'hp': 55,
                                                'inventory': {'3': 12}})
        vu_par_bob = self.get(self.url, self.bob).json()
        self.assertEqual(vu_par_bob['owner_email'], 'bob@ssolab.local')
        self.assertEqual((vu_par_bob['position_x'], vu_par_bob['hp'], vu_par_bob['inventory']),
                         (0, 100, {}))
        vu_par_alice = self.get(self.url, self.alice).json()
        self.assertEqual((vu_par_alice['position_x'], vu_par_alice['hp'], vu_par_alice['inventory']),
                         (120, 55, {'3': 12}))
        self.assertEqual(Character.objects.count(), 2)

    def test_created_distingue_la_premiere_visite(self):
        """Sans cet indicateur, le client prendrait (0,0) pour une vraie
        position sauvegardée."""
        self.assertIs(self.get(self.url, self.alice).json()['created'], True)
        self.assertIs(self.get(self.url, self.alice).json()['created'], False)
        self.assertEqual(Character.objects.count(), 1)

    def test_on_ne_reattribue_pas_un_personnage(self):
        autre = make_world('Autre')
        resp = self.call('put', self.url, self.alice, {
            'hp': 10, 'owner_email': 'bob@ssolab.local', 'world': autre.id,
        })
        self.assertEqual(resp.status_code, 200)
        perso = Character.objects.get()
        self.assertEqual((perso.owner_email, perso.world_id, perso.hp),
                         ('alice@ssolab.local', self.monde.id, 10))

    def test_un_personnage_par_monde(self):
        autre = make_world('Autre')
        self.call('put', self.url, self.alice, {'hp': 10})
        self.assertEqual(self.get(f'/api/worlds/{autre.id}/character/', self.alice).json()['hp'], 100)

    def test_valeurs_invalides_refusees(self):
        self.call('put', self.url, self.alice, {'hp': 80})
        for data in ({'hp': 'beaucoup'}, {'position_x': None}, {'equipped_weapon_id': 'épée'},
                     {'appearance_skin': 'x' * 33}):
            with self.subTest(data=data):
                self.assertEqual(self.call('put', self.url, self.alice, data).status_code, 400)
        self.assertEqual(Character.objects.get().hp, 80)


class SauvegardeTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.bob = token('bob', ['amis'])
        self.monde = make_world(block_diff={'0,0': 1, '5,5': 2})
        self.url = f'/api/worlds/{self.monde.id}/save/'

    def test_le_diff_est_fusionne_pas_remplace(self):
        resp = self.call('post', self.url, self.alice, {'block_diff': {'5,5': None, '9,9': 7}})
        self.assertEqual(resp.json(), {'saved': True})
        self.monde.refresh_from_db()
        self.assertEqual(self.monde.block_diff, {'0,0': 1, '5,5': None, '9,9': 7})

    def test_deux_joueurs_sauvegardent_sans_s_ecraser(self):
        self.call('post', self.url, self.alice,
                  {'block_diff': {'1,1': 3}, 'character': {'hp': 40, 'position_x': 10}})
        self.call('post', self.url, self.bob,
                  {'block_diff': {'2,2': 4}, 'character': {'hp': 90, 'owner_email': 'alice@ssolab.local'}})
        self.monde.refresh_from_db()
        self.assertEqual(self.monde.block_diff, {'0,0': 1, '5,5': 2, '1,1': 3, '2,2': 4})
        persos = dict(Character.objects.values_list('owner_email', 'hp'))
        self.assertEqual(persos, {'alice@ssolab.local': 40, 'bob@ssolab.local': 90})

    def test_sauvegarde_vide_ne_cree_rien(self):
        avant = World.objects.get().updated_at
        self.assertEqual(self.call('post', self.url, self.alice, {}).status_code, 200)
        self.assertEqual(Character.objects.count(), 0)
        self.assertEqual(World.objects.get().updated_at, avant)

    def test_personnage_invalide_refuse(self):
        resp = self.call('post', self.url, self.alice, {'character': {'hp': 'beaucoup'}})
        self.assertEqual(resp.status_code, 400)

    # ── Défauts corrigés (dérogation de l'architecte à I4) ────────────────────
    def test_sauvegarde_refusee_ne_laisse_rien_d_ecrit(self):
        """`save` existe pour éviter une réussite partielle : un personnage
        refusé (400) ne laisse ni terrain modifié ni personnage créé."""
        avant = World.objects.get().updated_at
        resp = self.call('post', self.url, self.alice,
                         {'block_diff': {'9,9': 7}, 'character': {'hp': 'beaucoup'}})
        self.assertEqual(resp.status_code, 400)
        self.monde.refresh_from_db()
        self.assertEqual(self.monde.block_diff, {'0,0': 1, '5,5': 2})
        self.assertEqual(self.monde.updated_at, avant)
        self.assertEqual(Character.objects.count(), 0)
        # Et la sauvegarde valide qui suit passe en entier.
        resp = self.call('post', self.url, self.alice,
                         {'block_diff': {'9,9': 7}, 'character': {'hp': 12}})
        self.assertEqual(resp.status_code, 200)
        self.monde.refresh_from_db()
        self.assertEqual(self.monde.block_diff, {'0,0': 1, '5,5': 2, '9,9': 7})
        self.assertEqual(Character.objects.get().hp, 12)

    def test_diff_mal_forme_refuse_proprement(self):
        """Un `block_diff` qui n'est pas un objet {"x,y": id de block ou null}
        est refusé (400), sans rien écrire — personnage compris."""
        for diff in (['0,0', 1], 'tout', 3, True, {'1,1': 'pierre'}, {'1,1': [3]},
                     {'1,1': {'id': 3}}, {'1,1': True}):
            with self.subTest(diff=diff):
                resp = self.call('post', self.url, self.alice,
                                 {'block_diff': diff, 'character': {'hp': 5}}, tolere_500=True)
                self.assertEqual(resp.status_code, 400)
                self.assertIn('block_diff', resp.json())
        self.monde.refresh_from_db()
        self.assertEqual(self.monde.block_diff, {'0,0': 1, '5,5': 2})
        self.assertEqual(Character.objects.count(), 0)
        # Diff vide ou absent : toujours accepté.
        for diff in ({}, None):
            with self.subTest(diff=diff):
                self.assertEqual(self.call('post', self.url, self.alice, {'block_diff': diff}).status_code, 200)


class TicketsDeRelaisTests(CraftTestCase):
    """`POST /api/internal/verify-relay-ticket/` — sans jeton, protégé par la
    clé partagée avec `relay/` : ce qu'il laisse passer et ce qu'il refuse."""

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.monde = make_world()

    def emettre(self, tok=None, monde=None) -> str:
        resp = self.call('post', f'/api/worlds/{(monde or self.monde).id}/relay-ticket/',
                         tok or self.alice)
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(resp.json()['world_id'], (monde or self.monde).id)
        return resp.json()['ticket']

    def verifier(self, ticket, cle=CLE_RELAIS, **extra):
        if cle is not None:
            extra['HTTP_X_RELAY_KEY'] = cle
        return self.call('post', VERIFIER, None, {'token': ticket}, **extra)

    def test_ticket_valide_rend_le_monde_et_le_joueur(self):
        ticket = self.emettre()
        resp = self.verifier(ticket)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {'world_id': self.monde.id, 'owner_email': 'alice@ssolab.local'})

    def test_le_ticket_porte_l_identite_de_celui_qui_l_a_demande(self):
        autre = make_world('Autre')
        t_alice = self.emettre()
        t_bob = self.emettre(token('bob', ['amis']), autre)
        self.assertEqual(self.verifier(t_bob).json(),
                         {'world_id': autre.id, 'owner_email': 'bob@ssolab.local'})
        self.assertEqual(self.verifier(t_alice).json()['owner_email'], 'alice@ssolab.local')

    def test_tickets_imprevisibles_et_distincts(self):
        tickets = {self.emettre() for _ in range(10)}
        self.assertEqual(len(tickets), 10)
        for ticket in tickets:
            self.assertRegex(ticket, r'^[0-9a-f]{64}$')

    def test_usage_unique(self):
        ticket = self.emettre()
        self.assertEqual(self.verifier(ticket).status_code, 200)
        self.assertEqual(self.verifier(ticket).status_code, 410)
        self.assertIsNotNone(RelayTicket.objects.get().consumed_at)

    def test_expire_apres_trente_secondes(self):
        ticket = self.emettre()
        RelayTicket.objects.update(created_at=timezone.now() - timedelta(seconds=31))
        self.assertEqual(self.verifier(ticket).status_code, 410)
        self.assertIsNone(RelayTicket.objects.get().consumed_at)

        frais = self.emettre()
        RelayTicket.objects.filter(token=frais).update(
            created_at=timezone.now() - timedelta(seconds=20))
        self.assertEqual(self.verifier(frais).status_code, 200)

    def test_sans_la_cle_rien_ne_passe(self):
        ticket = self.emettre()
        essais = {
            'absente': dict(cle=None),
            'vide': dict(cle=''),
            'fausse': dict(cle='mauvaise-cle'),
            'prefixe': dict(cle=CLE_RELAIS[:-1]),
            'suffixe': dict(cle=CLE_RELAIS + 'x'),
            'casse': dict(cle=CLE_RELAIS.upper()),
            'non_ascii': dict(cle='clé-é'),
            'jeton_a_la_place': dict(cle=None, HTTP_AUTHORIZATION=f'Bearer {self.alice}'),
        }
        for nom, kwargs in essais.items():
            with self.subTest(cas=nom):
                resp = self.verifier(ticket, **kwargs)
                self.assertEqual(resp.status_code, 403)
                self.assertNotIn('owner_email', resp.json())
        # Les refus n'ont pas consommé le ticket.
        self.assertIsNone(RelayTicket.objects.get().consumed_at)
        self.assertEqual(self.verifier(ticket).status_code, 200)

    def test_la_cle_est_comparee_en_temps_constant(self):
        ticket = self.emettre()
        with mock.patch('api.views.hmac.compare_digest', wraps=hmac.compare_digest) as compare:
            self.assertEqual(self.verifier(ticket, 'mauvaise-cle').status_code, 403)
            self.assertEqual(self.verifier(ticket).status_code, 200)
        self.assertEqual(compare.call_count, 2)

    def test_cle_non_configuree_ferme_l_endpoint(self):
        """Échec fermé : une clé vide côté serveur ne vaut pas « pas de clé »."""
        ticket = self.emettre()
        with override_settings(RELAY_INTERNAL_KEY=''):
            for cle in (None, '', CLE_RELAIS):
                with self.subTest(cle=cle):
                    self.assertEqual(self.verifier(ticket, cle).status_code, 403)

    def test_ticket_inconnu_ou_vide(self):
        self.emettre()
        for ticket in ('0' * 64, '', None, '  '):
            with self.subTest(ticket=ticket):
                self.assertEqual(self.verifier(ticket).status_code, 404)

    def test_un_monde_supprime_emporte_ses_tickets(self):
        ticket = self.emettre()
        self.monde.delete()
        self.assertEqual(self.verifier(ticket).status_code, 404)
