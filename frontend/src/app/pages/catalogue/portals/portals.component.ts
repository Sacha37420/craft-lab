import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CatalogueItem, CatalogueSuggestion, GameMap, Portal } from '../../../core/api.service';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';

/**
 * Portails (cahier des charges 1.10) — pas un Item : pas de recette, pas
 * d'icône (l'assistant image ne couvre qu'objets/blocks/monstres, cf.
 * PortalSerializer côté backend), juste un cadre de blocks (frame_pattern)
 * et une carte de destination. Le cadre ne supporte pour l'instant qu'une
 * forme rectangulaire d'un seul type de block (cf. Portal.frame_pattern,
 * backend/api/models.py) — pas de mélange de blocks sur un même cadre.
 */
@Component({
  selector: 'app-portals',
  standalone: true,
  imports: [FormsModule, AiSuggestPanelComponent],
  templateUrl: './portals.component.html',
})
export class PortalsComponent implements OnInit {
  protected api = inject(ApiService);

  items = signal<Portal[]>([]);
  gameMaps = signal<GameMap[]>([]);
  blocks = signal<CatalogueItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  showModal = signal(false);
  editing = signal<Portal | null>(null);
  form: Partial<Portal> = {};
  frameWidth = 2;
  frameHeight = 3;
  frameBlock: number | null = null;

  ngOnInit(): void {
    this.load();
    this.api.getGameMaps().subscribe({ next: m => this.gameMaps.set(m) });
    this.api.getItems('block').subscribe({ next: b => this.blocks.set(b) });
  }

  load(): void {
    this.loading.set(true);
    this.api.getPortals().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  openCreate(): void {
    this.form = { name: '', description: '', destination_map: null };
    this.frameWidth = 2;
    this.frameHeight = 3;
    this.frameBlock = null;
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Portal): void {
    this.form = { ...item };
    this.frameWidth = item.frame_pattern?.width ?? 2;
    this.frameHeight = item.frame_pattern?.height ?? 3;
    this.frameBlock = item.frame_pattern?.block ?? null;
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    this.form = { ...this.form, name: s.name, description: s.description };
  }

  save(): void {
    const payload: Partial<Portal> = {
      ...this.form,
      frame_pattern: { shape: 'frame', width: this.frameWidth, height: this.frameHeight, block: this.frameBlock },
    };
    const id = this.editing()?.id;
    const obs = id ? this.api.updatePortal(id, payload) : this.api.createPortal(payload);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Portal): void {
    if (!confirm(`Supprimer le portail "${item.name}" ?`)) return;
    this.api.deletePortal(item.id!).subscribe({
      next: () => this.load(),
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); }
}
