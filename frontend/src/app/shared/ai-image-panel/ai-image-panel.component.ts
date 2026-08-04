import { Component, EventEmitter, inject, input, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  ApiService, CatalogueCategoryPath, GeneratedImage, ImageProvider, SpriteAsset, SpriteAssetCategory,
} from '../../core/api.service';

/** Libellés d'affichage des catégories de la bibliothèque partagée (Lot 10) — 'monster-part' en est
 * délibérément exclu ici : une pièce de montage n'a pas de sens comme icône plate d'un objet du
 * catalogue, cf. MonsterBuilderComponent pour sa consommation dédiée. */
const LIBRARY_CATEGORIES: { key: SpriteAssetCategory; label: string }[] = [
  { key: 'block', label: 'Blocks / matériaux' },
  { key: 'character', label: 'Personnage (poses)' },
  { key: 'monster-creature', label: 'Monstres (déjà assemblés)' },
  { key: 'weapon', label: 'Armes' },
  { key: 'tool', label: 'Outils' },
  { key: 'effect', label: 'Effets / attaques (boules de feu, magie, étincelles...)' },
];

interface SpriteLibraryCategoryGroup {
  key: SpriteAssetCategory;
  label: string;
  items: SpriteAsset[];
}

/**
 * Icône/texture d'une entité du catalogue (Lot 3, cahier des charges
 * section 2) — réutilisé sur les 5 pages d'édition. Quatre façons d'obtenir
 * une image, jamais mélangées :
 *   1. `generate()` — un fournisseur configuré (Gemini/Mistral/OpenAI)
 *      produit une prévisualisation ; rien n'est écrit dans storage à cette
 *      étape.
 *   2. `copyPrompt()` — l'utilisateur préfère produire l'image ailleurs
 *      (un autre outil IA, un dessin...) : le prompt suggéré (avec les
 *      éléments de cohérence visuelle) est copiable tel quel.
 *   3. `uploadFile()` — upload manuel direct du fichier obtenu par 2., ou de
 *      n'importe quelle image locale.
 *   4. `pickFromLibrary()` — bibliothèque d'assets partagée (SpriteAsset, Lot 10) : le pack CC0
 *      embarqué au départ (voir LICENSE.txt sous assets/sprite-library/) ET tout contenu contribué
 *      depuis par un utilisateur (upload, icône de monstre générée/uploadée — cf.
 *      MonsterViewSet.icon) — blocks, personnage, monstres assemblés, armes, outils, effets ('pièce
 *      de monstre' délibérément exclu, cf. LIBRARY_CATEGORIES). Techniquement un cas particulier de
 *      3. — l'image choisie est récupérée via ApiService.spriteAssetUrl() (statique ou storage
 *      selon l'origine, jamais reconstruite ici) puis envoyée par le même chemin d'upload manuel.
 * `useImage()` (issu de 1.) est le seul chemin qui upload une image générée
 * en interne — jamais automatique, jamais avant ce clic explicite (cf.
 * cahier des charges : « ne jamais écraser l'image existante avant
 * validation explicite »).
 */
@Component({
  selector: 'app-ai-image-panel',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './ai-image-panel.component.html',
})
export class AiImagePanelComponent implements OnInit {
  private api = inject(ApiService);

  category = input.required<CatalogueCategoryPath>();
  itemId = input.required<number>();
  currentIconUrl = input<string | null | undefined>(null);
  promptSeed = input<string>('');

  @Output() applied = new EventEmitter<void>();

  provider: ImageProvider = 'gemini';
  prompt = '';
  loading = signal(false);
  applying = signal(false);
  uploading = signal(false);
  error = signal<string | null>(null);
  needsConfig = signal(false);
  image = signal<GeneratedImage | null>(null);
  copied = signal(false);

  showLibrary = signal(false);
  libraryCategories = signal<SpriteLibraryCategoryGroup[]>([]);
  libraryLoading = signal(false);
  libraryError = signal<string | null>(null);
  pickingId = signal<number | null>(null);
  openCategory = signal<string | null>(null);

