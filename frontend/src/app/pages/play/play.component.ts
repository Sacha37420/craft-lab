import { Component, inject, NgZone, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import Phaser from 'phaser';
import { ApiService, GameMap } from '../../core/api.service';
import { colorForBlockId, TierRules } from '../../shared/world/terrain-generation';
import { GameScene } from './game-scene';
import { InventoryEntry, WorldBlockDef, WorldItemRef, WorldToolDef } from './world-types';

/**
 * Page Jouer (Lot 6a, cahier des charges § 3 et § 6) — génère un monde réel
 * à partir des règles de la carte choisie et le rend jouable (déplacement,
 * physique, minage, pose de blocks) via Phaser. Solo, en mémoire uniquement
 * — aucune sauvegarde (Lot 7) ni synchronisation multijoueur (Lot 8).
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
  miningProgress = signal<number | null>(null);
  miningBlockName = signal<string | null>(null);
  message = signal<string | null>(null);

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
        forkJoin(tiers.map(t => this.api.getDepthTierBlockRates(t.id!))).subscribe({
          next: rateLists => this.onRatesLoaded(tiers, rateLists),
          error: () => { this.error.set('Erreur lors du chargement des taux de blocks.'); this.loadingWorld.set(false); },
        });
      },
      error: () => { this.error.set('Erreur lors du chargement des paliers.'); this.loadingWorld.set(false); },
    });
  }

  private onRatesLoaded(
    tiers: { id?: number; depth_index: number; void_rate: number }[],
    rateLists: { block: number | null; block_name?: string; rate: number }[][],
  ): void {
    const blockIds = new Set<number>();
    rateLists.forEach(list => list.forEach(r => { if (r.block != null) blockIds.add(r.block); }));
    if (blockIds.size === 0) {
      this.error.set('Aucun bloc défini pour les paliers de cette carte — impossible de générer un monde.');
      this.loadingWorld.set(false);
      return;
    }

    forkJoin({
      blocks: this.api.getBlocks(),
      tools: this.api.getTools(),
      items: this.api.getItems(),
    }).subscribe({
      next: ({ blocks, tools, items }) => {
        const ids = [...blockIds];
        forkJoin(ids.map(id => this.api.getBlockDrops(id))).subscribe({
          next: dropLists => {
            const tierRules: TierRules[] = tiers.map((t, i) => ({
              depthIndex: t.depth_index,
              voidRate: t.void_rate,
              blockRates: rateLists[i]
                .filter(r => r.block != null)
                .map(r => ({
                  blockId: r.block as number, blockName: r.block_name ?? '',
                  color: colorForBlockId(r.block as number), rate: r.rate,
                })),
            }));

            const blockDefs = new Map<number, WorldBlockDef>();
            ids.forEach((id, i) => {
              const b = blocks.find(bl => bl.id === id);
              if (!b) return;
              const flow = (b.flow_behavior ?? {}) as Record<string, unknown>;
              const spreadChance = typeof flow['spread_chance'] === 'number' ? flow['spread_chance'] as number : 0.5;
              blockDefs.set(id, {
                id,
                name: b.name,
                color: colorForBlockId(id),
                hardness: b.hardness,
                isLiquid: b.is_liquid,
                flowSpreadChance: spreadChance,
                drops: dropLists[i]
                  .filter(d => d.dropped_item != null)
                  .map(d => ({ itemId: d.dropped_item as number, quantity: d.quantity, chance: d.chance })),
              });
            });

            const toolDefs: WorldToolDef[] = tools.map(t => ({ id: t.id!, name: t.name, power: t.power, speed: t.speed }));
            const itemsById = new Map<number, WorldItemRef>();
            items.forEach(it => itemsById.set(it.id, { id: it.id, name: it.name, category: it.category, iconUrl: it.icon_url ?? null }));

            this.loadingWorld.set(false);
            this.launchPhaser(tierRules, blockDefs, toolDefs, itemsById);
          },
          error: () => { this.error.set('Erreur lors du chargement des tables de drop.'); this.loadingWorld.set(false); },
        });
      },
      error: () => { this.error.set('Erreur lors du chargement du catalogue.'); this.loadingWorld.set(false); },
    });
  }

  private launchPhaser(
    tiers: TierRules[], blockDefs: Map<number, WorldBlockDef>, tools: WorldToolDef[], itemsById: Map<number, WorldItemRef>,
  ): void {
    this.destroyGame();
    this.inventory.set([]);
    this.selectedBlockId.set(null);
    this.miningProgress.set(null);
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
          onInventoryChange: entries => this.zone.run(() => this.inventory.set(entries)),
          onMiningProgress: (progress, blockName) => this.zone.run(() => {
            this.miningProgress.set(progress);
            this.miningBlockName.set(blockName);
          }),
          onMessage: text => this.zone.run(() => this.showMessage(text)),
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
    if (entry.category !== 'block') return;
    const next = this.selectedBlockId() === entry.itemId ? null : entry.itemId;
    this.selectedBlockId.set(next);
    this.scene?.setSelectedBlock(next);
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
