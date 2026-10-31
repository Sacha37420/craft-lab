# craft-lab — to_do.md (Phase 2 : bibliothèque d'assets, gabarits de monstre, se rapprocher d'un vrai jeu)

Suite du projet craft-lab. Lots 0-9 entièrement livrés le 2026-08-02 (cahier des charges
d'origine supprimé à cette occasion, cf. mémoire `project_craft_lab.md`). Le même jour, une
session de travail a ensuite ajouté, hors numérotation de lot : bibliothèque de sprites CC0
(Kenney.nl, OpenGameArt), galerie de sélection dans le panneau icône, compositeur de monstre par
pièces (glisser-déposer), système de compétences/chorégraphies unifiant mouvements simples et
attaques (idle/déplacement latéral/saut/attaque/impact-bloc, étapes interpolées, images
temporaires), collisions par pièce (terrain/joueur, portée locale ou globale), sélecteur de skin
joueur (5 skins Kenney, animation par changement de frame). Tout ceci est la fondation sur
laquelle les lots ci-dessous s'appuient — à lire dans le code plutôt que redécrit ici
(`frontend/src/app/shared/monster-builder/`, `frontend/src/app/pages/play/game-scene.ts`,
`frontend/src/assets/sprite-library/`).

**Ordre conseillé : Lot 10 puis Lot 11 d'abord** — ils se répondent, un gabarit de monstre (Lot 11)
est la première vraie consommation de la bibliothèque d'assets (Lot 10). Les lots suivants sont
indépendants les uns des autres, à faire à la carte selon ce qui manque le plus en jouant.

À lire intégralement avant tout lot, comme pour le cahier des charges d'origine. Mêmes règles de
travail que le reste du lab (CLAUDE.md racine) : vérification en navigateur réel via Playwright
quand c'est pertinent, mémoire tenue à jour, demander avant tout commit/push et avant toute
décision d'architecture significative non tranchée ici.

---

## Lot 10 — Bibliothèque d'assets centralisée

### Constat
`assets/sprite-library/` est un dossier statique figé au build (les 3 manifestes JSON —
`manifest.json`, `monster-parts-manifest.json`, `player-skins.json` — sont générés à la main, pas
par une API). Un upload ou une génération IA faite dans l'éditeur d'un monstre ne devient qu'une
icône plate à usage unique (`icon_path`) — impossible aujourd'hui de réutiliser une pièce/un
effet produit pour un monstre sur un autre. C'est le trou signalé explicitement par l'utilisateur
le 2026-08-04.

### Étapes
1. **Modèle backend `SpriteAsset`** (`craft-lab/backend/api/models.py`) : `name`, `category`
   (block/character/monster-creature/monster-part/weapon/tool/effect/other), `slot_hint`
   (optionnel — `"arm"`/`"leg"`/`"body"`/... utilisé par les gabarits du Lot 11), `file_path`
   (stocké via `storage`, même patron que `icon_path`/`upload_bytes` déjà en place dans
   `ItemCategoryViewSetMixin.icon`), `source` (`cc0-bundled`/`ai-generated`/`upload`), `tags`
   (JSON liste libre), `created_by_email`, timestamps.
2. **Migration + serializer + ViewSet** : `GET` liste filtrable par catégorie/tag/recherche texte,
   `POST` upload (réutilise `storage_client.upload_bytes`).
3. **Commande de gestion à usage unique** : importe les ~260 fichiers actuels de
   `assets/sprite-library/` comme autant de `SpriteAsset` (`source='cc0-bundled'`), à partir des 3
   manifestes JSON existants (catégorie/label déjà présents, juste à transposer) — même démarche
   que `transferer_vers_storage` d'atelier-3d (usage unique, supprimée après vérification).
4. **Nouvelle page catalogue "Bibliothèque"** (`frontend/src/app/pages/catalogue/bibliotheque/`) :
   parcourir/rechercher/filtrer par catégorie et tag, uploader un nouveau fichier directement dans
   la bibliothèque (indépendamment de tout monstre en cours d'édition).
5. **Brancher `AiImagePanelComponent` (onglet "pack libre") et `MonsterBuilderComponent` (palette
   de pièces, sélecteur d'image temporaire d'étape)** sur cette API au lieu des fichiers statiques
   + manifestes JSON — un upload/une génération IA faite dans l'éditeur d'un monstre alimente
   désormais aussi la bibliothèque partagée.
6. **Décision à prendre en démarrant ce lot** (pas tranchée ici) : les références dans
   `Monster.rig.parts[].file` / `RigSkillStep.poses[].tempImage` passent-elles à un id de
   `SpriteAsset`, ou le contenu CC0 bundlé reste-t-il servi par chemin statique (perf) avec
   seulement le contenu utilisateur en id ? Trancher avant d'écrire la migration de données.

**⚡ Parallélisable via subagent** : l'étape 3 (import en masse, mécanique une fois le modèle
posé) et l'étape 4 (page de parcours, UI autonome une fois l'API du point 2 stabilisée) — à
condition que le contrat d'API (schéma des champs, endpoints) soit figé avant de les lancer en
parallèle du reste.

---

## Lot 11 — Gabarits de monstre (bipède, ver, volant, tourelle/lanceur)

### Constat
Le montage d'un monstre est aujourd'hui 100% à la main, à partir de zéro, à chaque fois — deux
monstres bipèdes n'ont rien de partagé (ni positions, ni les 5 compétences).

