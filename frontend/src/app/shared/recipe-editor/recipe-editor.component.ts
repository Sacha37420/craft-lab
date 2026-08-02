import { Component, inject, input, OnChanges, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, CatalogueCategoryPath, CatalogueItem, RecipeIngredient } from '../../core/api.service';

/**
 * Recette de craft (cahier des charges 1.1) — commune aux 5 catégories
 * d'objets (Weapon/Projectile/Artifact/Tool/Block, cf. api/models.py côté
 * backend) : un seul composant réutilisé sur les 5 pages plutôt que dupliqué,
 * la logique (lister/ajouter/retirer un ingrédient) étant strictement
 * identique quelle que soit la catégorie concrète.
 */
@Component({
  selector: 'app-recipe-editor',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './recipe-editor.component.html',
})
export class RecipeEditorComponent implements OnChanges {
  private api = inject(ApiService);

  category = input.required<CatalogueCategoryPath>();
  itemId = input.required<number>();
  allItems = input<CatalogueItem[]>([]);

  ingredients = signal<RecipeIngredient[]>([]);
  form: RecipeIngredient = { ingredient: null, quantity: 1 };

  ngOnChanges(): void {
    this.load();
  }

  load(): void {
    this.api.getRecipe(this.category(), this.itemId()).subscribe(r => this.ingredients.set(r));
  }

  add(): void {
    if (!this.form.ingredient || !this.form.quantity) return;
    this.api.addRecipeIngredient(this.category(), this.itemId(), this.form).subscribe(() => {
      this.form = { ingredient: null, quantity: 1 };
      this.load();
    });
  }

  remove(ingredientId: number): void {
    this.api.removeRecipeIngredient(this.category(), this.itemId(), ingredientId).subscribe(() => this.load());
  }
}
