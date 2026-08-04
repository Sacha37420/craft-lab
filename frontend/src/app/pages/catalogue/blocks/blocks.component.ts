import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PercentPipe } from '@angular/common';
import { ApiService, Block, BlockDrop, CatalogueItem, CatalogueSuggestion, StatusEffect } from '../../../core/api.service';
import { RecipeEditorComponent } from '../../../shared/recipe-editor/recipe-editor.component';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';
import { AiImagePanelComponent } from '../../../shared/ai-image-panel/ai-image-panel.component';
import { describeBlockForPrompt } from '../../../shared/image-prompt';

/**
 * Blocks de base et liquides (cahier des charges 1.6/1.7) — un seul modèle :
 * `is_generated` (apparaît dans la génération de terrain) et `is_liquid`
 * (écoulement + effet de contact) sont des flags, pas des catégories séparées.
 */
@Component({
  selector: 'app-blocks',
  standalone: true,
  imports: [FormsModule, PercentPipe, RecipeEditorComponent, AiSuggestPanelComponent, AiImagePanelComponent],
  templateUrl: './blocks.component.html',
})
export class BlocksComponent implements OnInit {
  protected api = inject(ApiService);

  items = signal<Block[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  statusEffects = signal<StatusEffect[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  showDetail = signal(false);
  editing = signal<Block | null>(null);
  detail = signal<Block | null>(null);

  form: Partial<Block> = {};
  flowBehaviorText = '{}';

  drops = signal<BlockDrop[]>([]);
  dropForm: BlockDrop = { dropped_item: null, quantity: 1, chance: 1 };

  ngOnInit(): void {
    this.load();
    this.refreshLookups();
  }

  load(): void {
    this.loading.set(true);
    this.api.getBlocks().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  /**
   * `allItems`/`statusEffects` alimentent des sélecteurs inter-catégories
   * (ingrédient de recette, objet dropé, effet de contact) — rafraîchis après
   * chaque mutation sur cette page, sinon un objet tout juste créé (ex. un
   * autre block) n'apparaît dans aucun sélecteur avant un rechargement complet.
   */
  refreshLookups(): void {
    this.api.getItems().subscribe({ next: i => this.allItems.set(i) });
    this.api.getStatusEffects().subscribe({ next: s => this.statusEffects.set(s) });
  }

  openCreate(): void {
    this.form = {
      name: '', description: '', is_generated: false, is_liquid: false,
      hardness: 1, contact_status_effect: null,
    };
    this.flowBehaviorText = '{}';
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Block): void {
    this.form = { ...item };
    this.flowBehaviorText = JSON.stringify(item.flow_behavior ?? {}, null, 2);
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    this.form = {
      ...this.form,
      name: s.name,
      description: s.description,
      hardness: typeof s['hardness'] === 'number' ? s['hardness'] as number : this.form.hardness,
    };
  }

  openDetail(item: Block): void {
    this.detail.set(item);
    this.showDetail.set(true);
    this.loadDrops();
    this.refreshLookups();
  }

  imagePromptSeed(item: Block): string {
    return describeBlockForPrompt(item);
  }

  onIconApplied(): void {
    this.load();
    const id = this.detail()?.id;
    if (id) this.api.getEntity<Block>('blocks', id).subscribe({ next: b => this.detail.set(b) });
  }

  loadDrops(): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.getBlockDrops(id).subscribe({ next: d => this.drops.set(d) });
  }

  addDrop(): void {
    const id = this.detail()?.id;
    if (!id || !this.dropForm.dropped_item) return;
    this.api.addBlockDrop(id, this.dropForm).subscribe({
      next: () => { this.dropForm = { dropped_item: null, quantity: 1, chance: 1 }; this.loadDrops(); },
    });
  }

  removeDrop(dropId: number): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.removeBlockDrop(id, dropId).subscribe({ next: () => this.loadDrops() });
  }

  save(): void {
    let flow_behavior: Record<string, unknown> = {};
    if (this.form.is_liquid) {
      try {
        flow_behavior = JSON.parse(this.flowBehaviorText || '{}');
      } catch {
        this.error.set('Comportement d\'écoulement : JSON invalide.');
        return;
      }
    }
    const payload = { ...this.form, flow_behavior };
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateBlock(id, payload)
      : this.api.createBlock(payload);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Block): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteBlock(item.id!).subscribe({
      next: () => { this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); this.showDetail.set(false); }
}
