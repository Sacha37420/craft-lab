import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe } from '@angular/common';
import { Artifact, ArtifactEffect, ApiService, CatalogueItem } from '../../../core/api.service';
import { RecipeEditorComponent } from '../../../shared/recipe-editor/recipe-editor.component';

const EFFECT_TYPES: { value: string; label: string }[] = [
  { value: 'hp_boost', label: 'PV' },
  { value: 'mp_boost', label: 'PM' },
  { value: 'armor_boost', label: 'Armure' },
  { value: 'damage_boost', label: 'Dégâts' },
  { value: 'projectile_economy', label: 'Consommation de projectiles' },
  { value: 'immunity', label: 'Immunité' },
  { value: 'double_jump_flight', label: 'Double saut / vol' },
  { value: 'weapon_effect', label: 'Effet ajouté aux armes' },
];

/**
 * Artefacts (cahier des charges 1.4) — pas d'effet posable, mais une liste
 * d'effets cumulables (ArtifactEffect : type + paramètres JSON libres, cf.
 * api/models.py côté backend pour la structure indicative par type).
 */
@Component({
  selector: 'app-artifacts',
  standalone: true,
  imports: [FormsModule, JsonPipe, RecipeEditorComponent],
  templateUrl: './artifacts.component.html',
})
export class ArtifactsComponent implements OnInit {
  private api = inject(ApiService);

  readonly effectTypes = EFFECT_TYPES;

  items = signal<Artifact[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  showDetail = signal(false);
  editing = signal<Artifact | null>(null);
  detail = signal<Artifact | null>(null);

  form: Partial<Artifact> = {};

  effects = signal<ArtifactEffect[]>([]);
  effectForm: { effect_type: string; parametersText: string } = { effect_type: 'hp_boost', parametersText: '{}' };
  effectError = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
    this.refreshLookups();
  }

  load(): void {
    this.loading.set(true);
    this.api.getArtifacts().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  /** `allItems` alimente le sélecteur d'ingrédient de la recette — cf. BlocksComponent.refreshLookups. */
  refreshLookups(): void {
    this.api.getItems().subscribe({ next: i => this.allItems.set(i) });
  }

  openCreate(): void {
    this.form = { name: '', description: '' };
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Artifact): void {
    this.form = { ...item };
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  openDetail(item: Artifact): void {
    this.detail.set(item);
    this.showDetail.set(true);
    this.loadEffects();
    this.refreshLookups();
  }

  loadEffects(): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.getArtifactEffects(id).subscribe({ next: e => this.effects.set(e) });
  }

  addEffect(): void {
    const id = this.detail()?.id;
    if (!id) return;
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(this.effectForm.parametersText || '{}');
    } catch {
      this.effectError.set('Paramètres : JSON invalide.');
      return;
    }
    this.effectError.set(null);
    this.api.addArtifactEffect(id, { effect_type: this.effectForm.effect_type, parameters }).subscribe({
      next: () => { this.effectForm = { effect_type: 'hp_boost', parametersText: '{}' }; this.loadEffects(); },
    });
  }

  removeEffect(effectId: number): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.removeArtifactEffect(id, effectId).subscribe({ next: () => this.loadEffects() });
  }

  save(): void {
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateArtifact(id, this.form)
      : this.api.createArtifact(this.form);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Artifact): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteArtifact(item.id!).subscribe({
      next: () => { this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); this.showDetail.set(false); }
}
