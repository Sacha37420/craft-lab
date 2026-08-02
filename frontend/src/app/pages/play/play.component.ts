import { Component, inject, NgZone, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import Phaser from 'phaser';
import {
  Artifact, ApiService, Block, CatalogueCategoryPath, DepthTier, DepthTierBlockRate,
  DepthTierMonsterSpawn, GameMap, Monster, Projectile, RecipeIngredient, Tool, Weapon,
} from '../../core/api.service';
import { colorForBlockId, TierRules } from '../../shared/world/terrain-generation';
import { GameScene } from './game-scene';
import {
  InventoryEntry, WorldBlockDef, WorldItemRef, WorldMonsterDef, WorldMonsterSpawnRate,
  WorldRecipe, WorldToolDef, WorldWeaponDef,
} from './world-types';

/**
 * Page Jouer (cahier des charges § 3 et § 6) — génère un monde réel à partir
 * des règles de la carte choisie et le rend jouable (déplacement, physique,
 * minage/pose de blocks, monstres, combat, craft) via Phaser. Solo, en
 * mémoire uniquement — aucune sauvegarde (Lot 7) ni synchronisation
 * multijoueur (Lot 8).
 */
@Component({
  selector: 'app-play',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './play.component.html',
})
export class PlayComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private zone = inject(NgZone);

  maps = signal<GameMap[]>([]);
  loadingMaps = signal(true);
  loadingWorld = signal(false);
  error = signal<string | null>(null);

  selectedMapId: number | null = null;
  seed = 1;

  playing = signal(false);
  inventory = signal<InventoryEntry[]>([]);
  selectedBlockId = signal<number | null>(null);
  equippedWeaponId = signal<number | null>(null);
  miningProgress = signal<number | null>(null);
  miningBlockName = signal<string | null>(null);
  message = signal<string | null>(null);
  hp = signal(100);
  maxHp = signal(100);

  showCraft = signal(false);
  recipes: WorldRecipe[] = [];

  private game: Phaser.Game | null = null;
  private scene: GameScene | null = null;
  private messageTimeout?: ReturnType<typeof setTimeout>;
  private pendingLaunchTimeout?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    this.api.getGameMaps().subscribe({
      next: maps => { this.maps.set(maps); this.loadingMaps.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loadingMaps.set(false); },
    });
  }

  ngOnDestroy(): void {
    this.destroyGame();
  }

  mapById(id: number): GameMap {
    return this.maps().find(m => m.id === id)!;
  }

  startGame(map: GameMap): void {
    this.error.set(null);
    this.loadingWorld.set(true);

    this.api.getDepthTiers(map.id!).subscribe({
      next: tiers => {
        if (tiers.length === 0) {
          this.error.set('Cette carte n\'a aucun palier de profondeur — ajoutez-en depuis la page Cartes avant de jouer.');
          this.loadingWorld.set(false);
          return;
        }
        forkJoin({
          blockRates: forkJoin(tiers.map(t => this.api.getDepthTierBlockRates(t.id!))),
          monsterSpawns: forkJoin(tiers.map(t => this.api.getDepthTierMonsterSpawns(t.id!))),
        }).subscribe({
          next: ({ blockRates, monsterSpawns }) => this.onRatesLoaded(tiers, blockRates, monsterSpawns),
          error: () => { this.error.set('Erreur lors du chargement des taux de blocks/monstres.'); this.loadingWorld.set(false); },
        });
      },
      error: () => { this.error.set('Erreur lors du chargement des paliers.'); this.loadingWorld.set(false); },
    });
  }

  private onRatesLoaded(
    tiers: DepthTier[], blockRateLists: DepthTierBlockRate[][], monsterSpawnLists: DepthTierMonsterSpawn[][],
  ): void {
    const blockIds = new Set<number>();
    blockRateLists.forEach(list => list.forEach(r => { if (r.block != null) blockIds.add(r.block); }));
    if (blockIds.size === 0) {
      this.error.set('Aucun bloc défini pour les paliers de cette carte — impossible de générer un monde.');
      this.loadingWorld.set(false);
      return;
    }
    const monsterIds = new Set<number>();
    monsterSpawnLists.forEach(list => list.forEach(s => { if (s.monster != null) monsterIds.add(s.monster); }));

    forkJoin({
      blocks: this.api.getBlocks(),
      tools: this.api.getTools(),
      items: this.api.getItems(),
      monsters: this.api.getMonsters(),
      weapons: this.api.getWeapons(),
      projectiles: this.api.getProjectiles(),
      artifacts: this.api.getArtifacts(),
    }).subscribe({
      next: catalog => this.onCatalogLoaded(tiers, blockRateLists, monsterSpawnLists, [...blockIds], [...monsterIds], catalog),
      error: () => { this.error.set('Erreur lors du chargement du catalogue.'); this.loadingWorld.set(false); },
    });
  }

  private onCatalogLoaded(
    tiers: DepthTier[], blockRateLists: DepthTierBlockRate[][], monsterSpawnLists: DepthTierMonsterSpawn[][],
    blockIds: number[], monsterIds: number[],
    catalog: {
      blocks: Block[]; tools: Tool[]; items: { id: number; name: string; category: string; icon_url?: string | null }[];
      monsters: Monster[]; weapons: Weapon[]; projectiles: Projectile[]; artifacts: Artifact[];
    },
  ): void {
    forkJoin({
      blockDrops: forkJoin(blockIds.map(id => this.api.getBlockDrops(id))),
      monsterDrops: forkJoin(monsterIds.map(id => this.api.getMonsterDrops(id))),
    }).subscribe({
      next: ({ blockDrops, monsterDrops }) => this.onDropsLoaded(
        tiers, blockRateLists, monsterSpawnLists, blockIds, monsterIds, catalog, blockDrops, monsterDrops,
      ),
      error: () => { this.error.set('Erreur lors du chargement des tables de drop.'); this.loadingWorld.set(false); },
    });
  }

  private onDropsLoaded(
    tiers: DepthTier[], blockRateLists: DepthTierBlockRate[][], monsterSpawnLists: DepthTierMonsterSpawn[][],
    blockIds: number[], monsterIds: number[],
    catalog: {
      blocks: Block[]; tools: Tool[]; items: { id: number; name: string; category: string; icon_url?: string | null }[];
      monsters: Monster[]; weapons: Weapon[]; projectiles: Projectile[]; artifacts: Artifact[];
    },
    blockDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    monsterDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
  ): void {
    // Recette potentielle pour tout objet des 5 catégories craftables (1.1) — le craft n'est pas
    // limité aux blocks/outils utilisés dans cette carte, tout le catalogue reste fabricable.
    const recipeTargets: { category: CatalogueCategoryPath; id: number; name: string }[] = [
      ...catalog.weapons.map(w => ({ category: 'weapons' as const, id: w.id!, name: w.name })),
      ...catalog.projectiles.map(p => ({ category: 'projectiles' as const, id: p.id!, name: p.name })),
      ...catalog.artifacts.map(a => ({ category: 'artifacts' as const, id: a.id!, name: a.name })),
      ...catalog.tools.map(t => ({ category: 'tools' as const, id: t.id!, name: t.name })),
      ...catalog.blocks.map(b => ({ category: 'blocks' as const, id: b.id!, name: b.name })),
    ];
    forkJoin(recipeTargets.map(t => this.api.getRecipe(t.category, t.id))).subscribe({
      next: recipeLists => this.onRecipesLoaded(
        tiers, blockRateLists, monsterSpawnLists, blockIds, monsterIds, catalog,
        blockDropLists, monsterDropLists, recipeTargets, recipeLists,
      ),
      error: () => { this.error.set('Erreur lors du chargement des recettes.'); this.loadingWorld.set(false); },
    });
  }

  private onRecipesLoaded(
    tiers: DepthTier[], blockRateLists: DepthTierBlockRate[][], monsterSpawnLists: DepthTierMonsterSpawn[][],
    blockIds: number[], monsterIds: number[],
    catalog: {
      blocks: Block[]; tools: Tool[]; items: { id: number; name: string; category: string; icon_url?: string | null }[];
      monsters: Monster[]; weapons: Weapon[]; projectiles: Projectile[]; artifacts: Artifact[];
    },
    blockDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    monsterDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    recipeTargets: { category: CatalogueCategoryPath; id: number; name: string }[],
    recipeLists: RecipeIngredient[][],
  ): void {
    const tierRules: TierRules[] = tiers.map((t, i) => ({
      depthIndex: t.depth_index,
      voidRate: t.void_rate,
      blockRates: blockRateLists[i]
        .filter(r => r.block != null)
        .map(r => ({
          blockId: r.block as number, blockName: r.block_name ?? '',
          color: colorForBlockId(r.block as number), rate: r.rate,
        })),
    }));

    const blockDefs = new Map<number, WorldBlockDef>();
    blockIds.forEach((id, i) => {
      const b = catalog.blocks.find(bl => bl.id === id);
      if (!b) return;
      const flow = (b.flow_behavior ?? {}) as Record<string, unknown>;
      const spreadChance = typeof flow['spread_chance'] === 'number' ? flow['spread_chance'] as number : 0.5;
      blockDefs.set(id, {
        id, name: b.name, color: colorForBlockId(id), hardness: b.hardness, isLiquid: b.is_liquid,
        flowSpreadChance: spreadChance,
        drops: blockDropLists[i]
          .filter(d => d.dropped_item != null)
          .map(d => ({ itemId: d.dropped_item as number, quantity: d.quantity, chance: d.chance })),
      });
    });

    const toolDefs: WorldToolDef[] = catalog.tools.map(t => ({ id: t.id!, name: t.name, power: t.power, speed: t.speed }));

    const itemsById = new Map<number, WorldItemRef>();
    catalog.items.forEach(it => itemsById.set(it.id, { id: it.id, name: it.name, category: it.category, iconUrl: it.icon_url ?? null }));

    const monsterDefs = new Map<number, WorldMonsterDef>();
    monsterIds.forEach((id, i) => {
      const m = catalog.monsters.find(mo => mo.id === id);
      if (!m) return;
      monsterDefs.set(id, {
        id, name: m.name, hp: m.hp, detectionRange: m.detection_range, attackType: m.attack_type,
        attackDamage: m.attack_damage, attackRate: m.attack_rate, movementPatterns: m.movement_patterns,
        drops: monsterDropLists[i]
          .filter(d => d.dropped_item != null)
          .map(d => ({ itemId: d.dropped_item as number, quantity: d.quantity, chance: d.chance })),
      });
    });

    const monsterSpawnsByTier = new Map<number, WorldMonsterSpawnRate[]>();
    tiers.forEach((t, i) => {
      monsterSpawnsByTier.set(t.depth_index, monsterSpawnLists[i]
        .filter(s => s.monster != null)
        .map(s => ({ monsterId: s.monster as number, chance: s.spawn_chance })));
    });

    const weaponDefs: WorldWeaponDef[] = catalog.weapons.map(w => ({
      id: w.id!, name: w.name, style: w.style, damage: w.damage, attackRange: w.attack_range, attackRate: w.attack_rate,
    }));

    const recipes: WorldRecipe[] = recipeTargets
      .map((target, i) => ({ target, ingredients: recipeLists[i] ?? [] }))
      .filter(({ ingredients }) => ingredients.length > 0)
      .map(({ target, ingredients }) => ({
        itemId: target.id,
        itemName: target.name,
        ingredients: ingredients.map(ing => ({ itemId: ing.ingredient!, quantity: ing.quantity })),
      }));
    this.recipes = recipes;

    this.loadingWorld.set(false);
    this.launchPhaser(tierRules, blockDefs, toolDefs, itemsById, monsterDefs, monsterSpawnsByTier, weaponDefs);
  }

  private launchPhaser(
    tiers: TierRules[], blockDefs: Map<number, WorldBlockDef>, tools: WorldToolDef[], itemsById: Map<number, WorldItemRef>,
    monsters: Map<number, WorldMonsterDef>, monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>, weapons: WorldWeaponDef[],
  ): void {
    this.destroyGame();
    this.inventory.set([]);
    this.selectedBlockId.set(null);
    this.equippedWeaponId.set(null);
    this.miningProgress.set(null);
    this.showCraft.set(false);
    // Le conteneur #phaser-container n'existe dans le DOM qu'une fois `playing`
    // passé à true (bloc @if du template) — Phaser résout son `parent` par id
    // dès la construction de Phaser.Game, donc il faut laisser Angular rendre
    // le div avant de l'appeler, sous peine d'un fallback silencieux vers
    // document.body (aucune erreur, juste un canvas qui n'apparaît jamais là
    // où l'overlay l'attend).
    this.playing.set(true);

    this.pendingLaunchTimeout = setTimeout(() => {
      this.zone.runOutsideAngular(() => {
        this.scene = new GameScene({
          seed: this.seed || 1,
          tiers,
          blockDefs,
          tools,
          itemsById,
          monsters,
          monsterSpawnsByTier,
          weapons,
          recipes: this.recipes,
          onInventoryChange: entries => this.zone.run(() => this.inventory.set(entries)),
          onMiningProgress: (progress, blockName) => this.zone.run(() => {
            this.miningProgress.set(progress);
            this.miningBlockName.set(blockName);
          }),
          onMessage: text => this.zone.run(() => this.showMessage(text)),
          onHpChange: (hp, maxHp) => this.zone.run(() => { this.hp.set(hp); this.maxHp.set(maxHp); }),
        });
        this.game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: 'phaser-container',
          width: 960,
          height: 560,
          backgroundColor: '#1b2430',
          physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
          scene: [this.scene],
        });
      });
    }, 0);
  }

  selectInventoryItem(entry: InventoryEntry): void {
    if (entry.category === 'block') {
      const next = this.selectedBlockId() === entry.itemId ? null : entry.itemId;
      this.selectedBlockId.set(next);
      this.scene?.setSelectedBlock(next);
    } else if (entry.category === 'weapon') {
      const next = this.equippedWeaponId() === entry.itemId ? null : entry.itemId;
      this.equippedWeaponId.set(next);
      this.scene?.setEquippedWeapon(next);
    }
  }

  craftableRecipes(): (WorldRecipe & { canCraft: boolean; ingredientLabel: string })[] {
    const inv = this.inventory();
    const nameOf = (id: number) => inv.find(e => e.itemId === id)?.name ?? `#${id}`;
    const qtyOf = (id: number) => inv.find(e => e.itemId === id)?.quantity ?? 0;
    return this.recipes.map(r => ({
      ...r,
      canCraft: r.ingredients.every(ing => qtyOf(ing.itemId) >= ing.quantity),
      ingredientLabel: r.ingredients.map(ing => `${ing.quantity}× ${nameOf(ing.itemId)} (${qtyOf(ing.itemId)} dispo)`).join(', '),
    }));
  }

  craft(itemId: number): void {
    this.scene?.craftItem(itemId);
  }

  toggleCraft(): void {
    this.showCraft.update(v => !v);
  }

  quit(): void {
    this.destroyGame();
  }

  private destroyGame(): void {
    if (this.pendingLaunchTimeout) { clearTimeout(this.pendingLaunchTimeout); this.pendingLaunchTimeout = undefined; }
    if (this.game) { this.game.destroy(true); this.game = null; }
    this.scene = null;
    this.playing.set(false);
  }

  private showMessage(text: string): void {
    this.message.set(text);
    if (this.messageTimeout) clearTimeout(this.messageTimeout);
    this.messageTimeout = setTimeout(() => this.message.set(null), 3000);
  }
}