### Étapes
1. **Modèle backend `RigTemplate`** : `name` (ex. "Bipède"), `slots` (JSON — liste de
   `{slot_key, label, default_x, default_y, required}`), `default_skills` (même structure que
   `RigSkill.steps[].poses`, mais indexée par `slot_key` plutôt qu'un `partId` concret — résolue
   en vrai `partId` au moment de l'application du gabarit à un monstre réel).
2. **4 gabarits de départ**, un par un (position des slots + chorégraphies idle/marche/saut/
   attaque par défaut) :
   - **Bipède** — tête+torse, bras-g, bras-d, jambe-g, jambe-d ; marche = jambes en rotation
     alternée (déjà bien couvert par le moteur actuel, `phaseMode: 'mirror'`).
   - **Ver / serpent** — N segments empilés (slot répétable, pas une liste fixe comme les autres) ;
     marche = ondulation en vague (déphasage progressif entre segments consécutifs — généralise
     `phaseMode`, actuellement binaire mirror/sync, à un déphasage continu par index de segment).
   - **Volant** — corps + aile-g + aile-d ; pas de compétence "saut", "déplacement" devient un
     battement synchronisé (`phaseMode: 'sync'`, déjà supporté).
   - **Tourelle / lanceur** — corps fixe + point d'émission ; aucune compétence de déplacement, une
     compétence "attack" qui déclenche un tir (dépend du Lot 12 pour un vrai projectile — sans lui,
     dégrade en attaque de contact classique).
3. **Flux "Créer depuis un gabarit"** dans `MonsterBuilderComponent` : choisir un gabarit → un
   sélecteur d'image par slot (depuis la Bibliothèque du Lot 10) → positions/chorégraphies par
   défaut copiées telles quelles dans `Monster.rig`, éditables ensuite avec les outils déjà
   existants (rien de nouveau à apprendre une fois le monstre créé).
4. **Backend** : action `POST /api/monsters/<id>/apply-template/` qui matérialise le gabarit
   choisi + les images sélectionnées en un vrai `Monster.rig`.

**⚡ Parallélisable via subagent** : une fois le PREMIER gabarit (Bipède, étape 2) posé et son
schéma validé — sert de patron, pas à paralléliser — les 3 gabarits suivants (Ver, Volant,
Tourelle) sont indépendants les uns des autres et peuvent être chorégraphiés en parallèle par 3
subagents distincts.

---

## Lot 12 — Projectiles réellement simulés

`WeaponProjectile` existe en base depuis le Lot 1 mais n'est jamais lu par le moteur — tout
monstre/arme "à distance" attaque au contact comme un monstre au corps-à-corps (simplification
documentée dans `game-scene.ts` depuis le Lot 6b).

1. Étendre `WorldWeaponDef`/nouveau `WorldMonsterProjectileDef` pour porter l'image + la vitesse
   d'un projectile.
2. `GameScene` : nouvelle entité "projectile volant" (sprite physique simple, vitesse/direction
   fixées au tir, détruit au premier contact bloc/joueur/monstre).
3. Un monstre "lanceur" (Lot 11) déclenche un tir au lieu d'un contact direct — la compétence
   `attack` gagne un type d'action "tirer" en plus de "toucher au contact".
4. Réutilise le système de dégâts déjà en place (`damagePlayer`/message réseau `player-damage`) —
   seule la détection change (contact du projectile, pas de la pièce elle-même).

## Lot 13 — Hiérarchie squelette parent-enfant

Actuellement chaque pièce d'un montage est positionnée indépendamment par rapport au centre du
monstre — un avant-bras ne "suit" pas le bras, il faut positionner les deux à la main sans lien.

1. `MonsterRigPart` gagne un `parentId` optionnel (référence une autre pièce du même montage).
2. Le moteur (`buildRiggedMonster`) compose position ET rotation par rapport au PARENT, pas
   seulement par rapport au centre du monstre.
3. L'éditeur affiche la hiérarchie (ex. liste indentée) et applique la rotation du parent
   visuellement dans l'aperçu.

⚠ Touche le cœur du moteur de rendu (`buildRiggedMonster`/`tickRigPlayback`) — à ne pas mener en
parallèle d'un autre chantier sur `game-scene.ts`.

## Lot 14 — Frames d'invincibilité joueur

Un contact répété peut aujourd'hui vider les PV du joueur en une fraction de seconde, sans fenêtre
de réaction.

1. `damagePlayer()` ignore tout nouveau dégât pendant ~600-800ms après le précédent.
2. Retour visuel (clignotement du sprite joueur) pendant cette fenêtre.

## Lot 15 — Son (SFX minimum)

Aucun son nulle part dans craft-lab aujourd'hui.

1. Bibliothèque de sons courts CC0 (même démarche que la bibliothèque d'images du 2026-08-04 —
   Kenney propose aussi des packs SFX CC0 : "Impact Sounds", "RPG Audio").
2. 3-4 évènements sonores : coup porté, dégât reçu, ramassage d'objet, minage.
3. Phaser gère le son nativement (`this.sound.add`/`.play`) — chantier limité au câblage, pas de
   nouvelle brique d'UI.

## Lot 16 — Petits effets ("juice")

1. Tremblement de caméra bref au moment d'un coup encaissé (`this.cameras.main.shake(...)`, natif
   Phaser).
2. Petite explosion de particules à l'impact (réutilise la catégorie `effects/` de la bibliothèque
   du Lot 10).

## Lot 17 — IA monstre enrichie

1. Télégraphe d'attaque : un temps de préparation (jouant une compétence dédiée) avant que le coup
   ne parte réellement, au lieu d'un dégât instantané au contact.
2. Fuite sous un seuil de PV (nouveau pattern de mouvement, ex. `flee-low-hp`).
