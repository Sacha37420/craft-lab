import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CatalogueItem, CatalogueSuggestion, Projectile } from '../../../core/api.service';
import { RecipeEditorComponent } from '../../../shared/recipe-editor/recipe-editor.component';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';

/**
 * Projectiles (cahier des charges 1.3) — utilisés par les armes à distance ;
 * `effects` (statut, zone...) reste un JSON libre à ce stade, cf. modèle
 * backend (structure fine laissée ouverte à l'usage).
 */
@Component({
  selector: 'app-projectiles',
  standalone: true,
  imports: [FormsModule, RecipeEditorComponent, AiSuggestPanelComponent],
  templateUrl: './projectiles.component.html',
})
export class ProjectilesComponent implements OnInit {
  private api = inject(ApiService);

  items = signal<Projectile[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  showDetail = signal(false);
  editing = signal<Projectile | null>(null);
  detail = signal<Projectile | null>(null);

  form: Partial<Projectile> = {};
  effectsText = '[]';

  ngOnInit(): void {
    this.load();
    this.refreshLookups();
  }

  load(): void {
    this.loading.set(true);
    this.api.getProjectiles().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  /** `allItems` alimente le sélecteur d'ingrédient de la recette — cf. BlocksComponent.refreshLookups. */
  refreshLookups(): void {
    this.api.getItems().subscribe({ next: i => this.allItems.set(i) });
  }

  openCreate(): void {
    this.form = { name: '', description: '', damage: 0 };
    this.effectsText = '[]';
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Projectile): void {
    this.form = { ...item };
    this.effectsText = JSON.stringify(item.effects ?? [], null, 2);
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  openDetail(item: Projectile): void {
    this.detail.set(item);
    this.showDetail.set(true);
    this.refreshLookups();
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    this.form = {
      ...this.form,
      name: s.name,
      description: s.description,
      damage: typeof s['damage'] === 'number' ? s['damage'] as number : this.form.damage,
    };
  }

  save(): void {
    let effects: unknown[];
    try {
      effects = JSON.parse(this.effectsText || '[]');
    } catch {
      this.error.set('Effets : JSON invalide.');
      return;
    }
    const payload = { ...this.form, effects };
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateProjectile(id, payload)
      : this.api.createProjectile(payload);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Projectile): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteProjectile(item.id!).subscribe({
      next: () => { this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); this.showDetail.set(false); }
}
