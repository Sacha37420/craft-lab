import Phaser from 'phaser';
import {
  generateTerrainPreview, GeneratedCell, ROWS_PER_TIER, TierRules,
} from '../../shared/world/terrain-generation';
import { InventoryEntry, WorldBlockDef, WorldItemRef, WorldToolDef } from './world-types';

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

export interface GameSceneConfig {
  seed: number;
  tiers: TierRules[];
  blockDefs: Map<number, WorldBlockDef>;
  tools: WorldToolDef[];
  itemsById: Map<number, WorldItemRef>;
  onInventoryChange: (entries: InventoryEntry[]) => void;
  onMiningProgress: (progress: number | null, blockName: string | null) => void;
  onMessage: (text: string) => void;
}

interface TileXY { x: number; y: number; }

/**
 * Simulation + rendu du monde jouable (Lot 6a). Ne parle jamais à l'API —
 * reçoit tout ce dont elle a besoin en config depuis PlayComponent (déjà
 * résolu depuis le catalogue) et ne fait que simuler/rendre localement, en
 * mémoire, sans aucune persistance (conforme à la portée du Lot 6a : "jouable
 * en local, sans persistance ni multijoueur" — cf. to_do_craft_lab.md § 6).
 */
export class GameScene extends Phaser.Scene {
  private readonly cfg: GameSceneConfig;

  private grid!: GeneratedCell[][];
  private worldHeight = 0;

  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasdKeys!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };

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

  constructor(config: GameSceneConfig) {
    super('game');
    this.cfg = config;
  }

  create(): void {
    this.grid = generateTerrainPreview(this.cfg.seed, WORLD_WIDTH, this.cfg.tiers, ROWS_PER_TIER);
    this.worldHeight = this.grid.length;

    this.buildTilemap();
    this.spawnPlayer();
    this.setupInput();
    this.setupCamera();
    this.seedLiquidFrontier();
    this.giveStarterTools();
  }

  override update(_time: number, delta: number): void {
    this.handleMovement();
    this.handleMining(delta);
    this.tickLiquids(delta);
  }

  /** Appelé depuis PlayComponent quand l'utilisateur sélectionne (ou désélectionne) un block de l'inventaire à poser. */
  setSelectedBlock(itemId: number | null): void {
    this.selectedPlaceBlockId = itemId;
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
      ctx.fillStyle = def.color;
      ctx.fillRect(i * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE);
      ctx.strokeStyle = def.isLiquid ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      ctx.strokeRect(i * TILE_SIZE + 1, 1, TILE_SIZE - 2, TILE_SIZE - 2);
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
    const spawn = this.findSpawn();

    if (!this.textures.exists('player')) {
      const g = this.add.graphics();
      g.fillStyle(0xffcc66, 1);
      g.fillRect(0, 0, 22, 38);
      g.fillStyle(0x222222, 1);
      g.fillRect(13, 8, 5, 5);
      g.generateTexture('player', 22, 38);
      g.destroy();
    }

    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player');
    this.player.setOrigin(0.5, 1);
    this.player.setCollideWorldBounds(true);
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setSize(20, 36);
    body.setGravityY(GRAVITY_Y);

    this.physics.add.collider(this.player, this.layer);
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
    // Aucune autre voie d'acquisition d'outil au Lot 6a (le craft arrive au 6b) :
    // le joueur démarre avec le meilleur outil de chaque type déjà présent au catalogue,
    // en attendant un vrai système de personnage/kit de départ (Lot 7).
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
  }

  private setCellBlock(x: number, y: number, blockId: number): void {
    const def = this.cfg.blockDefs.get(blockId)!;
    this.grid[y][x] = { kind: 'block', blockId, blockName: def.name, color: def.color };
    this.layer.putTileAt(this.tileIndexByBlockId.get(blockId)!, x, y);
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

  private withinReach(tx: number, ty: number): boolean {
    const px = Math.floor(this.player.x / TILE_SIZE);
    const py = Math.floor(this.player.y / TILE_SIZE);
    const dx = tx - px;
    const dy = ty - py;
    return Math.sqrt(dx * dx + dy * dy) <= REACH_TILES;
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

  private handleMining(delta: number): void {
    const pointer = this.input.activePointer;
    if (!pointer.leftButtonDown()) { this.cancelMining(); return; }

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
