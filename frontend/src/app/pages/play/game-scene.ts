import Phaser from 'phaser';
import {
  generateTerrainPreview, GeneratedCell, ROWS_PER_TIER, TierRules,
} from '../../shared/world/terrain-generation';
import {
  InventoryEntry, WorldBlockDef, WorldItemRef, WorldMonsterDef, WorldMonsterSpawnRate,
  WorldRecipe, WorldToolDef, WorldWeaponDef,
} from './world-types';

export const TILE_SIZE = 32;
export const WORLD_WIDTH = 120;

const REACH_TILES = 5;
const MOVE_SPEED = 200;
const JUMP_VELOCITY = -430;
const GRAVITY_Y = 900;
const LIQUID_TICK_MS = 400;
const LIQUID_MAX_PER_TICK = 150;
/** Ne pousse une mise à jour de progression de minage à Angular que si elle a assez changé — évite de saturer le zone Angular à 60 appels/s. */
const MINING_PROGRESS_EMIT_STEP = 0.02;

export const PLAYER_MAX_HP = 100;
/** Cahier des charges 1.9 point 2 : réévaluation toutes les 5s, exclusion 10 blocks autour du joueur. */
const MONSTER_SPAWN_TICK_MS = 5000;
const MONSTER_SPAWN_EXCLUSION_TILES = 10;
const MONSTER_SPAWN_VERTICAL_BAND_TILES = 10;
const MONSTER_SPAWN_ATTEMPTS_PER_TICK = 5;
/** Plafond propre à la taille réduite du monde local (le cahier des charges suppose un monde
 * bien plus grand, cf. "10 à 10 000 blocks") — sans lui la densité de monstres diverge. */
const MAX_LIVE_MONSTERS = 12;
/** Simplification documentée : tout monstre attaque au contact, quel que soit son attack_type —
 * aucune donnée de projectile n'est associée à un monstre dans le schéma actuel (WeaponProjectile
 * ne lie que armes→projectiles). Modéliser un vrai monstre "à distance" nécessiterait d'étendre le
 * schéma, hors périmètre du 6b. Portée réglable par monstre (Monster.attack_range_tiles), ceci
 * n'était que l'ancienne valeur par défaut fixe, désormais uniquement le défaut du modèle Django. */
const DEFAULT_MELEE_RANGE_TILES = 1.5;
const DEFAULT_RANGED_RANGE_TILES = 6;
const BARE_HANDS_DAMAGE = 1;
const BARE_HANDS_RANGE_TILES = 1.2;
const BARE_HANDS_RATE = 1;
/** Lot 8b — cadence de diffusion de l'état des monstres par l'hôte (position/PV), pas à chaque
 * frame : suffisant pour un mouvement lisse côté clients non-hôtes sans saturer le relais. */
const MONSTER_BROADCAST_INTERVAL_MS = 200;

/** Les 5 skins complets du pack Kenney "Platformer Characters" (assets/sprite-library/characters/)
 * — mêmes 5 poses pour chacun (idle/walk1/walk2/jump/fall), cf. LICENSE.txt à cet endroit. */
export const PLAYER_SKINS = ['adventurer', 'female', 'player', 'soldier', 'zombie'];
type PlayerPose = 'idle' | 'walk1' | 'walk2' | 'jump' | 'fall';
const playerFrameKey = (skin: string, pose: PlayerPose): string => `player-${skin}-${pose}`;
const blockIconKey = (id: number): string => `block-icon-${id}`;
/** Clé de texture stable pour une pièce de montage de monstre — dérivée de l'id SpriteAsset (Lot 10 ;
 * deux monstres référençant le même asset partagent la même texture, jamais rechargée deux fois). */
const rigPartKey = (assetId: number): string => `rig-part-${assetId}`;
/** Anti-retrigger pour une pièce collidesTerrain (une arme réutilise plutôt le cooldown d'attaque
 * du monstre, def.attackRate) — un contact immobile contre un mur ne doit déclencher la compétence
 * 'block-hit' qu'une fois toutes les ~500ms, pas à 60 im/s tant qu'il persiste. */
const RIG_TERRAIN_HIT_COOLDOWN_MS = 500;
/** Seuil de déplacement (px) entre deux frames d'animation pour considérer un monstre "en marche"
 * plutôt qu'"immobile" (cf. tickRigPlayback) — dérivé de la position plutôt que de body.velocity
 * pour fonctionner identiquement côté hôte (vraie physique) et non-hôte (positions reçues du
 * réseau, jamais de vitesse). */
const RIG_MOVING_THRESHOLD_PX = 0.5;

export interface InitialCharacterState {
  hp: number;
  positionX: number;
  positionY: number;
  inventory: Record<number, number>;
  equippedWeaponId: number | null;
}

export interface GameSceneConfig {
  seed: number;
  tiers: TierRules[];
  blockDefs: Map<number, WorldBlockDef>;
  tools: WorldToolDef[];
  itemsById: Map<number, WorldItemRef>;
  monsters: Map<number, WorldMonsterDef>;
  monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>;
  weapons: WorldWeaponDef[];
  recipes: WorldRecipe[];
  /** Diff persisté d'une partie sauvegardée (Lot 7) — absent pour une toute nouvelle partie. */
  initialBlockDiff?: Record<string, number | null>;
  /** Avancement persisté d'une partie sauvegardée (Lot 7) — absent pour une toute nouvelle partie
   * (dans ce cas le joueur apparaît au point de spawn trouvé automatiquement, avec le kit de
   * départ habituel, cf. giveStarterTools). */
  initialCharacter?: InitialCharacterState;
  /** Préfixe du skin joueur (assets/sprite-library/characters/<préfixe>_<pose>.png) — toujours
   * présent (défaut 'adventurer'), indépendant de initialCharacter : un choix d'apparence, pas de
   * l'avancement de la partie. Les 5 skins sont TOUS préchargés (cf. preload()), pas seulement
   * celui-ci — change de skin en jeu = simple changement de texture, jamais un chargement à chaud. */
  playerSkin: string;
  onInventoryChange: (entries: InventoryEntry[]) => void;
  onMiningProgress: (progress: number | null, blockName: string | null) => void;
  onMessage: (text: string) => void;
  onHpChange: (hp: number, maxHp: number) => void;
  /** Lot 8 — point de sortie UNIQUE vers le réseau : blocks, position (déjà du 8a), et au 8b
   * spawn/état/mort de monstre, demande d'attaque, butin, dégâts ciblés. GameScene ne sait jamais
   * si un message part réellement sur le fil — PlayComponent décide (relais up ou non). */
  onNetworkSend?: (msg: { type: string; [key: string]: unknown }) => void;
}

interface TileXY { x: number; y: number; }

/** Pièce du montage, résolue avec sa texture — plus aucune formule d'oscillation propre à la
 * pièce : la pose (dx/dy/rotation) à chaque instant vient de la compétence en cours de lecture
 * (cf. LiveMonster.activePlayback), jamais d'un état stocké ici. */
interface RigPartInstance {
  id: string;
  obj: Phaser.GameObjects.Sprite;
  /** Position locale de repos (origine (0.5,0), cf. buildRiggedMonster) — toute pose de compétence
   * est un décalage PAR RAPPORT à celle-ci, jamais une position absolue. */
  baseX: number;
  baseY: number;
  restTextureKey: string;
  /** Empreinte de la pièce (taille d'affichage réelle, avant toute rotation) — pour les tests de
   * recouvrement AABB de tickRigCollisions, jamais recalculée par frame. */
  width: number;
  height: number;
  isWeapon: boolean;
  collidesTerrain: boolean;
  /** Anti-retrigger propre à CETTE pièce pour collidesTerrain (isWeapon réutilise le cooldown
   * d'attaque du monstre, m.attackCooldownMs, partagé par toutes ses pièces armées). */
  terrainCooldownUntil: number;
}

interface RigSkillPoseRuntime {
  dx: number;
  dy: number;
  rotationDeg: number;
  tempTextureKey?: string;
}

interface RigSkillStepRuntime {
  durationMs: number;
  poses: Map<string, RigSkillPoseRuntime>;
}

/** Chorégraphie résolue (textures des images temporaires préchargées) — cf. RigSkill côté
 * api.service.ts pour la sémantique complète des 5 types. */
interface RigSkillRuntime {
  id: string;
  type: 'idle' | 'move-lateral' | 'jump' | 'attack' | 'block-hit';
  steps: RigSkillStepRuntime[];
}

/** Lecture en cours d'une compétence sur un montage — `fromPoses` fige la pose exacte affichée au
 * moment où l'étape courante a commencé (celle de l'étape précédente, ou le repos pour la
 * première), point de départ de l'interpolation vers `steps[stepIndex].poses`. */
interface RigPlaybackState {
  skill: RigSkillRuntime;
  loop: boolean;
  stepIndex: number;
  stepStartMs: number;
  fromPoses: Map<string, RigSkillPoseRuntime>;
}

