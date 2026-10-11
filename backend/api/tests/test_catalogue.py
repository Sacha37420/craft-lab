"""Le catalogue : objets (Item + extension), références protégées, sous-listes,
cartes, et application d'un gabarit de monstre.

Le catalogue est commun au groupe : pas de propriétaire par objet. Les règles
qui comptent sont donc d'intégrité — un objet ne change pas de catégorie, ne
laisse pas d'orphelin, ne disparaît pas sous une référence, et une sous-ligne
ne s'atteint que par son parent.
"""
from __future__ import annotations

import unittest

from api.models import (
    ArtifactEffect, Artifact, Block, BlockDrop, DepthTier, DepthTierBlockRate,
    DepthTierMonsterSpawn, Item, Monster, MonsterDrop, MonsterSkill, Projectile,
    RecipeIngredient, RigTemplate, Weapon, WeaponProjectile,
)

from .base import CraftTestCase, make_block, make_map, make_monster, make_weapon, token


class ObjetsTests(CraftTestCase):

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')

    def test_creer_une_arme_cree_l_objet_et_son_extension(self):
        resp = self.call('post', '/api/weapons/', self.alice, {
            'name': 'Arc', 'description': 'En if', 'style': 'ranged', 'damage': 7,
            # Ni la catégorie ni l'auteur ne se choisissent.
            'category': 'block', 'created_by_email': 'bob@ssolab.local', 'icon_path': 'ailleurs.png',
        })
        self.assertEqual(resp.status_code, 201, resp.data)
        item = Item.objects.get()
        self.assertEqual((item.name, item.category, item.created_by_email, item.icon_path),
                         ('Arc', 'weapon', 'alice@ssolab.local', ''))
        self.assertEqual(Weapon.objects.get().item_id, item.id)
        self.assertEqual(resp.json()['id'], item.id)
        self.assertIsNone(resp.json()['icon_url'])

    def test_chaque_route_fixe_sa_categorie(self):
        corps = {
            'weapons': {'style': 'melee'}, 'projectiles': {}, 'artifacts': {},
            'tools': {'tool_type': 'axe'}, 'blocks': {},
        }
        attendu = {'weapons': 'weapon', 'projectiles': 'projectile', 'artifacts': 'artifact',
                   'tools': 'tool', 'blocks': 'block'}
        for route, extra in corps.items():
            with self.subTest(route=route):
                resp = self.call('post', f'/api/{route}/', self.alice, {'name': f'objet-{route}', **extra})
                self.assertEqual(resp.status_code, 201, resp.data)
                self.assertEqual(Item.objects.get(name=f'objet-{route}').category, attendu[route])

    def test_un_nom_est_unique_dans_tout_le_catalogue(self):
        make_block('Obsidienne')
        arme = make_weapon('Épée')
        resp = self.call('post', '/api/weapons/', self.alice, {'name': 'Obsidienne', 'style': 'melee'})
        self.assertEqual(resp.status_code, 400)
        self.assertIn('name', resp.json())
        resp = self.call('patch', f'/api/weapons/{arme.pk}/', self.alice, {'name': 'Obsidienne'})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Item.objects.count(), 2)
        # Réenregistrer un objet sous son propre nom n'est pas un doublon.
        resp = self.call('patch', f'/api/weapons/{arme.pk}/', self.alice, {'name': 'Épée', 'damage': 9})
        self.assertEqual(resp.status_code, 200, resp.data)
        self.assertEqual(Weapon.objects.get().damage, 9)

    def test_valeurs_hors_liste_refusees(self):
        for route, data in (('weapons', {'name': 'A', 'style': 'laser'}),
                            ('weapons', {'name': 'A'}),
                            ('weapons', {'style': 'melee'}),
                            ('tools', {'name': 'A', 'tool_type': 'pelle'}),
                            ('monsters', {'name': 'A', 'attack_type': 'summon'}),
                            ('blocks', {'name': 'A', 'hardness': 'dur'})):
            with self.subTest(route=route, data=data):
                self.assertEqual(self.call('post', f'/api/{route}/', self.alice, data).status_code, 400)
        self.assertEqual(Item.objects.count(), 0)
        self.assertEqual(Monster.objects.count(), 0)

    def test_supprimer_une_arme_supprime_l_objet(self):
        """Sans orphelin `category=weapon` privé de sa ligne d'extension."""
        arme = make_weapon()
        self.assertEqual(self.call('delete', f'/api/weapons/{arme.pk}/', self.alice).status_code, 204)
        self.assertEqual((Item.objects.count(), Weapon.objects.count()), (0, 0))

    def test_un_objet_reference_ne_se_supprime_pas(self):
        pierre, bois = make_block('Pierre'), make_block('Bois')
        arme = make_weapon()
        gobelin = make_monster()
        palier = DepthTier.objects.create(game_map=make_map(), depth_index=0)
        fleche = Projectile.objects.create(
            item=Item.objects.create(name='Flèche', category='projectile'))

        references = {
            'ingredient de recette': (lambda: RecipeIngredient.objects.create(
                item=arme.item, ingredient=pierre.item), f'/api/blocks/{pierre.pk}/'),
            'butin de block': (lambda: BlockDrop.objects.create(
                block=bois, dropped_item=pierre.item), f'/api/blocks/{pierre.pk}/'),
            'butin de monstre': (lambda: MonsterDrop.objects.create(
                monster=gobelin, dropped_item=pierre.item), f'/api/blocks/{pierre.pk}/'),
            'taux de palier': (lambda: DepthTierBlockRate.objects.create(
                depth_tier=palier, block=pierre, rate=0.5), f'/api/blocks/{pierre.pk}/'),
            'munition': (lambda: WeaponProjectile.objects.create(
                weapon=arme, projectile=fleche), f'/api/projectiles/{fleche.pk}/'),
            'apparition': (lambda: DepthTierMonsterSpawn.objects.create(
                depth_tier=palier, monster=gobelin, spawn_chance=0.1), f'/api/monsters/{gobelin.pk}/'),
        }
        for nom, (creer, url) in references.items():
            with self.subTest(reference=nom):
                ligne = creer()
                resp = self.call('delete', url, self.alice)
                self.assertEqual(resp.status_code, 400)
                self.assertIn('référencé', str(resp.json()))
                ligne.delete()
        self.assertEqual(Item.objects.count(), 4)
        self.assertEqual(Monster.objects.count(), 1)
        # Référence retirée : la suppression passe.
        self.assertEqual(self.call('delete', f'/api/blocks/{pierre.pk}/', self.alice).status_code, 204)

    def test_la_liste_transverse_est_en_lecture_seule(self):
        arme = make_weapon()
        make_block()
        self.assertEqual(len(self.get('/api/items/', self.alice).json()), 2)
        filtres = self.get('/api/items/', self.alice, {'category': 'block'}).json()
        self.assertEqual([i['name'] for i in filtres], ['Pierre'])
        for method, path in (('post', '/api/items/'), ('patch', f'/api/items/{arme.pk}/'),
                             ('delete', f'/api/items/{arme.pk}/')):
            with self.subTest(method=method):
                self.assertEqual(self.call(method, path, self.alice, {'name': 'x'}).status_code, 405)
        self.assertEqual(Item.objects.count(), 2)


