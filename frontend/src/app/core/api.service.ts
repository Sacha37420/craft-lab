import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

interface EnvWindow {
  __env?: { apiUrl?: string };
}

export type ItemCategory = 'block' | 'weapon' | 'projectile' | 'artifact' | 'tool';
export type CatalogueCategoryPath = 'weapons' | 'projectiles' | 'artifacts' | 'tools' | 'blocks';
export type CombatStyle = 'melee' | 'ranged' | 'magic' | 'summon';

// ── Catalogue — Lot 1 ─────────────────────────────────────────────────────

export interface CatalogueItem {
  id: number;
  name: string;
  category: ItemCategory;
  icon_path: string;
}

export interface StatusEffect {
  id?: number;
  code: string;
  name: string;
  description?: string;
}

export interface RecipeIngredient {
  id?: number;
  ingredient: number | null;
  ingredient_name?: string;
  ingredient_category?: string;
  quantity: number;
}

export interface BlockDrop {
  id?: number;
  dropped_item: number | null;
  dropped_item_name?: string;
  quantity: number;
  chance: number;
}

export interface ArtifactEffect {
  id?: number;
  effect_type: string;
  effect_type_display?: string;
  parameters: Record<string, unknown>;
}

export interface WeaponProjectileLink {
  id?: number;
  projectile: number | null;
  projectile_name?: string;
  consumption_per_shot: number;
}

interface CatalogueEntityBase {
  id?: number;
  name: string;
  description?: string;
  icon_path?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Weapon extends CatalogueEntityBase {
  style: CombatStyle;
  damage: number;
  attack_range: number | null;
  attack_rate: number | null;
}

export interface Projectile extends CatalogueEntityBase {
  damage: number;
  effects: unknown[];
}

export type Artifact = CatalogueEntityBase;

export interface Tool extends CatalogueEntityBase {
  tool_type: 'pickaxe' | 'axe';
  power: number;
  speed: number;
}

export interface Block extends CatalogueEntityBase {
  is_generated: boolean;
  is_liquid: boolean;
  hardness: number;
  flow_behavior: Record<string, unknown>;
  contact_status_effect: number | null;
  contact_status_effect_name?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private get base(): string {
    return (window as unknown as EnvWindow).__env?.apiUrl
      ?? 'http://localhost:8097';
  }

  getMe(): Observable<unknown> {
    return this.http.get(`${this.base}/api/me/`);
  }

  getDepartments(): Observable<unknown[]> {
    return this.http.get<unknown[]>(`${this.base}/api/departments/`);
  }

  getUsers(): Observable<unknown[]> {
    return this.http.get<unknown[]>(`${this.base}/api/users/`);
  }

  // ── Catalogue — items tout catégorie confondue (sélecteurs) ─────────────

  getItems(category?: ItemCategory): Observable<CatalogueItem[]> {
    const query = category ? `?category=${category}` : '';
    return this.http.get<CatalogueItem[]>(`${this.base}/api/items/${query}`);
  }

  // ── Catalogue — effets de statut (1.4.6 / 1.7) ───────────────────────────

  getStatusEffects(): Observable<StatusEffect[]> {
    return this.http.get<StatusEffect[]>(`${this.base}/api/status-effects/`);
  }
  createStatusEffect(data: StatusEffect): Observable<StatusEffect> {
    return this.http.post<StatusEffect>(`${this.base}/api/status-effects/`, data);
  }
  updateStatusEffect(id: number, data: Partial<StatusEffect>): Observable<StatusEffect> {
    return this.http.patch<StatusEffect>(`${this.base}/api/status-effects/${id}/`, data);
  }
  deleteStatusEffect(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/status-effects/${id}/`);
  }

  // ── Catalogue — recette de craft (1.1), commune aux 5 catégories ────────

  getRecipe(category: CatalogueCategoryPath, id: number): Observable<RecipeIngredient[]> {
    return this.http.get<RecipeIngredient[]>(`${this.base}/api/${category}/${id}/recipe/`);
  }
  addRecipeIngredient(
    category: CatalogueCategoryPath, id: number, data: RecipeIngredient,
  ): Observable<RecipeIngredient> {
    return this.http.post<RecipeIngredient>(`${this.base}/api/${category}/${id}/recipe/`, data);
  }
  removeRecipeIngredient(category: CatalogueCategoryPath, id: number, ingredientId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/${category}/${id}/recipe/${ingredientId}/`);
  }

  // ── Armes (1.2) ───────────────────────────────────────────────────────────

