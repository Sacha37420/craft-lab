import { Component, EventEmitter, inject, input, OnInit, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, CatalogueCategoryPath, GeneratedImage, ImageProvider } from '../../core/api.service';

/**
 * Icône/texture d'une entité du catalogue (Lot 3, cahier des charges
 * section 2) — réutilisé sur les 5 pages d'édition. Trois façons d'obtenir
 * une image, jamais mélangées :
 *   1. `generate()` — un fournisseur configuré (Gemini/Mistral/OpenAI)
 *      produit une prévisualisation ; rien n'est écrit dans storage à cette
 *      étape.
 *   2. `copyPrompt()` — l'utilisateur préfère produire l'image ailleurs
 *      (un autre outil IA, un dessin...) : le prompt suggéré (avec les
 *      éléments de cohérence visuelle) est copiable tel quel.
 *   3. `uploadFile()` — upload manuel direct du fichier obtenu par 2., ou de
 *      n'importe quelle image locale.
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

  ngOnInit(): void {
    const seed = this.promptSeed();
    this.prompt = seed
      ? `${seed}. Icône de jeu 2D façon Terraria, style cohérent, fond transparent, vue de face, contour net.`
      : '';
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