class SousListesTests(CraftTestCase):
    """Recette, butins, effets, munitions, paliers : une sous-ligne ne s'atteint
    que par son parent."""

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.pierre = make_block('Pierre')
        self.epee = make_weapon('Épée')
        self.hache = make_weapon('Hache')

    def test_la_recette_appartient_a_l_objet_de_la_route(self):
        resp = self.call('post', f'/api/weapons/{self.epee.pk}/recipe/', self.alice,
                         {'ingredient': self.pierre.pk, 'quantity': 3, 'item': self.hache.pk})
        self.assertEqual(resp.status_code, 201, resp.data)
        ligne = RecipeIngredient.objects.get()
        self.assertEqual((ligne.item_id, ligne.ingredient_id, ligne.quantity),
                         (self.epee.pk, self.pierre.pk, 3))
        self.assertEqual(len(self.get(f'/api/weapons/{self.epee.pk}/recipe/', self.alice).json()), 1)
        self.assertEqual(self.get(f'/api/weapons/{self.hache.pk}/recipe/', self.alice).json(), [])

    def test_une_sous_ligne_ne_se_supprime_pas_par_un_autre_parent(self):
        gobelin, loup = make_monster('Gobelin'), make_monster('Loup')
        bois = make_block('Bois')
        carte = make_map()
        p0 = DepthTier.objects.create(game_map=carte, depth_index=0)
        p1 = DepthTier.objects.create(game_map=carte, depth_index=1)
        a1 = Artifact.objects.create(item=Item.objects.create(name='Anneau', category='artifact'))
        a2 = Artifact.objects.create(item=Item.objects.create(name='Cape', category='artifact'))
        fleche = Projectile.objects.create(
            item=Item.objects.create(name='Flèche', category='projectile'))

        lignes = [
            (RecipeIngredient.objects.create(item=self.epee.item, ingredient=self.pierre.item),
             f'/api/weapons/{self.hache.pk}/recipe/', f'/api/weapons/{self.epee.pk}/recipe/'),
            (WeaponProjectile.objects.create(weapon=self.epee, projectile=fleche),
             f'/api/weapons/{self.hache.pk}/projectiles/', f'/api/weapons/{self.epee.pk}/projectiles/'),
            (BlockDrop.objects.create(block=self.pierre, dropped_item=bois.item),
             f'/api/blocks/{bois.pk}/drops/', f'/api/blocks/{self.pierre.pk}/drops/'),
            (ArtifactEffect.objects.create(artifact=a1, effect_type='hp_boost'),
             f'/api/artifacts/{a2.pk}/effects/', f'/api/artifacts/{a1.pk}/effects/'),
            (MonsterSkill.objects.create(monster=gobelin, name='Charge'),
             f'/api/monsters/{loup.pk}/skills/', f'/api/monsters/{gobelin.pk}/skills/'),
            (MonsterDrop.objects.create(monster=gobelin, dropped_item=bois.item),
             f'/api/monsters/{loup.pk}/drops/', f'/api/monsters/{gobelin.pk}/drops/'),
            (DepthTierBlockRate.objects.create(depth_tier=p0, block=self.pierre, rate=0.3),
             f'/api/depth-tiers/{p1.pk}/block-rates/', f'/api/depth-tiers/{p0.pk}/block-rates/'),
            (DepthTierMonsterSpawn.objects.create(depth_tier=p0, monster=gobelin, spawn_chance=0.2),
             f'/api/depth-tiers/{p1.pk}/monster-spawns/', f'/api/depth-tiers/{p0.pk}/monster-spawns/'),
        ]
        for ligne, mauvais_parent, bon_parent in lignes:
            with self.subTest(ligne=type(ligne).__name__):
                resp = self.call('delete', f'{mauvais_parent}{ligne.pk}/', self.alice)
                self.assertEqual(resp.status_code, 404)
                self.assertTrue(type(ligne).objects.filter(pk=ligne.pk).exists())
                resp = self.call('delete', f'{bon_parent}{ligne.pk}/', self.alice)
                self.assertEqual(resp.status_code, 204)
                self.assertFalse(type(ligne).objects.filter(pk=ligne.pk).exists())

    def test_quantites_et_references_invalides(self):
        url = f'/api/weapons/{self.epee.pk}/recipe/'
        for data in ({'ingredient': self.pierre.pk, 'quantity': -1},
                     {'ingredient': self.pierre.pk, 'quantity': 'trois'},
                     {'ingredient': 99999}, {}):
            with self.subTest(data=data):
                self.assertEqual(self.call('post', url, self.alice, data).status_code, 400)
        self.assertEqual(RecipeIngredient.objects.count(), 0)

    def test_un_palier_par_profondeur_et_par_carte(self):
        carte, autre = make_map('Surface'), make_map('Enfer')
        data = {'game_map': carte.pk, 'depth_index': 0, 'void_rate': 0.2}
        self.assertEqual(self.call('post', '/api/depth-tiers/', self.alice, data).status_code, 201)
        self.assertEqual(self.call('post', '/api/depth-tiers/', self.alice, data).status_code, 400)
        self.assertEqual(self.call('post', '/api/depth-tiers/', self.alice,
                                   {**data, 'game_map': autre.pk}).status_code, 201)
        self.assertEqual(self.call('post', '/api/depth-tiers/', self.alice,
                                   {**data, 'depth_index': -1}).status_code, 400)
        vus = self.get('/api/depth-tiers/', self.alice, {'game_map': carte.pk}).json()
        self.assertEqual([p['game_map'] for p in vus], [carte.pk])

    def test_supprimer_une_carte_emporte_ses_paliers_pas_les_blocks(self):
        carte = make_map()
        palier = DepthTier.objects.create(game_map=carte, depth_index=0)
        DepthTierBlockRate.objects.create(depth_tier=palier, block=self.pierre, rate=1)
        self.assertEqual(self.call('delete', f'/api/game-maps/{carte.pk}/', self.alice).status_code, 204)
        self.assertEqual((DepthTier.objects.count(), DepthTierBlockRate.objects.count()), (0, 0))
        self.assertTrue(Block.objects.filter(pk=self.pierre.pk).exists())

    # ── Défaut corrigé (dérogation de l'architecte à I4) ──────────────────────
    def test_doublon_dans_une_sous_liste_refuse_proprement(self):
        """Un ingrédient par recette, un projectile par arme, un block et un
        monstre par palier : le doublon est refusé (400), pas laissé à la base
        (IntegrityError, erreur 500). La requête suivante passe normalement."""
        palier = DepthTier.objects.create(game_map=make_map(), depth_index=0)
        gobelin = make_monster()
        fleche = Projectile.objects.create(
            item=Item.objects.create(name='Flèche', category='projectile'))
        cas = [
            (f'/api/weapons/{self.epee.pk}/recipe/', {'ingredient': self.pierre.pk, 'quantity': 1},
             RecipeIngredient),
            (f'/api/weapons/{self.epee.pk}/projectiles/', {'projectile': fleche.pk}, WeaponProjectile),
            (f'/api/depth-tiers/{palier.pk}/block-rates/', {'block': self.pierre.pk, 'rate': 0.5},
             DepthTierBlockRate),
            (f'/api/depth-tiers/{palier.pk}/monster-spawns/',
             {'monster': gobelin.pk, 'spawn_chance': 0.1}, DepthTierMonsterSpawn),
        ]
        for url, data, modele in cas:
            with self.subTest(url=url):
                self.assertEqual(self.call('post', url, self.alice, data).status_code, 201)
                resp = self.call('post', url, self.alice, data, tolere_500=True)
                self.assertEqual(resp.status_code, 400)
                self.assertIn('déjà', str(resp.json()))
                self.assertEqual(modele.objects.count(), 1)
        # Le même ingrédient reste permis dans la recette d'un AUTRE objet.
        resp = self.call('post', f'/api/weapons/{self.hache.pk}/recipe/', self.alice,
                         {'ingredient': self.pierre.pk})
        self.assertEqual(resp.status_code, 201)