interface LiveMonster {
  /** Identifiant attribué par l'hôte à la création (cf. spawnMonster/applyMonsterSpawn) — sert de
   * clé de correspondance entre clients, indépendante de l'id catalogue (WorldMonsterDef.id). */
  networkId: string;
  /** Sprite unique (icône plate classique) OU Container (montage par pièces, cf. rigParts) —
   * .x/.y/.setPosition/.destroy/.body/.getBounds fonctionnent à l'identique dans les deux cas
   * (cf. createMonsterEntity, qui appelle setSize()/physics.add.existing() sur le Container pour
   * que getBounds()/le corps physique restent cohérents avec un vrai Sprite). */
  sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Container;
  /** Présent seulement pour un monstre monté par pièces. */
  rigParts?: RigPartInstance[];
  /** Compétences résolues du montage (cf. RigSkillRuntime) — vide si aucune définie. */
  skills?: RigSkillRuntime[];
  /** Lecture en cours (cf. RigPlaybackState) — null quand aucune compétence ne joue (les pièces
   * restent alors à leur pose de repos). */
  activePlayback?: RigPlaybackState | null;
  /** Dernière position connue (repère la marche par delta de position plutôt que par vitesse —
   * cf. tickRigPlayback — pour fonctionner identiquement côté hôte, qui simule une vraie physique,
   * et côté non-hôte, qui ne reçoit que des positions du réseau, jamais de vitesse). */
  lastKnownX?: number;
  /** Horodatage du dernier déplacement significatif détecté (cf. tickRigPlayback) — "en marche" tant
   * que récent, plutôt qu'un booléen instantané qui flickerait entre deux diffusions réseau
   * espacées de MONSTER_BROADCAST_INTERVAL_MS côté non-hôte. */
  lastMovedAtMs?: number;
  def: WorldMonsterDef;
  hp: number;
  attackCooldownMs: number;
  wanderDir: 1 | -1;
  aiTimerMs: number;
  flyDirX: number;
  flyDirY: number;
}

/**
 * Simulation + rendu du monde jouable (Lots 6a/6b/7/8). Ne parle jamais
 * directement à l'API ni au WebSocket — reçoit tout ce dont elle a besoin en
 * config depuis PlayComponent et communique vers l'extérieur uniquement par
 * callbacks (`onInventoryChange`, `onNetworkSend`...) ou par des getters lus
 * à la demande (`getBlockDiff`, `getCharacterState`, `getPlayerTransform`).
 *
 * Autorité hôte (Lot 8b, cahier des charges section 3 : "autorité distribuée
 * à un client hôte") limitée aux MONSTRES et à la résolution des combats —
 * déplacement/minage/pose/liquides restent simulés localement par CHAQUE
 * client, synchronisés par diffusion (8a), jamais par autorité complète du
 * monde. `isHost`/`selfId` sont mutables (`configureNetworkRole`), pas de la
 * config au constructeur : la partie démarre TOUJOURS en supposant l'autorité
 * (comportement solo normal), et ne bascule en non-hôte qu'une fois la
 * poignée de main du relais confirmée — sans ça, un joueur seul sans relais
 * joignable n'aurait jamais aucun monstre.
 */
export class GameScene extends Phaser.Scene {
  private readonly cfg: GameSceneConfig;

  private grid!: GeneratedCell[][];
  private worldHeight = 0;

  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasdKeys!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private currentPlayerSkin = 'adventurer';
  /** false si le sprite embarqué (assets/sprite-library/) n'a pas pu charger — auquel cas le repli
   * procédural (rectangle, cf. spawnPlayer) reste affiché en permanence, jamais animé par pose. */
  private usesEmbeddedPlayerSprite = false;
  private lastPlayerPose: PlayerPose = 'idle';
  private walkFrameAccumMs = 0;

  private map!: Phaser.Tilemaps.Tilemap;
  private layer!: Phaser.Tilemaps.TilemapLayer;
  private tileIndexByBlockId = new Map<number, number>();

  private inventory = new Map<number, number>();
  private selectedPlaceBlockId: number | null = null;

  private miningTile: TileXY | null = null;
  private miningProgress = 0;
  private miningDuration = 0;
  private lastEmittedMiningProgress = -1;

  private liquidFrontier: TileXY[] = [];
  private liquidTickAccum = 0;

  // Cellules changées PENDANT cette session (pas le diff hérité d'une sauvegarde — cf.
  // applyInitialDiff, qui mute this.grid directement sans passer par ici). Lu par
  // getBlockDiff() au moment de sauvegarder ; le backend FUSIONNE plutôt que remplacer,
  // donc il n'y a pas besoin de préremplir avec le diff hérité.
  private blockDiff = new Map<string, number | null>();
  /** true pendant applyRemoteBlockChange — évite de rediffuser un changement qu'on vient de recevoir. */
  private applyingRemoteChange = false;

  // Lot 8 — proxies visuels des autres joueurs connectés au même monde, purement affichage
  // (pas de corps physique local : la position vient du relais, jamais simulée ici).
  private remotePlayers = new Map<string, { sprite: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }>();
  // Positions des joueurs distants (id de connexion -> dernière position connue) — utilisé par
  // l'IA de monstre côté hôte pour cibler le joueur le plus proche, pas seulement le sien.
  private remotePlayerPositions = new Map<string, { x: number; y: number }>();

  // Lot 8b — mutables : la partie démarre en supposant l'autorité (cf. docstring de la classe),
  // configureNetworkRole() les corrige une fois la poignée de main du relais confirmée.
  private isHost = true;
  private selfId = '';
  private monsterBroadcastAccum = 0;
  /** Cooldowns d'attaque des joueurs DISTANTS (côté hôte uniquement — le sien est attackCooldownMs). */
  private remoteAttackCooldowns = new Map<string, number>();

  private playerHp = PLAYER_MAX_HP;
  private equippedWeaponId: number | null = null;
  private attackCooldownMs = 0;
  private liveMonsters: LiveMonster[] = [];
  private spawnTickAccum = 0;
  private sortedTierDepthIndices: number[] = [];

  constructor(config: GameSceneConfig) {
    super('game');
    this.cfg = config;
  }

  /**
   * Charge les vraies images du catalogue (icônes définies via le panneau IA/pack libre/upload,
   * cf. AiImagePanelComponent) avant `create()` — Phaser exige que toute texture existe avant
   * d'être posée sur un sprite/tilemap. Un fichier qui échoue à charger (404, réseau...) ne bloque
   * pas les autres : `this.load` continue la file, et le code de rendu (buildTilemap/
   * monsterTextureKey/spawnPlayer) vérifie `this.textures.exists(key)` avant de l'utiliser — sans
   * quoi il retombe sur le rendu procédural (couleur de bloc, rond de couleur de monstre, rectangle
   * doré du joueur), jamais d'erreur visible pour l'utilisateur.
   */
  preload(): void {
    const poses: PlayerPose[] = ['idle', 'walk1', 'walk2', 'jump', 'fall'];
    for (const skin of PLAYER_SKINS) {
      for (const pose of poses) {
        this.load.image(playerFrameKey(skin, pose), `assets/sprite-library/characters/${skin}_${pose}.png`);
      }
    }
    for (const def of this.cfg.blockDefs.values()) {
      if (def.iconUrl) this.load.image(blockIconKey(def.id), def.iconUrl);
    }
    // Un asset (ex: une jambe) peut être partagé par plusieurs monstres — dédupliqué ici via un Set
    // local, pas via this.textures.exists() qui ne se peuple qu'après le chargement (donc toujours
    // faux à ce stade de preload(), inutile pour éviter une double mise en file). `textureUrl` est
    // déjà résolue (statique CC0 ou storage+token, cf. PlayComponent/ApiService.spriteAssetUrl) —
    // GameScene ne construit plus jamais lui-même de chemin `assets/sprite-library/...`.
    const queuedRigAssets = new Set<number>();
    for (const def of this.cfg.monsters.values()) {
      if (def.iconUrl) this.load.image(`monster-${def.id}`, def.iconUrl);
      for (const part of def.rig?.parts ?? []) {
        if (queuedRigAssets.has(part.assetId)) continue;
        queuedRigAssets.add(part.assetId);
        this.load.image(rigPartKey(part.assetId), part.textureUrl);
      }
      for (const skill of def.rig?.skills ?? []) {
        for (const step of skill.steps) {
          for (const pose of Object.values(step.poses)) {
            if (pose.tempAssetId == null || !pose.tempTextureUrl || queuedRigAssets.has(pose.tempAssetId)) continue;
            queuedRigAssets.add(pose.tempAssetId);
            this.load.image(rigPartKey(pose.tempAssetId), pose.tempTextureUrl);
          }
        }
      }
    }
  }

  create(): void {
    this.grid = generateTerrainPreview(this.cfg.seed, WORLD_WIDTH, this.cfg.tiers, ROWS_PER_TIER);
    this.worldHeight = this.grid.length;
    this.sortedTierDepthIndices = [...this.cfg.tiers].sort((a, b) => a.depthIndex - b.depthIndex).map(t => t.depthIndex);
    this.applyInitialDiff();

    this.buildTilemap();
    this.spawnPlayer();
    this.setupInput();
    this.setupCamera();
    this.seedLiquidFrontier();

    if (this.cfg.initialCharacter) this.restoreCharacter(this.cfg.initialCharacter);
    else this.giveStarterTools();
    this.cfg.onHpChange(this.playerHp, PLAYER_MAX_HP);
  }

  /** Sauvegarde/chargement (Lot 7) — lus par PlayComponent au moment de sauvegarder/quitter. */
  getBlockDiff(): Record<string, number | null> {
    return Object.fromEntries(this.blockDiff);
  }

  getCharacterState(): InitialCharacterState {
    return {
      hp: this.playerHp,
      positionX: this.player.x,
      positionY: this.player.y,
      inventory: Object.fromEntries(this.inventory),
      equippedWeaponId: this.equippedWeaponId,
    };
  }

  // ── Multijoueur (Lot 8) — appelés par PlayComponent, jamais par cette classe elle-même ────

  getPlayerTransform(): { x: number; y: number; flipX: boolean } {
    return { x: this.player.x, y: this.player.y, flipX: this.player.flipX };
  }

