import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PercentPipe } from '@angular/common';
import {
  ApiService, CatalogueItem, CatalogueSuggestion, Monster, MonsterDrop, Projectile,
} from '../../../core/api.service';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';
import { AiImagePanelComponent } from '../../../shared/ai-image-panel/ai-image-panel.component';
import { MonsterBuilderComponent } from '../../../shared/monster-builder/monster-builder.component';
import { describeMonsterForPrompt } from '../../../shared/image-prompt';

const ATTACK_TYPES: { value: Monster['attack_type']; label: string }[] = [
  { value: 'melee', label: 'Corps à corps' },
  { value: 'ranged', label: 'À distance' },
  { value: 'magic', label: 'Magique' },
];

/**
 * Monstres (cahier des charges 1.8) — pas un Item : pas de recette, mais mêmes patrons enfants
 * (drops/icône). Une SEULE modale pour tout (stats, icône, montage/compétences, drops) — avant,
 * "Modifier" (stats) et "Compétences/Drops" (icône, montage, drops) étaient deux vues séparées
 * sans raison, l'une ignorant l'existence de l'autre. Icône/montage/drops n'apparaissent qu'une
 * fois le monstre créé (besoin d'un id réel) — la création reste donc en deux temps (créer d'abord
 * les stats, puis la modale reste ouverte pour tout le reste) plutôt qu'un formulaire géant.
 */
@Component({
  selector: 'app-monsters',
  standalone: true,
  imports: [FormsModule, PercentPipe, AiSuggestPanelComponent, AiImagePanelComponent, MonsterBuilderComponent],
  templateUrl: './monsters.component.html',
})
export class MonstersComponent implements OnInit {
  protected api = inject(ApiService);

  readonly attackTypes = ATTACK_TYPES;

  items = signal<Monster[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  projectiles = signal<Projectile[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  editing = signal<Monster | null>(null);

  form: Partial<Monster> = {};

  drops = signal<MonsterDrop[]>([]);
  dropForm: MonsterDrop = { dropped_item: null, quantity: 1, chance: 1 };

  ngOnInit(): void {
    this.load();
    this.refreshLookups();
  }

  load(): void {
    this.loading.set(true);
    this.api.getMonsters().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  refreshLookups(): void {
    this.api.getItems().subscribe({ next: i => this.allItems.set(i) });
    this.api.getProjectiles().subscribe({ next: p => this.projectiles.set(p) });
  }

  openCreate(): void {
    this.form = {
      name: '', description: '', level: 1, hp: 10, detection_range: 10, attack_type: 'melee',
      attack_damage: 1, attack_rate: 1, projectile: null, movement_patterns: [],
    };
    this.editing.set(null);
    this.drops.set([]);
    this.error.set(null);
    this.showModal.set(true);
  }

  open(item: Monster): void {
    this.form = { ...item };
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
    this.loadDrops();
    this.refreshLookups();
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    this.form = {
      ...this.form,
      name: s.name,
      description: s.description,
      level: typeof s['level'] === 'number' ? s['level'] as number : this.form.level,
      hp: typeof s['hp'] === 'number' ? s['hp'] as number : this.form.hp,
      detection_range: typeof s['detection_range'] === 'number' ? s['detection_range'] as number : this.form.detection_range,
      attack_type: (s['attack_type'] as Monster['attack_type']) ?? this.form.attack_type,
      attack_damage: typeof s['attack_damage'] === 'number' ? s['attack_damage'] as number : this.form.attack_damage,
      attack_rate: typeof s['attack_rate'] === 'number' ? s['attack_rate'] as number : this.form.attack_rate,
    };
  }

  /** Rafraîchit `editing` (icône/rig/déplacement/attaque modifiés par le panneau icône ou le
   * compositeur) sans fermer la modale — l'utilisateur continue d'y travailler après. */
  onIconApplied(): void {
    this.load();
    const id = this.editing()?.id;
    if (id) this.api.getMonsters().subscribe({ next: items => this.editing.set(items.find(m => m.id === id) ?? null) });
  }

  imagePromptSeed(item: Monster): string {
    return describeMonsterForPrompt(item);
  }

  loadDrops(): void {
    const id = this.editing()?.id;
    if (!id) return;
    this.api.getMonsterDrops(id).subscribe({ next: d => this.drops.set(d) });
  }

  addDrop(): void {
    const id = this.editing()?.id;
    if (!id || !this.dropForm.dropped_item) return;
    this.api.addMonsterDrop(id, this.dropForm).subscribe({
      next: () => { this.dropForm = { dropped_item: null, quantity: 1, chance: 1 }; this.loadDrops(); },
    });
  }

  removeDrop(dropId: number): void {
    const id = this.editing()?.id;
    if (!id) return;
    this.api.removeMonsterDrop(id, dropId).subscribe({ next: () => this.loadDrops() });
  }

  /** Ne ferme plus la modale (avant : fermeture automatique après "Modifier") — sur une création,
   * bascule directement en mode édition dans la MÊME modale pour donner accès à l'icône/au montage
   * sans avoir à rouvrir quoi que ce soit. */
  save(): void {
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateMonster(id, this.form)
      : this.api.createMonster(this.form);
    obs.subscribe({
      next: created => { this.editing.set(created); this.load(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Monster): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteMonster(item.id!).subscribe({
      next: () => this.load(),
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); }
}