  ngOnInit(): void {
    const seed = this.promptSeed();
    // Suffixe technique commun, ajouté une seule fois ici (pas dans chaque describe*ForPrompt du
    // catalogue, cf. shared/image-prompt.ts) — écrit pour rester utilisable tel quel copié-collé
    // dans un générateur externe (ChatGPT/GPT-image, Midjourney...), pas seulement les 3
    // fournisseurs configurés dans l'app : d'où les précisions explicites sur le fond transparent,
    // le cadrage et l'absence de texte, qu'un simple "fond transparent" laisse trop souvent ignorer.
    this.prompt = seed
      ? `${seed}. Icône de jeu 2D façon Terraria, style illustré/vectoriel cohérent, contour net, `
        + `fond ENTIÈREMENT transparent (PNG, pas de sol ni de décor), cadrage carré 1:1, `
        + `vue de trois-quarts ou de profil, sans texte ni watermark ni logo.`
      : '';
  }

  /** Point unique de résolution — cf. ApiService.spriteAssetUrl (statique pour le CC0 embarqué, storage pour le reste). */
  libraryAssetUrl(item: SpriteAsset): string {
    return this.api.spriteAssetUrl(item);
  }

  toggleLibrary(): void {
    this.showLibrary.set(!this.showLibrary());
    if (this.showLibrary() && this.libraryCategories().length === 0 && !this.libraryLoading()) {
      this.libraryLoading.set(true);
      this.libraryError.set(null);
      this.api.getSpriteAssets().subscribe({
        next: assets => {
          const groups = LIBRARY_CATEGORIES.map(c => ({
            ...c, items: assets.filter(a => a.category === c.key),
          }));
          this.libraryCategories.set(groups);
          this.openCategory.set(groups[0]?.key ?? null);
          this.libraryLoading.set(false);
        },
        error: () => {
          this.libraryError.set("Impossible de charger la bibliothèque de sprites.");
          this.libraryLoading.set(false);
        },
      });
    }
  }

  toggleCategory(key: string): void {
    this.openCategory.set(this.openCategory() === key ? null : key);
  }

  /** Récupère un asset de la bibliothèque partagée (même origine pour le CC0 embarqué, storage pour
   * le reste — cf. spriteAssetUrl) et le pousse par le même chemin que `uploadFile()`. */
  pickFromLibrary(item: SpriteAsset): void {
    this.pickingId.set(item.id);
    this.error.set(null);
    fetch(this.libraryAssetUrl(item))
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        const name = `${item.name || 'sprite'}.png`;
        const file = new File([blob], name, { type: blob.type || 'image/png' });
        this.api.uploadIconFile(this.category(), this.itemId(), file).subscribe({
          next: () => { this.pickingId.set(null); this.applied.emit(); },
          error: err => {
            this.pickingId.set(null);
            this.error.set(err.error?.detail ?? `Erreur ${err.status}`);
          },
        });
      })
      .catch(() => {
        this.pickingId.set(null);
        this.error.set('Impossible de récupérer ce sprite.');
      });
  }

  get currentIconSrc(): string {
    return this.api.iconUrl(this.currentIconUrl());
  }

  get previewSrc(): string {
    const img = this.image();
    return img ? `data:${img.mime_type};base64,${img.image_base64}` : '';
  }

  generate(): void {
    if (!this.prompt.trim()) return;
    this.loading.set(true);
    this.error.set(null);
    this.needsConfig.set(false);
    this.api.generateImage(this.prompt, this.provider).subscribe({
      next: img => { this.image.set(img); this.loading.set(false); },
      error: err => {
        this.loading.set(false);
        this.needsConfig.set(err.status === 409);
        this.error.set(err.error?.detail ?? `Erreur ${err.status}`);
      },
    });
  }

  useImage(): void {
    const img = this.image();
    if (!img) return;
    this.applying.set(true);
    this.api.useGeneratedImage(this.category(), this.itemId(), img).subscribe({
      next: () => { this.applying.set(false); this.image.set(null); this.applied.emit(); },
      error: err => {
        this.applying.set(false);
        this.error.set(err.error?.detail ?? `Erreur ${err.status}`);
      },
    });
  }

  discard(): void {
    this.image.set(null);
  }

  copyPrompt(): void {
    navigator.clipboard.writeText(this.prompt).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    });
  }

  uploadFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading.set(true);
    this.error.set(null);
    this.api.uploadIconFile(this.category(), this.itemId(), file).subscribe({
      next: () => { this.uploading.set(false); input.value = ''; this.applied.emit(); },
      error: err => {
        this.uploading.set(false);
        this.error.set(err.error?.detail ?? `Erreur ${err.status}`);
      },
    });
  }
}