CORPS = {'slot_key': 'corps', 'default_x': 0, 'default_y': 0, 'required': True}
BRAS = {'slot_key': 'bras', 'default_x': 10, 'default_y': -4, 'required': False}
SEGMENT = {'slot_key': 'segment', 'default_x': 12, 'default_y': 3, 'required': True,
           'repeatable': True, 'default_count': 4}


class GabaritsTests(CraftTestCase):
    """`POST /api/monsters/<id>/apply-template/` — matérialise un gabarit en rig."""

    def setUp(self) -> None:
        super().setUp()
        self.alice = token('alice')
        self.monstre = make_monster(hp=33, rig={'parts': [{'id': 'ancien'}], 'skills': []})
        self.url = f'/api/monsters/{self.monstre.pk}/apply-template/'
        self.bipede = RigTemplate.objects.create(
            name='Bipède de test', slots=[CORPS, BRAS],
            default_skills=[{'name': 'Marche', 'type': 'move', 'steps': [
                {'durationMs': 200, 'poses': {'corps': {'dx': 1, 'dy': 0, 'rotationDeg': 0},
                                              'bras': {'dx': 0, 'dy': 2, 'rotationDeg': 15}}},
                {'durationMs': 300, 'poses': {'bras': {'dx': 0, 'dy': -2, 'rotationDeg': -15}}},
            ]}],
        )
        self.ver = RigTemplate.objects.create(
            name='Ver de test', slots=[SEGMENT],
            default_skills=[{'name': 'Onde', 'type': 'move', 'steps': [
                {'durationMs': 100, 'poses': {'segment': [{'dy': 1}, {'dy': -1}]}},
                {'durationMs': 100, 'poses': {'segment': [{'dy': -1}, {'dy': 1}]}},
            ]}],
        )

    def appliquer(self, **data):
        return self.call('post', self.url, self.alice, data, tolere_500=True)

    def test_les_poses_sont_reindexees_par_piece(self):
        resp = self.appliquer(template_id=self.bipede.pk, slot_assets={'corps': 11, 'bras': 22})
        self.assertEqual(resp.status_code, 200, resp.content)
        rig = Monster.objects.get().rig
        self.assertEqual([(p['assetId'], p['x'], p['y']) for p in rig['parts']],
                         [(11, 0, 0), (22, 10, -4)])
        corps_id, bras_id = (p['id'] for p in rig['parts'])
        self.assertNotEqual(corps_id, bras_id)
        etapes = rig['skills'][0]['steps']
        self.assertEqual(etapes[0], {'durationMs': 200, 'poses': {
            corps_id: {'dx': 1, 'dy': 0, 'rotationDeg': 0},
            bras_id: {'dx': 0, 'dy': 2, 'rotationDeg': 15}}})
        self.assertEqual(etapes[1]['poses'], {bras_id: {'dx': 0, 'dy': -2, 'rotationDeg': -15}})
        self.assertEqual((rig['skills'][0]['name'], rig['skills'][0]['type']), ('Marche', 'move'))
        # Aucune clé de slot ne subsiste : le moteur de jeu ne connaît que des pièces.
        self.assertNotIn('corps', str(etapes))
        self.assertEqual(resp.json()['rig'], rig)

    def test_le_rig_est_remplace_et_rien_d_autre(self):
        self.appliquer(template_id=self.bipede.pk, slot_assets={'corps': 11})
        monstre = Monster.objects.get()
        self.assertNotIn('ancien', str(monstre.rig))
        self.assertEqual((monstre.hp, monstre.name), (33, 'Gobelin'))

    def test_slot_facultatif_non_choisi_ignore(self):
        self.appliquer(template_id=self.bipede.pk, slot_assets={'corps': 11})
        rig = Monster.objects.get().rig
        self.assertEqual(len(rig['parts']), 1)
        corps_id = rig['parts'][0]['id']
        self.assertEqual([set(e['poses']) for e in rig['skills'][0]['steps']], [{corps_id}, set()])

    def test_slot_requis_manquant_refuse(self):
        for slot_assets in ({}, {'bras': 22}, None):
            with self.subTest(slot_assets=slot_assets):
                resp = self.appliquer(template_id=self.bipede.pk, slot_assets=slot_assets)
                self.assertEqual(resp.status_code, 400)
                self.assertIn('corps', str(resp.json()))
        self.assertEqual(Monster.objects.get().rig, {'parts': [{'id': 'ancien'}], 'skills': []})

    def test_gabarit_inconnu(self):
        for template_id in (99999, None, 'bipède'):
            with self.subTest(template_id=template_id):
                self.assertEqual(self.appliquer(template_id=template_id, slot_assets={}).status_code, 404)

    def test_slot_repetable_espacement_et_onde(self):
        resp = self.appliquer(template_id=self.ver.pk, slot_assets={'segment': 5}, segment_count=3)
        self.assertEqual(resp.status_code, 200, resp.content)
        rig = Monster.objects.get().rig
        # Segment i à i × l'espacement.
        self.assertEqual([(p['x'], p['y']) for p in rig['parts']], [(0, 0), (12, 3), (24, 6)])
        ids = [p['id'] for p in rig['parts']]
        self.assertEqual(len(set(ids)), 3)
        # Segment i lit l'entrée i % longueur d'onde (2) : déphasage le long de la chaîne.
        etape0, etape1 = (e['poses'] for e in rig['skills'][0]['steps'])
        self.assertEqual([etape0[i]['dy'] for i in ids], [1, -1, 1])
        self.assertEqual([etape1[i]['dy'] for i in ids], [-1, 1, -1])

    def test_slot_repetable_nombre_par_defaut_et_plancher(self):
        self.appliquer(template_id=self.ver.pk, slot_assets={'segment': 5})
        self.assertEqual(len(Monster.objects.get().rig['parts']), 4)
        self.appliquer(template_id=self.ver.pk, slot_assets={'segment': 5}, segment_count=-3)
        self.assertEqual(len(Monster.objects.get().rig['parts']), 1)

    def test_les_gabarits_ne_s_editent_pas_par_l_api(self):
        for method, path in (('post', '/api/rig-templates/'),
                             ('patch', f'/api/rig-templates/{self.bipede.pk}/'),
                             ('delete', f'/api/rig-templates/{self.bipede.pk}/')):
            with self.subTest(method=method):
                self.assertEqual(self.call(method, path, self.alice, {'name': 'x'}).status_code, 405)
        self.assertEqual(RigTemplate.objects.get(pk=self.bipede.pk).name, 'Bipède de test')

    # ── Défaut constaté (I4 : code de production inchangé) ────────────────────
    @unittest.expectedFailure
    def test_nombre_de_segments_non_numerique_refuse_proprement(self):
        """DÉFAUT — `segment_count` passe par `int()` sans garde : une valeur
        non numérique finit en erreur 500. (Et aucune borne haute : un entier
        énorme fait construire autant de pièces en mémoire.)"""
        resp = self.appliquer(template_id=self.ver.pk, slot_assets={'segment': 5},
                              segment_count='beaucoup')
        self.assertEqual(resp.status_code, 400)
