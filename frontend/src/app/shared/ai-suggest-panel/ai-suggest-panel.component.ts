import { Component, EventEmitter, inject, input, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, AIProvider, CatalogueSuggestion, ItemCategory } from '../../core/api.service';

/**
 * Bouton « Suggérer avec l'IA » + aperçu de la proposition, réutilisé sur les
 * 5 pages d'édition du catalogue (Lot 2, cahier des charges section 2).
 * N'applique jamais rien tout seul au formulaire — la page parente reçoit la
 * suggestion via `(apply)` et décide quoi en faire, l'utilisateur garde la
 * main pour éditer/annuler avant d'enregistrer (même principe que
 * l'assistant de robot-lab : proposer, jamais persister directement).
 */
@Component({
  selector: 'app-ai-suggest-panel',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './ai-suggest-panel.component.html',
})
export class AiSuggestPanelComponent {
  private api = inject(ApiService);

  category = input.required<ItemCategory>();
  partial = input<Record<string, unknown>>({});

  @Output() apply = new EventEmitter<CatalogueSuggestion>();

  provider: AIProvider = 'claude';
  loading = signal(false);
  error = signal<string | null>(null);
  needsConfig = signal(false);
  suggestion = signal<CatalogueSuggestion | null>(null);

  suggest(): void {
    this.loading.set(true);
    this.error.set(null);
    this.needsConfig.set(false);
    this.suggestion.set(null);
    this.api.suggestCatalogueEntity(this.category(), this.provider, this.partial()).subscribe({
      next: s => { this.suggestion.set(s); this.loading.set(false); },
      error: err => {
        this.loading.set(false);
        this.needsConfig.set(err.status === 409);
        this.error.set(err.error?.detail ?? `Erreur ${err.status}`);
      },
    });
  }

  applySuggestion(): void {
    const s = this.suggestion();
    if (!s) return;
    this.apply.emit(s);
    this.suggestion.set(null);
  }

  dismiss(): void {
    this.suggestion.set(null);
  }
}
