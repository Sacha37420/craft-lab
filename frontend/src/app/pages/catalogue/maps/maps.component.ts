import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PercentPipe } from '@angular/common';
import { forkJoin } from 'rxjs';
import {
  ApiService, CatalogueItem, CatalogueSuggestion, DepthTier, DepthTierBlockRate, DepthTierMonsterSpawn, GameMap, Monster,
} from '../../../core/api.service';
import { TerrainPreviewComponent } from './terrain-preview.component';
import {
  colorForBlockId, generateTerrainPreview, GeneratedCell, ROWS_PER_TIER, TierRules,
} from '../../../shared/world/terrain-generation';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';

const PREVIEW_WIDTH = 80;

/**
 * Cartes (cahier des charges 1.9) — une carte n'est pas un plan de blocks
 * mais un jeu de règles par palier de profondeur (DepthTier). L'aperçu de
 * génération (bruit 2D, cf. shared/world/terrain-generation.ts) sert à
 * vérifier à l'œil le critère d'acceptation du Lot 4 (filons cohérents
 * entre paliers adjacents) — c'est le même générateur qui produit le monde
 * réel joué (Lot 6, page Jouer), avec une largeur bien plus grande.
 */
@Component({
  selector: 'app-maps',
  standalone: true,
  imports: [FormsModule, PercentPipe, TerrainPreviewComponent, AiSuggestPanelComponent],
  templateUrl: './maps.component.html',
})
export class MapsComponent implements OnInit {
  protected api = inject(ApiService);

  items = signal<GameMap[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  showMapModal = signal(false);
  editingMap = signal<GameMap | null>(null);
  mapForm: Partial<GameMap> = {};

  showMapDetail = signal(false);
  mapDetail = signal<GameMap | null>(null);
  tiers = signal<DepthTier[]>([]);
  tierForm: Partial<DepthTier> = { depth_index: 0, void_rate: 0.5 };
  tierError = signal<string | null>(null);

  showTierDetail = signal(false);
  tierDetail = signal<DepthTier | null>(null);
  blockRates = signal<DepthTierBlockRate[]>([]);
  blockRateForm: DepthTierBlockRate = { block: null, rate: 0.1 };
  monsterSpawns = signal<DepthTierMonsterSpawn[]>([]);
  spawnForm: DepthTierMonsterSpawn = { monster: null, spawn_chance: 0.05 };

  blocks = signal<CatalogueItem[]>([]);
  monsters = signal<Monster[]>([]);

  previewSeed = 1;
  previewRows = signal<GeneratedCell[][] | null>(null);
  previewLoading = signal(false);
  previewError = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
    this.api.getItems('block').subscribe({ next: b => this.blocks.set(b) });
    this.api.getMonsters().subscribe({ next: m => this.monsters.set(m) });
  }

