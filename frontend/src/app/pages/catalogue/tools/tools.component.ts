import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CatalogueItem, CatalogueSuggestion, Tool } from '../../../core/api.service';
import { RecipeEditorComponent } from '../../../shared/recipe-editor/recipe-editor.component';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';
import { AiImagePanelComponent } from '../../../shared/ai-image-panel/ai-image-panel.component';
import { describeToolForPrompt } from '../../../shared/image-prompt';

/** Outils (cahier des charges 1.5) — hache et pioche : puissance + vitesse de cassage. */
@Component({
  selector: 'app-tools',
  standalone: true,
  imports: [FormsModule, RecipeEditorComponent, AiSuggestPanelComponent, AiImagePanelComponent],
  templateUrl: './tools.component.html',
})
export class ToolsComponent implements OnInit {
  protected api = inject(ApiService);

  items = signal<Tool[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  showDetail = signal(false);
  editing = signal<Tool | null>(null);
  detail = signal<Tool | null>(null);

  form: Partial<Tool> = {};

  ngOnInit(): void {
    this.load();
    this.refreshLookups();
  }

  load(): void {
    this.loading.set(true);
    this.api.getTools().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  /**
   * `allItems` alimente le sélecteur d'ingrédient de la recette — rafraîchi
   * après chaque mutation, sinon un objet tout juste créé ailleurs
   * n'apparaît pas avant un rechargement complet de la page.
   */
  refreshLookups(): void {
    this.api.getItems().subscribe({ next: i => this.allItems.set(i) });
  }

  openCreate(): void {
    this.form = { name: '', description: '', tool_type: 'pickaxe', power: 1, speed: 1 };
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Tool): void {
    this.form = { ...item };
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  openDetail(item: Tool): void {
    this.detail.set(item);
    this.showDetail.set(true);
    this.refreshLookups();
  }

  imagePromptSeed(item: Tool): string {
    return describeToolForPrompt(item);
  }

  onIconApplied(): void {
    this.load();
    const id = this.detail()?.id;
    if (id) this.api.getEntity<Tool>('tools', id).subscribe({ next: t => this.detail.set(t) });
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    this.form = {
      ...this.form,
      name: s.name,
      description: s.description,
      tool_type: (s['tool_type'] as Tool['tool_type']) ?? this.form.tool_type,
      power: typeof s['power'] === 'number' ? s['power'] as number : this.form.power,
      speed: typeof s['speed'] === 'number' ? s['speed'] as number : this.form.speed,
    };
  }

  save(): void {
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateTool(id, this.form)
      : this.api.createTool(this.form);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Tool): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteTool(item.id!).subscribe({
      next: () => { this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); this.showDetail.set(false); }
}