  addRemotePlayer(id: string, label: string): void {
    if (this.remotePlayers.has(id)) return;
    const sprite = this.add.rectangle(this.player.x, this.player.y, 22, 38, 0x66aaff).setOrigin(0.5, 1);
    const text = this.add.text(this.player.x, this.player.y - 46, label, {
      fontSize: '12px', color: '#ffffff', backgroundColor: '#00000080', padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1);
    this.remotePlayers.set(id, { sprite, label: text });
  }

  removeRemotePlayer(id: string): void {
    const entry = this.remotePlayers.get(id);
    if (!entry) return;
    entry.sprite.destroy();
    entry.label.destroy();
    this.remotePlayers.delete(id);
    this.remotePlayerPositions.delete(id);
  }

  applyRemoteMove(id: string, x: number, y: number, flipX: boolean): void {
    this.remotePlayerPositions.set(id, { x, y });
    const entry = this.remotePlayers.get(id);
    if (!entry) return;
    entry.sprite.setPosition(x, y);
    entry.sprite.setScale(flipX ? -1 : 1, 1);
    entry.label.setPosition(x, y - 46);
  }

  /**
   * Appelé par PlayComponent dès que le relais confirme qui est l'hôte du salon (message
   * `welcome` ou `host-changed`). Si on perd l'autorité qu'on avait par défaut à la création
   * (cf. docstring de la classe), les monstres déjà simulés localement dans la fenêtre avant
   * confirmation sont sans valeur (aucun autre client ne les connaît) — on les efface, le vrai
   * hôte va rediffuser l'état correct via `monster-spawn`/`monster-state`.
   */
  configureNetworkRole(selfId: string, isHost: boolean): void {
    const wasHost = this.isHost;
    this.selfId = selfId;
    this.isHost = isHost;
    if (wasHost && !isHost) {
      for (const m of this.liveMonsters) m.sprite.destroy();
      this.liveMonsters = [];
    }
  }

  override update(_time: number, delta: number): void {
    // pointer.worldX/worldY ne sont recalculés par Phaser que sur un véritable événement pointeur
    // (move/down/up) — si la caméra défile (le joueur suit un bloc miné en tombant, par exemple)
    // sans que la souris ne bouge, la cible redevient obsolète et le minage s'arrête en silence.
    // Forcer le recalcul à chaque frame règle ça, y compris pour un joueur qui creuse tout droit
    // vers le bas sans toucher la souris.
    this.input.activePointer.updateWorldPoint(this.cameras.main);

    this.attackCooldownMs = Math.max(0, this.attackCooldownMs - delta);
    if (this.isHost) {
      for (const [id, ms] of this.remoteAttackCooldowns) {
        const next = ms - delta;
        if (next <= 0) this.remoteAttackCooldowns.delete(id); else this.remoteAttackCooldowns.set(id, next);
      }
    }
    this.handleMovement();
    this.tickPlayerAnimation();
    this.handleLeftClick(delta);
    this.tickLiquids(delta);
    this.tickMonsterSpawns(delta);
    this.tickMonsterAI(delta);
    this.tickRigCollisions(delta);
    this.tickMonsterBroadcast(delta);
    this.tickRigPlayback();
  }

  /** Appelé depuis PlayComponent quand l'utilisateur sélectionne (ou désélectionne) un block de l'inventaire à poser. */
  setSelectedBlock(itemId: number | null): void {
    this.selectedPlaceBlockId = itemId;
  }

  /** Appelé depuis PlayComponent quand l'utilisateur équipe (ou déséquipe) une arme de l'inventaire. */
  setEquippedWeapon(itemId: number | null): void {
    this.equippedWeaponId = itemId;
  }

  /** Fabrique 1 exemplaire de `itemId` si l'inventaire contient assez d'ingrédients — renvoie false sinon (message déjà émis). */
  craftItem(itemId: number): boolean {
    const recipe = this.cfg.recipes.find(r => r.itemId === itemId);
    if (!recipe || recipe.ingredients.length === 0) return false;
    for (const ing of recipe.ingredients) {
      if ((this.inventory.get(ing.itemId) ?? 0) < ing.quantity) {
        this.cfg.onMessage(`Ingrédients insuffisants pour fabriquer "${recipe.itemName}".`);
        return false;
      }
    }
    for (const ing of recipe.ingredients) this.removeFromInventory(ing.itemId, ing.quantity);
    this.addToInventory(itemId, 1);
    return true;
  }

  // ── Construction du monde ──────────────────────────────────────────────

  private buildTilemap(): void {
    const blockIds = [...this.cfg.blockDefs.keys()];
    const texKey = 'blocks-tileset';
    if (this.textures.exists(texKey)) this.textures.remove(texKey);
    const canvasTex = this.textures.createCanvas(texKey, Math.max(1, blockIds.length) * TILE_SIZE, TILE_SIZE)!;
    const ctx = canvasTex.getContext();
    blockIds.forEach((id, i) => {
      const def = this.cfg.blockDefs.get(id)!;
      const iconKey = blockIconKey(id);
      if (def.iconUrl && this.textures.exists(iconKey)) {
        const img = this.textures.get(iconKey).getSourceImage() as CanvasImageSource;
        ctx.drawImage(img, i * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
      } else {
        ctx.fillStyle = def.color;
        ctx.fillRect(i * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
        ctx.strokeStyle = def.isLiquid ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 2;
        ctx.strokeRect(i * TILE_SIZE + 1, 1, TILE_SIZE - 2, TILE_SIZE - 2);
      }
      this.tileIndexByBlockId.set(id, i);
    });
    canvasTex.refresh();

    this.map = this.make.tilemap({ tileWidth: TILE_SIZE, tileHeight: TILE_SIZE, width: WORLD_WIDTH, height: this.worldHeight });
    const tileset = this.map.addTilesetImage(texKey, texKey, TILE_SIZE, TILE_SIZE, 0, 0, 0)!;
    this.layer = this.map.createBlankLayer('ground', tileset, 0, 0)!;

    for (let y = 0; y < this.worldHeight; y++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        const cell = this.grid[y][x];
        if (cell.kind === 'block' && cell.blockId != null) {
          this.layer.putTileAt(this.tileIndexByBlockId.get(cell.blockId)!, x, y);
        }
      }
    }

    const collidableIndices = blockIds
      .filter(id => !this.cfg.blockDefs.get(id)!.isLiquid)
      .map(id => this.tileIndexByBlockId.get(id)!);
    if (collidableIndices.length) this.layer.setCollision(collidableIndices);
  }

  private spawnPlayer(): void {
    const spawn = this.cfg.initialCharacter
      ? { x: this.cfg.initialCharacter.positionX, y: this.cfg.initialCharacter.positionY }
      : this.findSpawn();

    this.currentPlayerSkin = this.cfg.playerSkin;
    let playerTextureKey = playerFrameKey(this.currentPlayerSkin, 'idle');
    this.usesEmbeddedPlayerSprite = this.textures.exists(playerTextureKey);
    if (!this.usesEmbeddedPlayerSprite) {
      // Repli si le sprite embarqué (assets/sprite-library/) n'a pas pu être chargé — cf. preload().
      playerTextureKey = 'player';
      const g = this.add.graphics();
      g.fillStyle(0xffcc66, 1);
      g.fillRect(0, 0, 22, 38);
      g.fillStyle(0x222222, 1);
      g.fillRect(13, 8, 5, 5);
      g.generateTexture(playerTextureKey, 22, 38);
      g.destroy();
    }

    this.player = this.physics.add.sprite(spawn.x, spawn.y, playerTextureKey);
    this.player.setOrigin(0.5, 1);
    // Le sprite embarqué (80×110) n'a pas les proportions du rectangle procédural (22×38) qu'il
    // remplace — redimensionné à l'affichage seulement, le corps physique ci-dessous reste la
    // référence pour les collisions, pas la taille de texture.
    if (this.usesEmbeddedPlayerSprite) this.player.setDisplaySize(28, 38);
    this.player.setCollideWorldBounds(true);
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setSize(20, 36);
    body.setGravityY(GRAVITY_Y);

    this.physics.add.collider(this.player, this.layer);
  }

  /** Change le skin joueur à chaud (choisi dans le HUD, cf. PlayComponent) — simple changement de
   * texture parmi celles déjà préchargées (cf. preload()), jamais un rechargement réseau. */
  setPlayerSkin(skin: string): void {
    if (!PLAYER_SKINS.includes(skin) || !this.player) return;
    this.currentPlayerSkin = skin;
    const key = playerFrameKey(skin, this.lastPlayerPose);
    if (this.textures.exists(key)) {
      this.player.setTexture(key);
      this.player.setDisplaySize(28, 38);
    }
  }

  /** Bascule idle/marche(2 frames)/saut/chute selon l'état réel du corps physique — jamais pour un
   * client dont ce ne serait pas le propre joueur (remotePlayers restent de simples rectangles,
   * cf. addRemotePlayer, aucune animation de pose pour eux : hors périmètre de ce chantier). */
  private tickPlayerAnimation(): void {
    if (!this.usesEmbeddedPlayerSprite) return;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const onGround = body.blocked.down || body.touching.down;
    let pose: PlayerPose;
    if (!onGround && body.velocity.y < -20) pose = 'jump';
    else if (!onGround && body.velocity.y > 20) pose = 'fall';
    else if (Math.abs(body.velocity.x) > 10) {
      this.walkFrameAccumMs += this.game.loop.delta;
      const frame = Math.floor(this.walkFrameAccumMs / 180) % 2;
      pose = frame === 0 ? 'walk1' : 'walk2';
    } else pose = 'idle';

    if (pose === this.lastPlayerPose) return;
    this.lastPlayerPose = pose;
    const key = playerFrameKey(this.currentPlayerSkin, pose);
    if (this.textures.exists(key)) this.player.setTexture(key);
  }

  private findSpawn(): { x: number; y: number } {
    const centerX = Math.floor(WORLD_WIDTH / 2);
    for (let radius = 0; radius < WORLD_WIDTH / 2; radius++) {
      for (const x of radius === 0 ? [centerX] : [centerX - radius, centerX + radius]) {
        if (x < 0 || x >= WORLD_WIDTH) continue;
        for (let y = 0; y < this.worldHeight - 1; y++) {
          if (this.grid[y][x].kind === 'void' && this.grid[y + 1][x].kind === 'block'
            && !this.isLiquidAt(x, y + 1)) {
            return { x: x * TILE_SIZE + TILE_SIZE / 2, y: (y + 1) * TILE_SIZE };
          }
        }
      }
    }
    return { x: centerX * TILE_SIZE, y: TILE_SIZE };
  }

  private setupInput(): void {
    this.cursors = this.input.keyboard!.createCursorKeys();
    const wasd = this.input.keyboard!.addKeys('W,A,D') as Record<string, Phaser.Input.Keyboard.Key>;
    this.wasdKeys = { W: wasd['W'], A: wasd['A'], D: wasd['D'] };
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) this.tryPlaceBlock(pointer);
    });
  }

  private setupCamera(): void {
    const worldPxWidth = WORLD_WIDTH * TILE_SIZE;
    const worldPxHeight = this.worldHeight * TILE_SIZE;
    this.physics.world.setBounds(0, 0, worldPxWidth, worldPxHeight);
    this.cameras.main.setBounds(0, 0, worldPxWidth, worldPxHeight);
    this.cameras.main.startFollow(this.player, true, 0.1, 0.1);
  }

  private giveStarterTools(): void {
    // Uniquement pour une TOUTE NOUVELLE partie (cf. create() : sinon restoreCharacter()
    // reprend l'inventaire sauvegardé). Le joueur démarre avec le meilleur outil du
    // catalogue — un vrai système de kit de départ par personnage reste à faire
    // (indépendant de la persistance elle-même, apportée par le Lot 7).
    const byType = new Map<string, WorldToolDef>();
    for (const tool of this.cfg.tools) {
      // Le type exact n'est pas porté par WorldToolDef (pas nécessaire au minage,
      // cf. cahier des charges 1.5 : seules puissance/vitesse comptent) — on ne garde
      // que le plus puissant toutes catégories confondues pour rester minimal.
      const current = byType.get('best');
      if (!current || tool.power > current.power) byType.set('best', tool);
    }
    const best = byType.get('best');
    if (best) this.addToInventory(best.id, 1);
  }

  /**
   * Applique le diff hérité d'une sauvegarde (Lot 7) en mutant `this.grid` directement — appelé
   * AVANT `buildTilemap()`, qui lit `this.grid` pour peupler ses tuiles initiales, donc le diff
   * est déjà "cuit" dans le monde généré sans double affichage ni deuxième passe sur le layer.
   */
  private applyInitialDiff(): void {
    const diff = this.cfg.initialBlockDiff;
    if (!diff) return;
    for (const [key, blockId] of Object.entries(diff)) {
      const [xs, ys] = key.split(',');
      const x = Number(xs);
      const y = Number(ys);
      if (!this.grid[y]?.[x]) continue;
      if (blockId == null) {
        this.grid[y][x] = { kind: 'void', color: 'transparent' };
      } else {
        const def = this.cfg.blockDefs.get(blockId);
        if (def) this.grid[y][x] = { kind: 'block', blockId, blockName: def.name, color: def.color };
      }
    }
  }

  private restoreCharacter(character: InitialCharacterState): void {
    this.playerHp = character.hp;
    this.equippedWeaponId = character.equippedWeaponId;
    this.inventory = new Map(Object.entries(character.inventory).map(([id, qty]) => [Number(id), qty]));
    this.emitInventory();
  }

  // ── Lecture/écriture de la grille ────────────────────────────────────────

  private blockIdAt(x: number, y: number): number | null {
    const cell = this.grid[y]?.[x];
    return cell && cell.kind === 'block' && cell.blockId != null ? cell.blockId : null;
  }

  private isLiquidAt(x: number, y: number): boolean {
    const id = this.blockIdAt(x, y);
    return id != null && !!this.cfg.blockDefs.get(id)?.isLiquid;
  }

  private isSolidCollidableAt(x: number, y: number): boolean {
    const id = this.blockIdAt(x, y);
    return id != null && !this.cfg.blockDefs.get(id)?.isLiquid;
  }

  private setCellVoid(x: number, y: number): void {
    this.grid[y][x] = { kind: 'void', color: 'transparent' };
    this.layer.removeTileAt(x, y);
    this.blockDiff.set(`${x},${y}`, null);
    if (!this.applyingRemoteChange) this.cfg.onNetworkSend?.({ type: 'block-change', x, y, blockId: null });
  }

  private setCellBlock(x: number, y: number, blockId: number): void {
    const def = this.cfg.blockDefs.get(blockId)!;
    this.grid[y][x] = { kind: 'block', blockId, blockName: def.name, color: def.color };
    this.layer.putTileAt(this.tileIndexByBlockId.get(blockId)!, x, y);
    this.blockDiff.set(`${x},${y}`, blockId);
    if (!this.applyingRemoteChange) this.cfg.onNetworkSend?.({ type: 'block-change', x, y, blockId });
  }

  /** Applique un changement de bloc reçu du relais (Lot 8) — même mutation que setCellVoid/
   * setCellBlock (diff de sauvegarde inclus), mais sans rediffuser (évite un écho infini). */
  applyRemoteBlockChange(x: number, y: number, blockId: number | null): void {
    if (!this.grid[y]?.[x]) return;
    this.applyingRemoteChange = true;
    if (blockId == null) this.setCellVoid(x, y); else this.setCellBlock(x, y, blockId);
    this.applyingRemoteChange = false;
  }

  // ── Déplacement ───────────────────────────────────────────────────────────

  private handleMovement(): void {
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    const left = this.cursors.left.isDown || this.wasdKeys.A.isDown;
    const right = this.cursors.right.isDown || this.wasdKeys.D.isDown;
    const jump = this.cursors.up.isDown || this.wasdKeys.W.isDown || this.cursors.space.isDown;

    if (left) { body.setVelocityX(-MOVE_SPEED); this.player.setFlipX(true); }
    else if (right) { body.setVelocityX(MOVE_SPEED); this.player.setFlipX(false); }
    else body.setVelocityX(0);

    const onGround = body.blocked.down || body.touching.down;
    if (jump && onGround) body.setVelocityY(JUMP_VELOCITY);

    const tx = Math.floor(this.player.x / TILE_SIZE);
    const ty = Math.floor((this.player.y - 4) / TILE_SIZE);
    if (this.isLiquidAt(tx, ty)) {
      // Nage simplifiée (gravité effective réduite) — l'effet de contact (dégâts,
      // ralentissement...) attend le système de PV introduit au Lot 6b (combat).
      body.setGravityY(-GRAVITY_Y * 0.7);
      if (body.velocity.y > 60) body.setVelocityY(60);
    } else {
      body.setGravityY(GRAVITY_Y);
    }
  }

  // ── Minage ───────────────────────────────────────────────────────────────

  private withinReach(tx: number, ty: number, rangeTiles = REACH_TILES): boolean {
    const px = Math.floor(this.player.x / TILE_SIZE);
    const py = Math.floor(this.player.y / TILE_SIZE);
    const dx = tx - px;
    const dy = ty - py;
    return Math.sqrt(dx * dx + dy * dy) <= rangeTiles;
  }

  private distanceTilesTo(worldX: number, worldY: number): number {
    const dx = (worldX - this.player.x) / TILE_SIZE;
    const dy = (worldY - this.player.y) / TILE_SIZE;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private tileFromWorld(wx: number, wy: number): TileXY {
    return { x: Math.floor(wx / TILE_SIZE), y: Math.floor(wy / TILE_SIZE) };
  }

  private bestToolFor(hardness: number): WorldToolDef | null {
    const owned = this.cfg.tools.filter(t => (this.inventory.get(t.id) ?? 0) > 0 && t.power >= hardness);
    if (!owned.length) return null;
    return owned.reduce((a, b) => (b.speed > a.speed ? b : a));
  }

  private cancelMining(): void {
    if (!this.miningTile) return;
    this.miningTile = null;
    this.miningProgress = 0;
    this.lastEmittedMiningProgress = -1;
    this.cfg.onMiningProgress(null, null);
  }

  private handleLeftClick(delta: number): void {
    const pointer = this.input.activePointer;
    if (!pointer.leftButtonDown()) { this.cancelMining(); return; }

    const monster = this.monsterUnderPointer(pointer);
    if (monster) { this.cancelMining(); this.tryAttack(monster); return; }

    this.handleMining(pointer, delta);
  }

  private handleMining(pointer: Phaser.Input.Pointer, delta: number): void {
    const { x: tx, y: ty } = this.tileFromWorld(pointer.worldX, pointer.worldY);
    if (tx < 0 || tx >= WORLD_WIDTH || ty < 0 || ty >= this.worldHeight || !this.withinReach(tx, ty)) {
      this.cancelMining();
      return;
    }
    const blockId = this.blockIdAt(tx, ty);
    if (blockId == null) { this.cancelMining(); return; }
    const def = this.cfg.blockDefs.get(blockId)!;

    if (!this.miningTile || this.miningTile.x !== tx || this.miningTile.y !== ty) {
      const tool = def.hardness > 0 ? this.bestToolFor(def.hardness) : null;
      if (def.hardness > 0 && !tool) {
        this.cfg.onMessage(`Outil trop faible pour miner "${def.name}" (dureté ${def.hardness}).`);
        this.miningTile = null;
        return;
      }
      const speed = tool?.speed ?? 1;
      this.miningTile = { x: tx, y: ty };
      this.miningProgress = 0;
      this.miningDuration = Math.max(150, (1000 * Math.max(def.hardness, 0.15)) / speed);
      this.lastEmittedMiningProgress = -1;
      return;
    }

    this.miningProgress += delta;
    const ratio = Math.min(1, this.miningProgress / this.miningDuration);
    if (ratio - this.lastEmittedMiningProgress >= MINING_PROGRESS_EMIT_STEP || ratio >= 1) {
      this.lastEmittedMiningProgress = ratio;
      this.cfg.onMiningProgress(ratio, def.name);
    }
    if (this.miningProgress >= this.miningDuration) this.completeMining(tx, ty, def);
  }

  private completeMining(tx: number, ty: number, def: WorldBlockDef): void {
    this.setCellVoid(tx, ty);
    this.miningTile = null;
    this.cfg.onMiningProgress(null, null);

    const drops = def.drops.length ? def.drops : [{ itemId: def.id, quantity: 1, chance: 1 }];
    for (const drop of drops) {
      if (Math.random() <= drop.chance) this.addToInventory(drop.itemId, drop.quantity);
    }
    this.wakeAdjacentLiquids(tx, ty);
  }

  // ── Pose de blocks ─────────────────────────────────────────────────────

  private hasAdjacentSolid(x: number, y: number): boolean {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => this.isSolidCollidableAt(x + dx, y + dy));
  }

  private tryPlaceBlock(pointer: Phaser.Input.Pointer): void {
    if (!this.selectedPlaceBlockId) { this.cfg.onMessage('Sélectionnez un block dans l\'inventaire pour le poser.'); return; }
    const { x: tx, y: ty } = this.tileFromWorld(pointer.worldX, pointer.worldY);
    if (tx < 0 || tx >= WORLD_WIDTH || ty < 0 || ty >= this.worldHeight || !this.withinReach(tx, ty)) return;
    if (this.grid[ty][tx].kind !== 'void') { this.cfg.onMessage('Case déjà occupée.'); return; }
    if (!this.hasAdjacentSolid(tx, ty)) { this.cfg.onMessage('Doit être posé contre un block existant.'); return; }
    const qty = this.inventory.get(this.selectedPlaceBlockId) ?? 0;
    if (qty <= 0) { this.cfg.onMessage('Plus aucun exemplaire de ce block en inventaire.'); return; }

    this.setCellBlock(tx, ty, this.selectedPlaceBlockId);
    this.removeFromInventory(this.selectedPlaceBlockId, 1);
  }

  // ── Combat ───────────────────────────────────────────────────────────────

  private monsterUnderPointer(pointer: Phaser.Input.Pointer): LiveMonster | null {
    for (const m of this.liveMonsters) {
      if (m.sprite.getBounds().contains(pointer.worldX, pointer.worldY)) return m;
    }
    return null;
  }

  /** Portée effective d'une arme (ou des mains nues si `weaponId` est absent/inconnu) — factorisé
   * car utilisé à la fois pour l'attaque locale (tryAttack) et la résolution côté hôte d'une
   * requête distante (resolveAttackRequest), qui doivent appliquer exactement la même règle. */
  private weaponRange(weapon: WorldWeaponDef | undefined): number {
    if (!weapon) return BARE_HANDS_RANGE_TILES;
    return weapon.attackRange
      ?? (weapon.style === 'melee' || weapon.style === 'summon' ? DEFAULT_MELEE_RANGE_TILES : DEFAULT_RANGED_RANGE_TILES);
  }

  private tryAttack(monster: LiveMonster): void {
    const weapon = this.equippedWeaponId != null ? this.cfg.weapons.find(w => w.id === this.equippedWeaponId) : undefined;
    if (this.distanceTilesTo(monster.sprite.x, monster.sprite.y) > this.weaponRange(weapon)) {
      this.cfg.onMessage('Trop loin pour attaquer.');
      return;
    }
    if (this.attackCooldownMs > 0) return;

    const rate = weapon?.attackRate || BARE_HANDS_RATE;
    this.attackCooldownMs = 1000 / Math.max(rate, 0.1);
    const damage = weapon?.damage ?? BARE_HANDS_DAMAGE;

    if (this.isHost) {
      // Résolu directement : l'hôte est déjà autoritaire sur ses propres monstres.
      this.damageMonster(monster, damage, 'self');
    } else {
      // Un non-hôte ne peut pas trancher lui-même (il ne connaît les PV du monstre que par les
      // diffusions de l'hôte, potentiellement en retard) — il demande, l'hôte résout et diffuse
      // le résultat (dégâts affichés, mort, butin) à tout le salon.
      this.cfg.onNetworkSend?.({
        type: 'attack-request', monsterId: monster.networkId, weaponId: this.equippedWeaponId,
        x: this.player.x, y: this.player.y,
      });
    }
  }

  /** Résolution d'une requête d'attaque envoyée par un client non-hôte — appelé par PlayComponent
   * uniquement quand ce client EST l'hôte (sinon la requête ne le concerne pas). */
  resolveAttackRequest(attackerId: string, monsterNetworkId: string, weaponId: number | null, attackerX: number, attackerY: number): void {
    const monster = this.liveMonsters.find(m => m.networkId === monsterNetworkId);
    if (!monster) return;
    const weapon = weaponId != null ? this.cfg.weapons.find(w => w.id === weaponId) : undefined;
    const dx = (attackerX - monster.sprite.x) / TILE_SIZE;
    const dy = (attackerY - monster.sprite.y) / TILE_SIZE;
    if (Math.sqrt(dx * dx + dy * dy) > this.weaponRange(weapon)) return; // hors de portée, requête ignorée
    if ((this.remoteAttackCooldowns.get(attackerId) ?? 0) > 0) return;

    const rate = weapon?.attackRate || BARE_HANDS_RATE;
    this.remoteAttackCooldowns.set(attackerId, 1000 / Math.max(rate, 0.1));
    this.damageMonster(monster, weapon?.damage ?? BARE_HANDS_DAMAGE, attackerId);
  }

  /** `looterId`: 'self' = crédite l'inventaire local directement (l'hôte s'attaque lui-même) ;
   * un id de connexion = le butin appartient à un autre joueur, diffusé pour qu'IL se le crédite
   * (cette classe ne connaît/ne modifie jamais l'inventaire d'un autre client). */
  private damageMonster(monster: LiveMonster, damage: number, looterId: 'self' | string): void {
    monster.hp -= damage;
    this.showFloatingText(monster.sprite.x, monster.sprite.y, `-${damage}`, '#ff6b6b');
    if (monster.hp <= 0) this.killMonster(monster, looterId);
  }

  private killMonster(monster: LiveMonster, looterId: 'self' | string): void {
    for (const drop of monster.def.drops) {
      if (Math.random() > drop.chance) continue;
      if (looterId === 'self') this.addToInventory(drop.itemId, drop.quantity);
      else this.cfg.onNetworkSend?.({ type: 'loot', targetId: looterId, itemId: drop.itemId, quantity: drop.quantity });
    }
    this.cfg.onNetworkSend?.({ type: 'monster-death', monsterId: monster.networkId });
    monster.sprite.destroy();
    this.liveMonsters = this.liveMonsters.filter(m => m !== monster);
  }

  private damagePlayer(damage: number): void {
    this.playerHp = Math.max(0, this.playerHp - damage);
    this.cfg.onHpChange(this.playerHp, PLAYER_MAX_HP);
    this.showFloatingText(this.player.x, this.player.y, `-${damage}`, '#ffcc66');
    if (this.playerHp <= 0) this.respawnPlayer();
  }

  /** Dégâts reçus d'un monstre simulé chez l'hôte, alors que CE client-ci est la cible (Lot 8b) —
   * appelé par PlayComponent en réception d'un message `player-damage` qui lui est adressé. */
  applyIncomingDamage(damage: number): void {
    this.damagePlayer(damage);
  }

  /** Butin gagné en tuant un monstre alors que c'est un AUTRE client (l'hôte) qui a résolu le
   * coup fatal — appelé par PlayComponent en réception d'un message `loot` qui lui est adressé. */
  applyLoot(itemId: number, quantity: number): void {
    this.addToInventory(itemId, quantity);
  }

  private respawnPlayer(): void {
    const spawn = this.findSpawn();
    this.player.setPosition(spawn.x, spawn.y);
    (this.player.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
    this.playerHp = PLAYER_MAX_HP;
    this.cfg.onHpChange(this.playerHp, PLAYER_MAX_HP);
    this.cfg.onMessage('Vous avez perdu connaissance... de retour au point de départ.');
  }

  private showFloatingText(x: number, y: number, text: string, color: string): void {
    const t = this.add.text(x, y - TILE_SIZE, text, { fontSize: '16px', color, fontStyle: 'bold' }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: y - TILE_SIZE * 2, alpha: 0, duration: 600, onComplete: () => t.destroy() });
  }

  // ── Écoulement des liquides ────────────────────────────────────────────

  private seedLiquidFrontier(): void {
    for (let y = 0; y < this.worldHeight; y++) {
      for (let x = 0; x < WORLD_WIDTH; x++) {
        if (this.isLiquidAt(x, y)) this.liquidFrontier.push({ x, y });
      }
    }
  }

  private wakeAdjacentLiquids(x: number, y: number): void {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (this.isLiquidAt(nx, ny)) this.liquidFrontier.push({ x: nx, y: ny });
    }
  }

  private tickLiquids(delta: number): void {
    this.liquidTickAccum += delta;
    while (this.liquidTickAccum >= LIQUID_TICK_MS) {
      this.liquidTickAccum -= LIQUID_TICK_MS;
      let processed = 0;
      const requeue: TileXY[] = [];
      while (this.liquidFrontier.length && processed < LIQUID_MAX_PER_TICK) {
        const cell = this.liquidFrontier.shift()!;
        processed++;
        if (!this.isLiquidAt(cell.x, cell.y)) continue;
        const blockId = this.blockIdAt(cell.x, cell.y)!;
        const def = this.cfg.blockDefs.get(blockId)!;
        for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0]]) {
          const nx = cell.x + dx;
          const ny = cell.y + dy;
          if (ny < 0 || ny >= this.worldHeight || nx < 0 || nx >= WORLD_WIDTH) continue;
          if (this.grid[ny][nx].kind === 'void' && Math.random() < def.flowSpreadChance) {
            this.setCellBlock(nx, ny, blockId);
            requeue.push({ x: nx, y: ny });
            break;
          }
        }
        requeue.push(cell);
      }
      this.liquidFrontier.push(...requeue);
    }
  }

  // ── Monstres : spawn ─────────────────────────────────────────────────────

  private tickMonsterSpawns(delta: number): void {
    // Lot 8b : seul l'hôte simule/décide des spawns — les autres clients les reçoivent via
    // `monster-spawn`. La couronne reste centrée sur la position de L'HÔTE (pas "chaque
    // personnage connecté" au pluriel comme le décrit le cahier des charges à l'échelle d'un
    // vrai serveur) : simplification assumée, cohérente avec l'autorité hôte limitée aux
    // monstres/combat plutôt qu'une refonte complète en simulation multi-centres.
    if (!this.isHost) return;
    this.spawnTickAccum += delta;
    if (this.spawnTickAccum < MONSTER_SPAWN_TICK_MS) return;
    this.spawnTickAccum = 0;
    if (this.liveMonsters.length >= MAX_LIVE_MONSTERS) return;

    const playerTileX = Math.floor(this.player.x / TILE_SIZE);
    const playerTileY = Math.floor(this.player.y / TILE_SIZE);
    const yMin = Math.max(0, playerTileY - MONSTER_SPAWN_VERTICAL_BAND_TILES);
    const yMax = Math.min(this.worldHeight - 2, playerTileY + MONSTER_SPAWN_VERTICAL_BAND_TILES);
    // Cahier des charges 1.9 point 2 : une "couronne... autour de chaque personnage", pas un
    // tirage uniforme sur tout le monde — le candidat est cherché à une distance aléatoire dans
    // l'anneau [exclusion, rayon max] du joueur, de part et d'autre (le rayon max du cahier des
    // charges, 10 000, n'a pas de sens ici : notre monde entier tient dans quelques dizaines de
    // blocks, donc borné à WORLD_WIDTH).
    const maxRadius = Math.min(WORLD_WIDTH, 60);

    for (let attempt = 0; attempt < MONSTER_SPAWN_ATTEMPTS_PER_TICK && this.liveMonsters.length < MAX_LIVE_MONSTERS; attempt++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const radius = Phaser.Math.Between(MONSTER_SPAWN_EXCLUSION_TILES, maxRadius);
      const x = Phaser.Math.Clamp(playerTileX + side * radius, 0, WORLD_WIDTH - 1);

      let spawnY: number | null = null;
      for (let y = yMin; y <= yMax; y++) {
        if (this.grid[y][x].kind === 'void' && this.grid[y - 1]?.[x]?.kind === 'void'
          && this.isSolidCollidableAt(x, y + 1)) {
          spawnY = y;
          break;
        }
      }
      if (spawnY == null) continue;

      const tierIndex = Math.min(this.sortedTierDepthIndices.length - 1, Math.floor(spawnY / ROWS_PER_TIER));
      const depthIndex = this.sortedTierDepthIndices[tierIndex];
      const spawnTable = this.cfg.monsterSpawnsByTier.get(depthIndex) ?? [];
      for (const entry of spawnTable) {
        if (Math.random() < entry.chance) {
          this.spawnMonster(entry.monsterId, x, spawnY);
          break;
        }
      }
    }
  }

  private monsterTextureKey(def: WorldMonsterDef): string {
    const key = `monster-${def.id}`;
    if (!this.textures.exists(key)) {
      const hue = (def.id * 67) % 360;
      const color = Phaser.Display.Color.HSLToColor(hue / 360, 0.6, 0.45).color;
      const g = this.add.graphics();
      g.fillStyle(color, 1);
      g.fillCircle(14, 14, 14);
      g.fillStyle(0x000000, 0.6);
      g.fillCircle(19, 10, 3);
      g.generateTexture(key, 28, 28);
      g.destroy();
    }
    return key;
  }

  /**
   * Crée l'entité Phaser d'un monstre — avec un vrai corps physique (gravité/collision) pour
   * l'hôte, qui seul simule réellement les monstres, ou en pur sprite visuel pour un client
   * non-hôte (dont la position est entièrement pilotée par `applyMonsterState`, jamais par une
   * physique locale qui divergerait de celle de l'hôte).
   */
  private createMonsterEntity(networkId: string, def: WorldMonsterDef, x: number, y: number, hp: number, withPhysics: boolean): LiveMonster {
    const rigged = def.rig?.parts?.length ? this.buildRiggedMonster(def, x, y, withPhysics) : null;
    if (rigged) {
      return {
        networkId, sprite: rigged.container, rigParts: rigged.rigParts, skills: rigged.skills,
        activePlayback: null, lastKnownX: x, def, hp, attackCooldownMs: 0,
        wanderDir: Math.random() < 0.5 ? -1 : 1, aiTimerMs: 0, flyDirX: 1, flyDirY: 0,
      };
    }

    const textureKey = this.monsterTextureKey(def);
    const sprite = withPhysics ? this.physics.add.sprite(x, y, textureKey) : this.add.sprite(x, y, textureKey);
    sprite.setOrigin(0.5, 1);
    // Icône réelle du catalogue (taille native arbitraire) vs rond procédural (déjà 28×28 natif) —
    // recadrée à taille constante en conservant les proportions, jamais étirée.
    if (def.iconUrl && this.textures.exists(textureKey)) {
      const src = sprite.width, srcH = sprite.height;
      const scale = Math.min(32 / src, 32 / srcH);
      sprite.setDisplaySize(src * scale, srcH * scale);
    }

    if (withPhysics) {
      const body = (sprite as Phaser.Physics.Arcade.Sprite).body as Phaser.Physics.Arcade.Body;
      body.setSize(24, 28);
      if (def.movementPatterns.includes('flying')) {
        body.setAllowGravity(false);
      } else {
        body.setGravityY(GRAVITY_Y);
        this.physics.add.collider(sprite as Phaser.Physics.Arcade.Sprite, this.layer);
      }
    }

    return {
      networkId, sprite, def, hp, attackCooldownMs: 0,
      wanderDir: Math.random() < 0.5 ? -1 : 1, aiTimerMs: 0, flyDirX: 1, flyDirY: 0,
    };
  }

  /**
   * Construit un monstre monté par pièces (cf. MonsterBuilderComponent/Monster.rig) — un Container
   * dont chaque pièce est un Sprite enfant positionné selon les coordonnées choisies par
   * glisser-déposer dans l'éditeur (centrées sur le centre du canevas d'édition, 0,0). `groundY`
   * ramène ces coordonnées au repère du jeu : le point le plus bas de l'ensemble des pièces devient
   * y=0 (le sol, cf. convention `setOrigin(0.5,1)` du sprite classique qu'il remplace) — sans ça le
   * montage flotterait ou s'enfoncerait selon la combinaison de pièces choisie. Origine (0.5,0)
   * uniforme sur toutes les pièces (même une qui ne tourne jamais) : une rotation de compétence
   * pivote alors toujours depuis le haut de la pièce (épaule/hanche), sans cas particulier par pièce.
   *
   * Une pièce dont la texture n'a pas pu charger (404, réseau — cf. preload()) est simplement omise
   * plutôt que de casser tout le montage. Si AUCUNE pièce n'a chargé, retourne null : l'appelant
   * retombe alors sur le sprite unique procédural, jamais un monstre invisible.
   */
  private buildRiggedMonster(def: WorldMonsterDef, x: number, y: number, withPhysics: boolean):
    { container: Phaser.GameObjects.Container; rigParts: RigPartInstance[]; skills: RigSkillRuntime[] } | null {
    const usable = (def.rig?.parts ?? [])
      .filter(part => this.textures.exists(rigPartKey(part.assetId)))
      .map(part => {
        const img = this.textures.get(rigPartKey(part.assetId)).getSourceImage();
        return { part, w: img.width, h: img.height };
      });
    if (usable.length === 0) return null;

    const groundY = Math.max(...usable.map(({ part, h }) => part.y + h / 2));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    const container = this.add.container(x, y);
    const rigParts: RigPartInstance[] = [];
    usable.forEach(({ part, w, h }, index) => {
      const baseY = part.y - groundY - h / 2;
      const restTextureKey = rigPartKey(part.assetId);
      const child = this.add.sprite(part.x, baseY, restTextureKey);
      child.setOrigin(0.5, 0);
      child.setFlipX(part.flip);
      container.add(child);
      rigParts.push({
        // Repli sur un id synthétique par position pour un montage sauvegardé avant l'introduction
        // de ce champ (cf. MonsterBuilderComponent.ngOnInit) — reste unique au sein de CE montage,
        // suffisant pour les clés de Map de tickRigPlayback même sans compétence pouvant s'y référer.
        id: part.id ?? `legacy-${index}`, obj: child, baseX: part.x, baseY, restTextureKey, width: w, height: h,
        isWeapon: !!part.isWeapon, collidesTerrain: !!part.collidesTerrain, terrainCooldownUntil: 0,
      });
      minX = Math.min(minX, part.x - w / 2); maxX = Math.max(maxX, part.x + w / 2);
      minY = Math.min(minY, baseY); maxY = Math.max(maxY, baseY + h);
    });

    if (withPhysics) {
      this.physics.add.existing(container);
      const body = container.body as Phaser.Physics.Arcade.Body;
      body.setSize(maxX - minX, maxY - minY);
      body.setOffset(minX, minY);
      if (def.movementPatterns.includes('flying')) {
        body.setAllowGravity(false);
      } else {
        body.setGravityY(GRAVITY_Y);
        this.physics.add.collider(container, this.layer);
      }
    }

    return { container, rigParts, skills: this.resolveSkills(def) };
  }

  /** Résout les compétences du montage (cf. WorldRigSkill) en remplaçant chaque image temporaire
   * par sa clé de texture préchargée — une image qui n'a pas pu charger dégrade silencieusement
   * l'étape correspondante à une simple pose sans image (jamais une erreur visible). */
  private resolveSkills(def: WorldMonsterDef): RigSkillRuntime[] {
    return (def.rig?.skills ?? []).map(skill => ({
      id: skill.id,
      type: skill.type,
      steps: skill.steps.map(step => ({
        durationMs: Math.max(1, step.durationMs),
        poses: new Map(Object.entries(step.poses).map(([partId, pose]) => [partId, {
          dx: pose.dx, dy: pose.dy, rotationDeg: pose.rotationDeg,
          tempTextureKey: pose.tempAssetId != null && this.textures.exists(rigPartKey(pose.tempAssetId))
            ? rigPartKey(pose.tempAssetId) : undefined,
        }])),
      })),
    }));
  }

  private static readonly REST_POSE: RigSkillPoseRuntime = { dx: 0, dy: 0, rotationDeg: 0 };

  private applyPoseToPart(part: RigPartInstance, pose: RigSkillPoseRuntime): void {
    part.obj.x = part.baseX + pose.dx;
    part.obj.y = part.baseY + pose.dy;
    part.obj.setAngle(pose.rotationDeg);
    part.obj.setTexture(pose.tempTextureKey ?? part.restTextureKey);
  }

  private lerpPose(from: RigSkillPoseRuntime, to: RigSkillPoseRuntime, t: number): RigSkillPoseRuntime {
    return {
      dx: from.dx + (to.dx - from.dx) * t,
      dy: from.dy + (to.dy - from.dy) * t,
      rotationDeg: from.rotationDeg + (to.rotationDeg - from.rotationDeg) * t,
      // L'image temporaire ne s'interpole pas — bascule nette à l'entrée de l'étape qui la porte
      // (cf. tickRigPlayback), on affiche celle de la CIBLE dès que l'étape en cours en a une.
      tempTextureKey: to.tempTextureKey,
    };
  }

  /**
   * Démarre la lecture d'une compétence sur un montage — capture la pose actuellement affichée de
   * chaque pièce comme point de départ de l'interpolation (jamais un saut brutal depuis le repos si
   * une autre compétence était déjà en cours). Une compétence en cours (loop ou non) est toujours
   * remplacée sans condition : la plus récemment déclenchée gagne.
   */
  private startSkillPlayback(m: LiveMonster, skill: RigSkillRuntime, loop: boolean): void {
    if (!m.rigParts || skill.steps.length === 0) return;
    const fromPoses = new Map<string, RigSkillPoseRuntime>();
    const prevStep = m.activePlayback?.skill.steps[m.activePlayback.stepIndex];
    for (const p of m.rigParts) {
      fromPoses.set(p.id, prevStep?.poses.get(p.id) ?? GameScene.REST_POSE);
    }
    m.activePlayback = { skill, loop, stepIndex: 0, stepStartMs: this.time.now, fromPoses };
  }

  private resetPartsToRest(m: LiveMonster): void {
    for (const p of m.rigParts ?? []) this.applyPoseToPart(p, GameScene.REST_POSE);
  }

  /**
   * Lit en continu la compétence active de chaque montage (cf. LiveMonster.activePlayback),
   * interpole chaque pièce entre la pose de départ de l'étape courante et sa pose cible, et
   * sélectionne la boucle idle/marche latérale d'après le déplacement RÉEL — mesuré par delta de
   * position (jamais body.velocity) pour donner le même résultat côté hôte (vraie physique) et
   * côté non-hôte (ne reçoit que des positions du réseau, cf. applyMonsterState). Le saut et
   * l'attaque/impact-bloc restent déclenchés ailleurs (tickMonsterAI/tickRigCollisions) via
   * startSkillPlayback — cette méthode ne fait qu'avancer la lecture, jamais la démarrer pour ces
   * trois types.
   */
  private tickRigPlayback(): void {
    const now = this.time.now;
    for (const m of this.liveMonsters) {
      if (!m.rigParts || !m.skills) continue;

      const dx = Math.abs(m.sprite.x - (m.lastKnownX ?? m.sprite.x));
      if (dx > RIG_MOVING_THRESHOLD_PX) m.lastMovedAtMs = now;
      m.lastKnownX = m.sprite.x;
      const moving = (now - (m.lastMovedAtMs ?? -Infinity)) < 300;

      if (!m.activePlayback || m.activePlayback.loop) {
        const desiredType = moving ? 'move-lateral' : 'idle';
        if (!m.activePlayback || m.activePlayback.skill.type !== desiredType) {
          const skill = m.skills.find(s => s.type === desiredType);
          if (skill) this.startSkillPlayback(m, skill, true);
          else { m.activePlayback = null; this.resetPartsToRest(m); }
        }
      }

      const playback = m.activePlayback;
      if (!playback) continue;
      const step = playback.skill.steps[playback.stepIndex];
      const t = Math.min(1, (now - playback.stepStartMs) / step.durationMs);

      for (const p of m.rigParts) {
        const from = playback.fromPoses.get(p.id) ?? GameScene.REST_POSE;
        const to = step.poses.get(p.id) ?? GameScene.REST_POSE;
        this.applyPoseToPart(p, this.lerpPose(from, to, t));
      }

      if (t >= 1) {
        const isLastStep = playback.stepIndex >= playback.skill.steps.length - 1;
        if (isLastStep && !playback.loop) {
          m.activePlayback = null;
          this.resetPartsToRest(m);
        } else {
          const nextFrom = new Map<string, RigSkillPoseRuntime>();
          for (const p of m.rigParts) nextFrom.set(p.id, step.poses.get(p.id) ?? GameScene.REST_POSE);
          playback.fromPoses = nextFrom;
          playback.stepIndex = isLastStep ? 0 : playback.stepIndex + 1;
          playback.stepStartMs = now;
        }
      }
    }
  }

  /**
   * Collisions PAR PIÈCE (pas seulement le monstre entier, déjà géré par le corps physique du
   * Container) — hôte uniquement, comme tout ce qui simule réellement les monstres (cf. docstring
   * de la classe). Deux familles de contact :
   *   - `collidesTerrain` : la pièce contre un block solide du terrain → joue la compétence
   *     'block-hit' si le monstre en a une (sinon rien : pas de réaction de secours).
   *   - `isWeapon` : la pièce contre un joueur → inflige TOUJOURS les dégâts du monstre
   *     (def.attackDamage/attackRate), et joue en plus la compétence 'attack' si elle existe — les
   *     dégâts ne dépendent jamais de la présence d'une chorégraphie, seulement du contact réel.
   * Simplification assumée (comme le reste du montage) : le recouvrement est testé sur la boîte
   * englobante non tournée de la pièce (getBounds), pas sa forme exacte après rotation — suffisant
   * à l'œil pour un battement de quelques degrés, jamais une hitbox pixel-perfect.
   */
  private tickRigCollisions(delta: number): void {
    if (!this.isHost) return;
    for (const m of this.liveMonsters) {
      if (!m.rigParts) continue;
      const hasWeapon = m.rigParts.some(p => p.isWeapon);
      if (hasWeapon) m.attackCooldownMs = Math.max(0, m.attackCooldownMs - delta);

      for (const p of m.rigParts) {
        if (!p.collidesTerrain && !p.isWeapon) continue;
        const bounds = p.obj.getBounds();

        if (p.collidesTerrain && this.time.now >= p.terrainCooldownUntil) {
          const corners: [number, number][] = [
            [bounds.left, bounds.top], [bounds.right, bounds.top],
            [bounds.left, bounds.bottom], [bounds.right, bounds.bottom],
          ];
          const hitsBlock = corners.some(([wx, wy]) => this.isSolidCollidableAt(Math.floor(wx / TILE_SIZE), Math.floor(wy / TILE_SIZE)));
          if (hitsBlock) {
            p.terrainCooldownUntil = this.time.now + RIG_TERRAIN_HIT_COOLDOWN_MS;
            const skill = m.skills?.find(s => s.type === 'block-hit');
            if (skill) this.startSkillPlayback(m, skill, false);
            continue;
          }
        }

        if (p.isWeapon && m.attackCooldownMs <= 0) {
          const candidates: { id: 'self' | string; x: number; y: number }[] = [
            { id: 'self', x: this.player.x, y: this.player.y },
            ...[...this.remotePlayerPositions.entries()].map(([id, pos]) => ({ id, ...pos })),
          ];
          const hit = candidates.find(c => Phaser.Geom.Rectangle.Overlaps(
            bounds, new Phaser.Geom.Rectangle(c.x - 11, c.y - 38, 22, 38),
          ));
          if (hit) {
            m.attackCooldownMs = 1000 / Math.max(m.def.attackRate, 0.1);
            if (hit.id === 'self') this.damagePlayer(m.def.attackDamage);
            else this.cfg.onNetworkSend?.({ type: 'player-damage', targetId: hit.id, damage: m.def.attackDamage });
            const skill = m.skills?.find(s => s.type === 'attack');
            if (skill) this.startSkillPlayback(m, skill, false);
          }
        }
      }
    }
  }

  private spawnMonster(monsterId: number, x: number, y: number): void {
    const def = this.cfg.monsters.get(monsterId);
    if (!def) return;
    const networkId = crypto.randomUUID();
    const worldX = x * TILE_SIZE + TILE_SIZE / 2;
    const worldY = (y + 1) * TILE_SIZE;
    const live = this.createMonsterEntity(networkId, def, worldX, worldY, def.hp, true);
    this.liveMonsters.push(live);
    this.cfg.onNetworkSend?.({ type: 'monster-spawn', monsterId: networkId, defId: def.id, x: worldX, y: worldY, hp: def.hp });
  }

  // ── Monstres : réception réseau (Lot 8b, clients non-hôtes) ───────────────

  applyMonsterSpawn(monsterId: string, defId: number, x: number, y: number, hp: number): void {
    if (this.liveMonsters.some(m => m.networkId === monsterId)) return;
    const def = this.cfg.monsters.get(defId);
    if (!def) return;
    this.liveMonsters.push(this.createMonsterEntity(monsterId, def, x, y, hp, false));
  }

  applyMonsterState(states: { monsterId: string; x: number; y: number; hp: number }[]): void {
    for (const s of states) {
      const m = this.liveMonsters.find(lm => lm.networkId === s.monsterId);
      if (!m) continue;
      m.sprite.setPosition(s.x, s.y);
      m.hp = s.hp;
    }
  }

  applyMonsterDeath(monsterId: string): void {
    const idx = this.liveMonsters.findIndex(m => m.networkId === monsterId);
    if (idx === -1) return;
    this.liveMonsters[idx].sprite.destroy();
    this.liveMonsters.splice(idx, 1);
  }

  /** Diffusion périodique (hôte uniquement) de la position/PV de tous les monstres vivants. */
  private tickMonsterBroadcast(delta: number): void {
    if (!this.isHost || !this.liveMonsters.length) return;
    this.monsterBroadcastAccum += delta;
    if (this.monsterBroadcastAccum < MONSTER_BROADCAST_INTERVAL_MS) return;
    this.monsterBroadcastAccum = 0;
    this.cfg.onNetworkSend?.({
      type: 'monster-state',
      monsters: this.liveMonsters.map(m => ({ monsterId: m.networkId, x: Math.round(m.sprite.x), y: Math.round(m.sprite.y), hp: m.hp })),
    });
  }

  // ── Monstres : IA ────────────────────────────────────────────────────────

  /** Le joueur (soi-même ou distant) le plus proche d'un point donné — l'IA de monstre (hôte
   * uniquement) cible celui-là, pas systématiquement le joueur local. */
  private nearestPlayerTo(worldX: number, worldY: number): { id: 'self' | string; x: number; y: number; distTiles: number } {
    let bestId: 'self' | string = 'self';
    let bestX = this.player.x;
    let bestY = this.player.y;
    let bestDist = Math.sqrt((worldX - bestX) ** 2 + (worldY - bestY) ** 2) / TILE_SIZE;
    for (const [id, pos] of this.remotePlayerPositions) {
      const d = Math.sqrt((worldX - pos.x) ** 2 + (worldY - pos.y) ** 2) / TILE_SIZE;
      if (d < bestDist) { bestDist = d; bestId = id; bestX = pos.x; bestY = pos.y; }
    }
    return { id: bestId, x: bestX, y: bestY, distTiles: bestDist };
  }

  private tickMonsterAI(delta: number): void {
    if (!this.isHost) return; // les monstres d'un non-hôte ne sont que des reflets de applyMonsterState
    for (const m of this.liveMonsters) {
      const body = m.sprite.body as Phaser.Physics.Arcade.Body;
      const patterns = m.def.movementPatterns;
      const nearest = this.nearestPlayerTo(m.sprite.x, m.sprite.y);
      const dx = nearest.x - m.sprite.x;
      const dy = nearest.y - m.sprite.y;
      const distTiles = nearest.distTiles;
      const detected = distTiles <= m.def.detectionRange;

      m.aiTimerMs -= delta;

      if (patterns.includes('flying')) {
        if (m.aiTimerMs <= 0) {
          if (detected && patterns.includes('chase')) { m.flyDirX = Math.sign(dx) || 1; m.flyDirY = Math.sign(dy) || 0; }
          else if (detected && patterns.includes('flee')) { m.flyDirX = -Math.sign(dx) || 1; m.flyDirY = -Math.sign(dy) || 0; }
          else { m.flyDirX = Math.random() < 0.5 ? -1 : 1; m.flyDirY = Math.random() < 0.5 ? -1 : 1; }
          m.aiTimerMs = 400 + Math.random() * 400;
        }
        const flySpeed = detected && (patterns.includes('chase') || patterns.includes('flee')) ? m.def.chaseSpeed : m.def.moveSpeed;
        body.setVelocity(m.flyDirX * flySpeed, m.flyDirY * flySpeed);
      } else {
        if (m.aiTimerMs <= 0 || (detected && (patterns.includes('chase') || patterns.includes('flee')))) {
          let dir = m.wanderDir;
          if (detected && patterns.includes('chase')) dir = (Math.sign(dx) || dir) as 1 | -1;
          else if (detected && patterns.includes('flee')) dir = (-Math.sign(dx) || dir) as 1 | -1;
          m.wanderDir = dir;
          m.aiTimerMs = detected ? 150 : 600 + Math.random() * 800;
        }
        const nextX = Math.floor((m.sprite.x + m.wanderDir * TILE_SIZE) / TILE_SIZE);
        const currentY = Math.floor(m.sprite.y / TILE_SIZE);
        const groundAhead = this.isSolidCollidableAt(nextX, currentY + 1);
        const wallAhead = this.isSolidCollidableAt(nextX, currentY) || this.isSolidCollidableAt(nextX, currentY - 1);
        if (!groundAhead || wallAhead) m.wanderDir = (m.wanderDir * -1) as 1 | -1;

        const onGround = body.blocked.down || body.touching.down;
        const speed = detected && patterns.includes('chase') ? m.def.chaseSpeed : m.def.moveSpeed;
        body.setVelocityX(m.wanderDir * speed);
        if (patterns.includes('jumping') && onGround && Math.random() < 0.02) {
          body.setVelocityY(-m.def.jumpStrength);
          const jumpSkill = m.skills?.find(s => s.type === 'jump');
          if (jumpSkill) this.startSkillPlayback(m, jumpSkill, false);
        }
      }

      // Un monstre avec au moins une pièce `isWeapon` dans son montage passe entièrement par le
      // contact réel de cette pièce (cf. tickRigCollisions) — le calcul par distance ci-dessous
      // resterait redondant (double dégâts) sinon. Un monstre sans montage, ou dont aucune pièce
      // n'est une arme, garde le comportement d'origine (Lot 6b), inchangé.
      const hasRigWeapon = m.rigParts?.some(p => p.isWeapon) ?? false;
      if (!hasRigWeapon && distTiles <= m.def.attackRangeTiles) {
        m.attackCooldownMs -= delta;
        if (m.attackCooldownMs <= 0) {
          m.attackCooldownMs = 1000 / Math.max(m.def.attackRate, 0.1);
          if (nearest.id === 'self') this.damagePlayer(m.def.attackDamage);
          else this.cfg.onNetworkSend?.({ type: 'player-damage', targetId: nearest.id, damage: m.def.attackDamage });
        }
      }
    }
  }

  // ── Inventaire ────────────────────────────────────────────────────────

  private addToInventory(itemId: number, qty: number): void {
    this.inventory.set(itemId, (this.inventory.get(itemId) ?? 0) + qty);
    this.emitInventory();
  }

  private removeFromInventory(itemId: number, qty: number): void {
    const next = Math.max(0, (this.inventory.get(itemId) ?? 0) - qty);
    if (next === 0) this.inventory.delete(itemId); else this.inventory.set(itemId, next);
    this.emitInventory();
  }

  private emitInventory(): void {
    const entries: InventoryEntry[] = [...this.inventory.entries()].map(([itemId, quantity]) => {
      const ref = this.cfg.itemsById.get(itemId);
      return {
        itemId,
        name: ref?.name ?? `#${itemId}`,
        iconUrl: ref?.iconUrl ?? null,
        category: ref?.category ?? '',
        quantity,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    this.cfg.onInventoryChange(entries);
  }
}