  load(): void {
    this.loading.set(true);
    this.api.getGameMaps().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  openCreate(): void {
    this.mapForm = { name: '', description: '' };
    this.editingMap.set(null);
    this.error.set(null);
    this.showMapModal.set(true);
  }

  openEdit(item: GameMap): void {
    this.mapForm = { ...item };
    this.editingMap.set(item);
    this.error.set(null);
    this.showMapModal.set(true);
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    this.mapForm = { ...this.mapForm, name: s.name, description: s.description };
  }

  saveMap(): void {
    const id = this.editingMap()?.id;
    const obs = id ? this.api.updateGameMap(id, this.mapForm) : this.api.createGameMap(this.mapForm);
    obs.subscribe({
      next: () => { this.showMapModal.set(false); this.load(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  deleteMap(item: GameMap): void {
    if (!confirm(`Supprimer la carte "${item.name}" (et tous ses paliers) ?`)) return;
    this.api.deleteGameMap(item.id!).subscribe({
      next: () => this.load(),
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  openMapDetail(item: GameMap): void {
    this.mapDetail.set(item);
    this.showMapDetail.set(true);
    this.previewRows.set(null);
    this.previewError.set(null);
    this.loadTiers();
  }

  loadTiers(): void {
    const id = this.mapDetail()?.id;
    if (!id) return;
    this.api.getDepthTiers(id).subscribe({ next: t => this.tiers.set(t) });
  }

  addTier(): void {
    const gameMap = this.mapDetail()?.id;
    if (!gameMap || this.tierForm.depth_index == null || this.tierForm.void_rate == null) return;
    this.tierError.set(null);
    this.api.createDepthTier({
      game_map: gameMap, depth_index: this.tierForm.depth_index, void_rate: this.tierForm.void_rate,
    }).subscribe({
      next: () => {
        this.tierForm = { depth_index: (this.tiers().length), void_rate: 0.5 };
        this.loadTiers();
      },
      error: err => this.tierError.set(err.error?.non_field_errors?.[0] ?? err.error?.depth_index?.[0] ?? `Erreur ${err.status}`),
    });
  }

  deleteTier(tier: DepthTier): void {
    if (!confirm(`Supprimer le palier ${tier.depth_index} ?`)) return;
    this.api.deleteDepthTier(tier.id!).subscribe({ next: () => this.loadTiers() });
  }

  openTierDetail(tier: DepthTier): void {
    this.tierDetail.set(tier);
    this.showTierDetail.set(true);
    this.loadBlockRates();
    this.loadMonsterSpawns();
  }

  loadBlockRates(): void {
    const id = this.tierDetail()?.id;
    if (!id) return;
    this.api.getDepthTierBlockRates(id).subscribe({ next: r => this.blockRates.set(r) });
  }

  addBlockRate(): void {
    const id = this.tierDetail()?.id;
    if (!id || !this.blockRateForm.block) return;
    this.api.addDepthTierBlockRate(id, this.blockRateForm).subscribe({
      next: () => { this.blockRateForm = { block: null, rate: 0.1 }; this.loadBlockRates(); },
    });
  }

  removeBlockRate(rateId: number): void {
    const id = this.tierDetail()?.id;
    if (!id) return;
    this.api.removeDepthTierBlockRate(id, rateId).subscribe({ next: () => this.loadBlockRates() });
  }

  loadMonsterSpawns(): void {
    const id = this.tierDetail()?.id;
    if (!id) return;
    this.api.getDepthTierMonsterSpawns(id).subscribe({ next: s => this.monsterSpawns.set(s) });
  }

  addMonsterSpawn(): void {
    const id = this.tierDetail()?.id;
    if (!id || !this.spawnForm.monster) return;
    this.api.addDepthTierMonsterSpawn(id, this.spawnForm).subscribe({
      next: () => { this.spawnForm = { monster: null, spawn_chance: 0.05 }; this.loadMonsterSpawns(); },
    });
  }

  removeMonsterSpawn(spawnId: number): void {
    const id = this.tierDetail()?.id;
    if (!id) return;
    this.api.removeDepthTierMonsterSpawn(id, spawnId).subscribe({ next: () => this.loadMonsterSpawns() });
  }

  generatePreview(): void {
    const mapId = this.mapDetail()?.id;
    if (!mapId) return;
    const currentTiers = this.tiers();
    if (currentTiers.length === 0) {
      this.previewError.set('Ajoutez au moins un palier avant de générer un aperçu.');
      return;
    }
    this.previewLoading.set(true);
    this.previewError.set(null);
    forkJoin(currentTiers.map(t => this.api.getDepthTierBlockRates(t.id!))).subscribe({
      next: rateLists => {
        const rules: TierRules[] = currentTiers.map((tier, i) => ({
          depthIndex: tier.depth_index,
          voidRate: tier.void_rate,
          blockRates: rateLists[i]
            .filter(r => r.block != null)
            .map(r => ({
              blockId: r.block as number,
              blockName: r.block_name ?? '',
              color: colorForBlockId(r.block as number),
              rate: r.rate,
            })),
        }));
        this.previewRows.set(generateTerrainPreview(this.previewSeed || 1, PREVIEW_WIDTH, rules, ROWS_PER_TIER));
        this.previewLoading.set(false);
      },
      error: () => {
        this.previewError.set('Erreur lors du chargement des taux de blocks.');
        this.previewLoading.set(false);
      },
    });
  }

  close(): void {
    this.showMapModal.set(false);
    this.showMapDetail.set(false);
    this.showTierDetail.set(false);
  }

  closeTierDetail(): void {
    this.showTierDetail.set(false);
  }
}
