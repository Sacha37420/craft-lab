# Feuille de route — craft-lab

Ce fichier est lu par une machine : `validate-app.sh` refuse de déployer s'il manque ou s'il ne
contient aucun lot au format ci-dessous, et `app-test.sh` lit la commande de test. Garder les titres
tels quels.

App livrée avant l'obligation de feuille de route. Le Lot 1 résume l'existant, y compris les lots 0
à 12 du projet. Les lots 13 à 17 de `to_do_craft_lab.md` (à côté de ce fichier : description
complète, constats, choix de conception) sont repris ici en lots 3 à 7, avec leurs titres d'origine.
La vue d'ensemble est dans `to_do_global.md`, à la racine du dépôt du lab. Légende : [C] constaté,
[D] déduit.

## Commande de test
python manage.py test

## Lot 1 — Existant : catalogue, jeu multijoueur, assets, gabarits de monstre, projectiles   ·   statut : livré
**Objectif :** éditeur de catalogue et jeu 2D multijoueur (Phaser), relais WebSocket `relay/`.
**Tâches :**
- [x] Phase 1, lots 0 à 9 (2026-08-02)
- [x] Lots 10 (bibliothèque d'assets) et 11 (gabarits de monstre), commit `633d327` ; lot 12 (projectiles simulés), commit `b4ade0a` (2026-08-04)
- [x] Correctifs du chantier tests (`chantiers/tests/rapports/hub-craft.md`)
**Tests à passer avant de clore le lot :**
- [x] 93 tests backend ; `cloisonnement.spec.ts` identique au gabarit
**Vérifié le :** 2026-10-31 — relevé par lecture (version en service = `499529d`), tests non rejoués.

## Lot 2 — Hygiène   ·   statut : en cours
**Objectif :** relais sans secrets, envois bornés, plus de comptes d'exemple, jeton hors des URL.
**Constat [C] :**
- **P1.** Le relais reçoit `env_file: .env` complet : `SECRET_KEY`, clé Fernet des clés IA, et
  `DB_PASSWORD`. Il ne lit que `BACKEND_INTERNAL_URL` et `RELAY_INTERNAL_KEY` (`relay/server.js:23-24`).
- `?token=` dans les URL d'icônes (`core/api.service.ts:397-401`).
- Aucune taille maximale pour l'envoi d'une icône ou d'un sprite ; le type n'est contrôlé que par la
  signature du format.
- La migration `0002_example_data.py` sème encore `alice@`, `bob@` et `charlie@example.com`.
**Tâches :**
- [x] `environment:` minimal pour `relay` (chantier urgences, secteur D) : `BACKEND_INTERNAL_URL` et `RELAY_INTERNAL_KEY` seulement
- [x] Taille maximale des envois : 10 485 760 octets par icône ou sprite, 413 avant toute lecture du corps si `Content-Length` dépasse la forme base64 + 1 Mo, puis 413 sur la taille exacte (`api/limits.py`) ; décodage réel par Pillow (tranché par le contrat « failles » § 7), 400 sinon — SVG toujours refusé
- [x] Migration `0022_retirer_comptes_exemple` : retire alice@/bob@/charlie@example.com et leurs départements, seulement s'ils n'ont rien laissé d'autre (sinon ne fait rien et le journalise)
- [x] Icônes par `HttpClient` + `Blob` (`AuthBlobService`, `[appAuthSrc]`), textures Phaser et composite du montage en URL `blob:` révoquées ; plus aucun `token=` dans une URL
- [x] Coffre des clés IA sous `VAULT_ENCRYPTION_KEY` (F7), migration `0021_rechiffrer_coffre` ; ports liés à `127.0.0.1` (I1) ; billet du relais consommé atomiquement
- [x] Polices en chemin relatif (404 constaté) ; `tokenBases()` ; PKCE ; `loginRedirectUri`
**Tests à passer avant de clore le lot :**
- [ ] `docker exec craft-lab-relay env` ne montre ni `DB_` ni `SECRET`
- [x] Un fichier trop gros reçoit 413
- [ ] Aucune requête ne porte `token=`
- [ ] Les WOFF2 répondent 200
**Vérifié le :** 2026-10-31 — chantier « failles » (F7, F9, I1-I4) : `ESSAI_IMAGE=craft-lab-backend:candidat bash chantiers/tests/essai.sh craft-lab` → 112 tests OK (dont `test_failles.py` : 10 485 760 octets acceptés, 10 485 761 → 413, `Content-Length` géant → 413 sans analyse du corps, PNG tronqué, texte renommé `.png`, signatures seules et bombe de décompression → 400, storage jamais appelé ; ancien chiffrement et clair historique relus puis rechiffrés, valeur indéchiffrable lue `''` et laissée intacte ; comptes d'exemple, deux branches) ; `makemigrations --check` : aucun changement ; `npx ng build` vert ; `grep -rnE "token=|\?token" frontend/src` : rien (seul `?ticket=` du relais) ; `docker compose config` : trois ports sur `127.0.0.1` — non déployé. Restent à l'architecte : déploiement, `docker exec craft-lab-relay env`, WOFF2 en 200 et absence de `token=` vérifiées en navigateur. Avant (relais, hors service) : 2026-10-31 (tâche relais seulement, hors service) — `docker compose -f deploiement/craft-lab/docker-compose.yml config` : environnement du relais = `BACKEND_INTERNAL_URL`, `RELAY_INTERNAL_KEY` (non vide, égal à celui du backend), aucun `env_file` ; backend inchangé. `node --check relay/server.js` OK. Variables lues par `server.js` et ses dépendances (`express`, `ws`, `debug`, relevées dans le conteneur en service) : aucune autre n'est fournie par le `.env`. Test « `docker exec craft-lab-relay env` sans `DB_` ni `SECRET` » à jouer après redéploiement.

## Lot 3 — Lot 13 d'origine : squelette parent-enfant   ·   statut : à faire
**Objectif :** pièces de monstre articulées (`to_do_craft_lab.md`, Lot 13). [C] Aucun `parentId` dans `models.py`.
**Tâches :**
- [ ] Selon `to_do_craft_lab.md` § Lot 13
**Tests à passer avant de clore le lot :**
- [ ] Migration avec `parentId` ; le sérialiseur refuse un cycle de parenté ; rendu vérifié en navigateur
**Vérifié le :**

## Lot 4 — Lot 14 d'origine : frames d'invincibilité   ·   statut : à faire
**Objectif :** `to_do_craft_lab.md`, Lot 14. [C] `damagePlayer` n'a pas de fenêtre d'invincibilité (`game-scene.ts:971-976`).
**Tâches :**
- [ ] Selon `to_do_craft_lab.md` § Lot 14
**Tests à passer avant de clore le lot :**
- [ ] Deux dégâts à moins de 600 ms ne sont appliqués qu'une fois
**Vérifié le :**

## Lot 5 — Lot 15 d'origine : sons   ·   statut : à faire
**Objectif :** `to_do_craft_lab.md`, Lot 15. [C] Aucun `this.sound`.
**Tâches :**
- [ ] Selon `to_do_craft_lab.md` § Lot 15
**Tests à passer avant de clore le lot :**
- [ ] Vérification en navigateur réel
**Vérifié le :**

## Lot 6 — Lot 16 d'origine : effets visuels   ·   statut : à faire
**Objectif :** `to_do_craft_lab.md`, Lot 16. [C] Aucun `cameras.main.shake`.
**Tâches :**
- [ ] Selon `to_do_craft_lab.md` § Lot 16 ; fond Phaser (`play.component.ts:499`) tiré du thème
**Tests à passer avant de clore le lot :**
- [ ] Vérification en navigateur réel, clair et sombre
**Vérifié le :**

## Lot 7 — Lot 17 d'origine : IA de monstre enrichie   ·   statut : à faire
**Objectif :** `to_do_craft_lab.md`, Lot 17. [D] Seul le motif `flee` de base existe (`game-scene.ts:1555`).
**Tâches :**
- [ ] Selon `to_do_craft_lab.md` § Lot 17
**Tests à passer avant de clore le lot :**
- [ ] Télégraphe visible avant le dégât ; fuite sous un seuil de PV
**Vérifié le :**

## Lot 8 — Documentation, tests du relais et chemin à portes   ·   statut : à faire
**Objectif :** un README, un relais testé, un déploiement par le moteur (T1).
**Tâches :**
- [ ] `README.md` : architecture (backend, relais, Phaser), bibliothèque d'assets, licences CC0
- [ ] Tests du relais (aucun aujourd'hui) : clé interne, messages mal formés
**Tests à passer avant de clore le lot :**
- [ ] `validate-app.sh craft-lab --quality-only` vert ; cloisonnement `ok` par le moteur
**Vérifié le :**

## Mise en service — chantier « failles » (2026-11-01)
Les mentions « non déployé » ci-dessus datent d'avant cette mise en service. Image construite pendant
que l'ancienne tournait, `scripts/app-test.sh` : 112 tests OK, puis `up -d --no-build` ; ports
publiés sur `127.0.0.1` ; client Keycloak passé en PKCE S256 exigé, URI de retour réduites à celles de
l'app (`create-app-client.sh --pkce --prune-uris`) ; cloisonnement `lab-runner` 3/3 avant et après le durcissement du client, puis de nouveau 3/3 sur Keycloak 26.8.1.
Restent les vérifications en navigateur réel notées dans les lots (images, coffres de clés, envois).
