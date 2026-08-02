import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, StatusEffect } from '../../../core/api.service';

/**
 * Effets de statut (poison, feu, gel...) — liste extensible référencée par
 * ArtifactEffect (immunité, 1.4.6) et Block (effet de contact d'un liquide,
 * 1.7). Pas de recette ni d'enfants : la page CRUD la plus simple du Lot 1.
 */
@Component({
  selector: 'app-status-effects',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './status-effects.component.html',
})
export class StatusEffectsComponent implements OnInit {
  private api = inject(ApiService);

  items = signal<StatusEffect[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  editing = signal<StatusEffect | null>(null);

  form: StatusEffect = { code: '', name: '', description: '' };

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.getStatusEffects().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  openCreate(): void {
    this.form = { code: '', name: '', description: '' };
    this.editing.set(null);
    this.showModal.set(true);
  }

  openEdit(item: StatusEffect): void {
    this.form = { ...item };
    this.editing.set(item);
    this.showModal.set(true);
  }

  save(): void {
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateStatusEffect(id, this.form)
      : this.api.createStatusEffect(this.form);
    obs.subscribe({ next: () => { this.showModal.set(false); this.load(); } });
  }

  delete(item: StatusEffect): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteStatusEffect(item.id!).subscribe({
      next: () => this.load(),
      error: err => this.error.set(err.error?.detail ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); }
}
