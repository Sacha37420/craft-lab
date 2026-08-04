import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, SpriteAsset, SpriteAssetCategory } from '../../../core/api.service';

/** Libellés FR des 8 catégories (Lot 10, cf. SpriteAsset côté backend) — source unique
 * pour le select de filtre, le select du formulaire d'upload et le badge de catégorie. */
const CATEGORY_LABELS: Record<SpriteAssetCategory, string> = {
  'block': 'Block',
  'character': 'Personnage',
  'monster-creature': 'Monstre (assemblé)',
  'monster-part': 'Pièce de monstre',
  'weapon': 'Arme',
  'tool': 'Outil',
  'effect': 'Effet',
  'other': 'Autre',
};
const CATEGORIES = Object.keys(CATEGORY_LABELS) as SpriteAssetCategory[];

/**
 * Bibliothèque d'assets centralisée (Lot 10) — pas un Item du catalogue : un SpriteAsset
 * n'a ni recette ni stats, juste une image (bundlée CC0, générée IA ou uploadée ici) que les
 * autres pages du catalogue référencent. Cette page ne fait qu'uploader/lister/supprimer ces
 * images ; le modèle et l'API sont déjà en place côté backend (voir api.service.ts).
 */
@Component({
  selector: 'app-bibliotheque',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './bibliotheque.component.html',
})
export class BibliothequeComponent implements OnInit {
  protected api = inject(ApiService);

  readonly categories = CATEGORIES;
  readonly categoryLabels = CATEGORY_LABELS;

  assets = signal<SpriteAsset[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  categoryFilter: SpriteAssetCategory | '' = '';
  searchText = '';

  showModal = signal(false);
  uploading = signal(false);
  newName = '';
  newCategory: SpriteAssetCategory = 'block';
  newSlotHint = '';
  newTags = '';
  selectedFile: File | null = null;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.getSpriteAssets({
      category: this.categoryFilter || undefined,
      search: this.searchText || undefined,
    }).subscribe({
      next: assets => { this.assets.set(assets); this.loading.set(false); },
      error: err => { this.error.set(err.error?.detail ?? `Erreur ${err.status}`); this.loading.set(false); },
    });
  }

  openCreate(): void {
    this.newName = '';
    this.newCategory = 'block';
    this.newSlotHint = '';
    this.newTags = '';
    this.selectedFile = null;
    this.error.set(null);
    this.showModal.set(true);
  }

  close(): void { this.showModal.set(false); }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.selectedFile = input.files?.[0] ?? null;
  }

  upload(): void {
    if (!this.selectedFile) { this.error.set('Un fichier est requis.'); return; }
    const tags = this.newTags.split(',').map(t => t.trim()).filter(Boolean);
    this.uploading.set(true);
    this.api.createSpriteAssetFromFile(this.newName, this.newCategory, this.newSlotHint, tags, this.selectedFile).subscribe({
      next: () => { this.uploading.set(false); this.showModal.set(false); this.load(); },
      error: err => { this.uploading.set(false); this.error.set(err.error?.detail ?? `Erreur ${err.status}`); },
    });
  }

  delete(asset: SpriteAsset): void {
    if (!confirm(`Supprimer le sprite "${asset.name}" ?`)) return;
    this.api.deleteSpriteAsset(asset.id).subscribe({
      next: () => this.load(),
      error: err => this.error.set(err.error?.detail ?? `Erreur ${err.status}`),
    });
  }

  /** Couleur de badge par source — même logique que le badge "Généré"/"Craft seul" des blocks :
   * vert pour ce qui vient de l'IA, gris pour les valeurs de base (bundle CC0), orange pour
   * distinguer visuellement l'ajout manuel (upload) des deux autres. */
  sourceBadgeClass(asset: SpriteAsset): string {
    switch (asset.source) {
      case 'ai-generated': return 'badge badge-green';
      case 'upload': return 'badge badge-orange';
      default: return 'badge badge-grey';
    }
  }

  sourceLabel(asset: SpriteAsset): string {
    switch (asset.source) {
      case 'ai-generated': return 'IA';
      case 'upload': return 'Upload';
      default: return 'CC0';
    }
  }
}
