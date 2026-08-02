import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { JsonPipe, PercentPipe } from '@angular/common';
import {
  ApiService, CatalogueItem, CatalogueSuggestion, Monster, MonsterDrop, MonsterSkill,
} from '../../../core/api.service';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';
import { AiImagePanelComponent } from '../../../shared/ai-image-panel/ai-image-panel.component';

const ATTACK_TYPES: { value: Monster['attack_type']; label: string }[] = [
  { value: 'melee', label: 'Corps à corps' },
  { value: 'ranged', label: 'À distance' },
  { value: 'magic', label: 'Magique' },
];

const MOVEMENT_PATTERNS: { value: string; label: string }[] = [
  { value: 'ground', label: 'Au sol' },
  { value: 'flying', label: 'Vol' },
  { value: 'jumping', label: 'Saut' },
  { value: 'chase', label: 'Poursuite' },
  { value: 'flee', label: 'Fuite' },
];

/** Monstres (cahier des charges 1.8) — pas un Item : pas de recette, mais mêmes patrons enfants (skills/drops/icône). */
@Component({
  selector: 'app-monsters',
  standalone: true,
  imports: [FormsModule, JsonPipe, PercentPipe, AiSuggestPanelComponent, AiImagePanelComponent],
  templateUrl: './monsters.component.html',
})
export class MonstersComponent implements OnInit {
  protected api = inject(ApiService);

  readonly attackTypes = ATTACK_TYPES;
  readonly movementPatterns = MOVEMENT_PATTERNS;

  items = signal<Monster[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  showDetail = signal(false);
  editing = signal<Monster | null>(null);
  detail = signal<Monster | null>(null);

  form: Partial<Monster> = {};

  skills = signal<MonsterSkill[]>([]);
  skillForm: MonsterSkill = { name: '', description: '', parameters: {} };
  skillParamsText = '{}';
  skillError = signal<string | null>(null);

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
  }

  openCreate(): void {
    this.form = {
      name: '', description: '', level: 1, hp: 10, detection_range: 10, attack_type: 'melee',
      attack_damage: 1, attack_rate: 1, movement_patterns: [],
    };
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Monster): void {
    this.form = { ...item, movement_patterns: [...(item.movement_patterns ?? [])] };
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  toggleMovement(pattern: string): void {
    const current = this.form.movement_patterns ?? [];
    this.form.movement_patterns = current.includes(pattern)
      ? current.filter(p => p !== pattern)
      : [...current, pattern];
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

  onIconApplied(): void {
    this.load();
    const id = this.detail()?.id;
    if (id) this.api.getMonsters().subscribe({ next: items => this.detail.set(items.find(m => m.id === id) ?? null) });
  }

  imagePromptSeed(item: Monster): string {
    return item.description ? `${item.name} : ${item.description}` : item.name;
  }

  openDetail(item: Monster): void {
    this.detail.set(item);
    this.showDetail.set(true);
    this.loadSkills();
    this.loadDrops();
    this.refreshLookups();
  }

  loadSkills(): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.getMonsterSkills(id).subscribe({ next: s => this.skills.set(s) });
  }

  addSkill(): void {
    const id = this.detail()?.id;
    if (!id || !this.skillForm.name.trim()) return;
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(this.skillParamsText || '{}');
    } catch {
      this.skillError.set('Paramètres : JSON invalide.');
      return;
    }
    this.skillError.set(null);
    this.api.addMonsterSkill(id, { ...this.skillForm, parameters }).subscribe({
      next: () => { this.skillForm = { name: '', description: '', parameters: {} }; this.skillParamsText = '{}'; this.loadSkills(); },
    });
  }

  removeSkill(skillId: number): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.removeMonsterSkill(id, skillId).subscribe({ next: () => this.loadSkills() });
  }

  loadDrops(): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.getMonsterDrops(id).subscribe({ next: d => this.drops.set(d) });
  }

  addDrop(): void {
    const id = this.detail()?.id;
    if (!id || !this.dropForm.dropped_item) return;
    this.api.addMonsterDrop(id, this.dropForm).subscribe({
      next: () => { this.dropForm = { dropped_item: null, quantity: 1, chance: 1 }; this.loadDrops(); },
    });
  }

  removeDrop(dropId: number): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.removeMonsterDrop(id, dropId).subscribe({ next: () => this.loadDrops() });
  }

  save(): void {
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateMonster(id, this.form)
      : this.api.createMonster(this.form);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); },
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

  close(): void { this.showModal.set(false); this.showDetail.set(false); }
}