  getWeapons(): Observable<Weapon[]> {
    return this.http.get<Weapon[]>(`${this.base}/api/weapons/`);
  }
  createWeapon(data: Partial<Weapon>): Observable<Weapon> {
    return this.http.post<Weapon>(`${this.base}/api/weapons/`, data);
  }
  updateWeapon(id: number, data: Partial<Weapon>): Observable<Weapon> {
    return this.http.patch<Weapon>(`${this.base}/api/weapons/${id}/`, data);
  }
  deleteWeapon(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/weapons/${id}/`);
  }
  getWeaponProjectiles(weaponId: number): Observable<WeaponProjectileLink[]> {
    return this.http.get<WeaponProjectileLink[]>(`${this.base}/api/weapons/${weaponId}/projectiles/`);
  }
  addWeaponProjectile(weaponId: number, data: WeaponProjectileLink): Observable<WeaponProjectileLink> {
    return this.http.post<WeaponProjectileLink>(`${this.base}/api/weapons/${weaponId}/projectiles/`, data);
  }
  removeWeaponProjectile(weaponId: number, linkId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/weapons/${weaponId}/projectiles/${linkId}/`);
  }

  // ── Projectiles (1.3) ─────────────────────────────────────────────────────

  getProjectiles(): Observable<Projectile[]> {
    return this.http.get<Projectile[]>(`${this.base}/api/projectiles/`);
  }
  createProjectile(data: Partial<Projectile>): Observable<Projectile> {
    return this.http.post<Projectile>(`${this.base}/api/projectiles/`, data);
  }
  updateProjectile(id: number, data: Partial<Projectile>): Observable<Projectile> {
    return this.http.patch<Projectile>(`${this.base}/api/projectiles/${id}/`, data);
  }
  deleteProjectile(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/projectiles/${id}/`);
  }

  // ── Artefacts (1.4) ───────────────────────────────────────────────────────

  getArtifacts(): Observable<Artifact[]> {
    return this.http.get<Artifact[]>(`${this.base}/api/artifacts/`);
  }
  createArtifact(data: Partial<Artifact>): Observable<Artifact> {
    return this.http.post<Artifact>(`${this.base}/api/artifacts/`, data);
  }
  updateArtifact(id: number, data: Partial<Artifact>): Observable<Artifact> {
    return this.http.patch<Artifact>(`${this.base}/api/artifacts/${id}/`, data);
  }
  deleteArtifact(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/artifacts/${id}/`);
  }
  getArtifactEffects(artifactId: number): Observable<ArtifactEffect[]> {
    return this.http.get<ArtifactEffect[]>(`${this.base}/api/artifacts/${artifactId}/effects/`);
  }
  addArtifactEffect(artifactId: number, data: ArtifactEffect): Observable<ArtifactEffect> {
    return this.http.post<ArtifactEffect>(`${this.base}/api/artifacts/${artifactId}/effects/`, data);
  }
  removeArtifactEffect(artifactId: number, effectId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/artifacts/${artifactId}/effects/${effectId}/`);
  }

  // ── Outils (1.5) ──────────────────────────────────────────────────────────

  getTools(): Observable<Tool[]> {
    return this.http.get<Tool[]>(`${this.base}/api/tools/`);
  }
  createTool(data: Partial<Tool>): Observable<Tool> {
    return this.http.post<Tool>(`${this.base}/api/tools/`, data);
  }
  updateTool(id: number, data: Partial<Tool>): Observable<Tool> {
    return this.http.patch<Tool>(`${this.base}/api/tools/${id}/`, data);
  }
  deleteTool(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/tools/${id}/`);
  }

  // ── Blocks de base et liquides (1.6 / 1.7) ───────────────────────────────

  getBlocks(): Observable<Block[]> {
    return this.http.get<Block[]>(`${this.base}/api/blocks/`);
  }
  createBlock(data: Partial<Block>): Observable<Block> {
    return this.http.post<Block>(`${this.base}/api/blocks/`, data);
  }
  updateBlock(id: number, data: Partial<Block>): Observable<Block> {
    return this.http.patch<Block>(`${this.base}/api/blocks/${id}/`, data);
  }
  deleteBlock(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/blocks/${id}/`);
  }
  getBlockDrops(blockId: number): Observable<BlockDrop[]> {
    return this.http.get<BlockDrop[]>(`${this.base}/api/blocks/${blockId}/drops/`);
  }
  addBlockDrop(blockId: number, data: BlockDrop): Observable<BlockDrop> {
    return this.http.post<BlockDrop>(`${this.base}/api/blocks/${blockId}/drops/`, data);
  }
  removeBlockDrop(blockId: number, dropId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/blocks/${blockId}/drops/${dropId}/`);
  }
}
