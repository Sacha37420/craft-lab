import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CatalogueItem, CatalogueSuggestion, Weapon, WeaponProjectileLink } from '../../../core/api.service';
import { RecipeEditorComponent } from '../../../shared/recipe-editor/recipe-editor.component';
import { AiSuggestPanelComponent } from '../../../shared/ai-suggest-panel/ai-suggest-panel.component';

/** Armes (cahier des charges 1.2) — sous-catégories mêlée/distance/magique/invocation. */
@Component({
  selector: 'app-weapons',
  standalone: true,
  imports: [FormsModule, RecipeEditorComponent, AiSuggestPanelComponent],
  templateUrl: './weapons.component.html',
})
export class WeaponsComponent implements OnInit {
  private api = inject(ApiService);

  items = signal<Weapon[]>([]);
  allItems = signal<CatalogueItem[]>([]);
  projectileItems = signal<CatalogueItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);
  showModal = signal(false);
  showDetail = signal(false);
  editing = signal<Weapon | null>(null);
  detail = signal<Weapon | null>(null);

  form: Partial<Weapon> = {};

  links = signal<WeaponProjectileLink[]>([]);
  linkForm: WeaponProjectileLink = { projectile: null, consumption_per_shot: 1 };

  ngOnInit(): void {
    this.load();
    this.refreshLookups();
  }

  load(): void {
    this.loading.set(true);
    this.api.getWeapons().subscribe({
      next: items => { this.items.set(items); this.loading.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  /**
   * `allItems` (recette) et `projectileItems` (armes à distance) — rafraîchis
   * après chaque mutation, cf. BlocksComponent.refreshLookups.
   */
  refreshLookups(): void {
    this.api.getItems().subscribe({ next: i => this.allItems.set(i) });
    this.api.getItems('projectile').subscribe({ next: i => this.projectileItems.set(i) });
  }

  openCreate(): void {
    this.form = { name: '', description: '', style: 'melee', damage: 0, attack_range: null, attack_rate: null };
    this.editing.set(null);
    this.error.set(null);
    this.showModal.set(true);
  }

  openEdit(item: Weapon): void {
    this.form = { ...item };
    this.editing.set(item);
    this.error.set(null);
    this.showModal.set(true);
  }

  onAiSuggestion(s: CatalogueSuggestion): void {
    const style = s['style'] as Weapon['style'] | undefined;
    this.form = {
      ...this.form,
      name: s.name,
      description: s.description,
      style: style ?? this.form.style,
      damage: typeof s['damage'] === 'number' ? s['damage'] as number : this.form.damage,
      attack_range: typeof s['attack_range'] === 'number' ? s['attack_range'] as number : this.form.attack_range,
      attack_rate: typeof s['attack_rate'] === 'number' ? s['attack_rate'] as number : this.form.attack_rate,
    };
  }

  openDetail(item: Weapon): void {
    this.detail.set(item);
    this.showDetail.set(true);
    this.loadLinks();
    this.refreshLookups();
  }

  loadLinks(): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.getWeaponProjectiles(id).subscribe({ next: l => this.links.set(l) });
  }

  addLink(): void {
    const id = this.detail()?.id;
    if (!id || !this.linkForm.projectile) return;
    this.api.addWeaponProjectile(id, this.linkForm).subscribe({
      next: () => { this.linkForm = { projectile: null, consumption_per_shot: 1 }; this.loadLinks(); },
    });
  }

  removeLink(linkId: number): void {
    const id = this.detail()?.id;
    if (!id) return;
    this.api.removeWeaponProjectile(id, linkId).subscribe({ next: () => this.loadLinks() });
  }

  save(): void {
    const id = this.editing()?.id;
    const obs = id
      ? this.api.updateWeapon(id, this.form)
      : this.api.createWeapon(this.form);
    obs.subscribe({
      next: () => { this.showModal.set(false); this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.name?.[0] ?? `Erreur ${err.status}`),
    });
  }

  delete(item: Weapon): void {
    if (!confirm(`Supprimer "${item.name}" ?`)) return;
    this.api.deleteWeapon(item.id!).subscribe({
      next: () => { this.load(); this.refreshLookups(); },
      error: err => this.error.set(err.error?.[0] ?? `Erreur ${err.status}`),
    });
  }

  close(): void { this.showModal.set(false); this.showDetail.set(false); }
}
