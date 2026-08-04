import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { KeycloakService } from './keycloak.service';
import { TierRules } from '../shared/world/terrain-generation';

interface EnvWindow {
  __env?: { apiUrl?: string; storageApiUrl?: string; relayUrl?: string };
}

export type ItemCategory = 'block' | 'weapon' | 'projectile' | 'artifact' | 'tool';
export type CatalogueCategoryPath = 'weapons' | 'projectiles' | 'artifacts' | 'tools' | 'blocks' | 'monsters';
export type CombatStyle = 'melee' | 'ranged' | 'magic' | 'summon';
/** Catégories couvertes par l'assistant IA texte (Lot 2 + Lot 4 + Lot 5). */
export type SuggestCategory = ItemCategory | 'monster' | 'map' | 'portal';

// ── Catalogue — Lot 1 ─────────────────────────────────────────────────────

export interface CatalogueItem {
  id: number;
  name: string;
  category: ItemCategory;
  icon_path: string;
  icon_url?: string | null;
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
  icon_url?: string | null;
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
  /** px/s — Lot 12, réutilisé aussi bien par un tir joueur (WeaponProjectile) qu'un tir monstre (Monster.projectile). */
  speed: number;
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

// ── Bibliothèque d'assets centralisée — Lot 10 ────────────────────────────

export type SpriteAssetCategory =
  | 'block' | 'character' | 'monster-creature' | 'monster-part' | 'weapon' | 'tool' | 'effect' | 'other';
export type SpriteAssetSource = 'cc0-bundled' | 'ai-generated' | 'upload';

export interface SpriteAsset {
  id: number;
  name: string;
  category: SpriteAssetCategory;
  /** Slot d'un gabarit de monstre (body/arm/leg/...) — pertinent seulement si category='monster-part'. */
  slot_hint: string;
  file_path: string;
  /** cc0-bundled : chemin relatif statique déjà prêt (assets/sprite-library/...). Le reste : chemin
   * storage relatif, à préfixer via ApiService.iconUrl() — cf. spriteAssetUrl() qui fait la bonne
   * chose dans les deux cas, jamais à reconstruire localement. */
  asset_url: string;
  source: SpriteAssetSource;
  tags: string[];
  created_by_email?: string;
  created_at?: string;
  updated_at?: string;
}

// ── Catalogue — Lot 4 (monstres et cartes) ────────────────────────────────

export interface MonsterSkill {
  id?: number;
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface MonsterDrop {
  id?: number;
  dropped_item: number | null;
  dropped_item_name?: string;
  quantity: number;
  chance: number;
}

export interface MonsterRigPart {
  /** Identifiant stable, généré une fois à l'ajout de la pièce et jamais régénéré — les
   * chorégraphies (RigSkillStep.poses) y font référence, il doit survivre aux rechargements. */
  id: string;
  /** Référence un SpriteAsset (Lot 10) — jamais un chemin brut : cf. ApiService.spriteAssetUrl()
   * pour la résolution (statique pour le CC0 embarqué, storage pour le contenu utilisateur). */
  assetId: number;
  x: number;
  y: number;
  flip: boolean;
  /** Contact avec un joueur = dégâts du monstre + joue la compétence de type 'attack' si une est
   * définie (cf. RigSkill). */
  isWeapon?: boolean;
  /** Vérifie chaque frame le recouvrement avec le terrain — joue la compétence de type 'block-hit'
   * si une est définie. */
  collidesTerrain?: boolean;
}

/** Position ciblée d'UNE pièce à l'intérieur d'une étape de compétence — décalage par rapport à sa
 * position de repos (celle du montage, pas une position absolue), plus une image temporaire
 * optionnelle (ex: un éclair de griffe, un SpriteAsset de catégorie 'effect') affichée pendant
 * cette étape puis retirée à l'étape suivante. */
export interface RigSkillPose {
  dx: number;
  dy: number;
  rotationDeg: number;
  tempAssetId?: number;
}

/** Une étape = une pose cible pour tout ou partie des pièces, tenue `durationMs`, interpolée
 * linéairement depuis la pose de l'étape précédente (ou le repos, pour la première étape). */
export interface RigSkillStep {
  durationMs: number;
  poses: Record<string, RigSkillPose>;
}

/**
 * Compétence = chorégraphie nommée sur TOUT le montage (pas une pièce isolée) — unifie mouvements
 * simples ET attaques/capacités dans un seul système, plutôt qu'une formule d'oscillation fixe pour
 * les uns et une réaction de collision figée pour les autres. `type` détermine QUAND GameScene la
 * joue :
 *   - 'idle' : en boucle quand le monstre est immobile (aucune si non définie — le montage reste
 *     alors simplement figé à son repos, jamais d'oscillation générique de secours).
 *   - 'move-lateral' : en boucle pendant un déplacement horizontal réel.
 *   - 'jump' : une fois, au moment du saut.
 *   - 'attack' : une fois, quand une pièce `isWeapon` touche un joueur (déclenche aussi les dégâts,
 *     cf. GameScene.tickRigCollisions — indépendant de la lecture de l'animation elle-même).
 *   - 'block-hit' : une fois, quand une pièce `collidesTerrain` touche un block.
 * 'idle'/'move-lateral' bouclent (dernière étape → première) ; les 3 autres se jouent une fois puis
 * reviennent au repos. Au plus UNE compétence de chaque type par monstre (la plus récente gagne si
 * plusieurs sont créées avec le même type).
 */
export interface RigSkill {
  id: string;
  name: string;
  type: 'idle' | 'move-lateral' | 'jump' | 'attack' | 'block-hit';
  steps: RigSkillStep[];
}

export interface MonsterRig {
  parts: MonsterRigPart[];
  skills: RigSkill[];
}

export interface Monster extends CatalogueEntityBase {
  level: number;
  hp: number;
  detection_range: number;
  detection_condition: Record<string, unknown>;
  attack_type: 'melee' | 'ranged' | 'magic';
  attack_damage: number;
  attack_rate: number;
  attack_range_tiles: number;
  /** Lot 12 — projectile réellement simulé qu'un monstre à distance tire ; null = ancien
   * comportement (dégât instantané par distance, dégrade en attaque de contact). */
  projectile: number | null;
  projectile_name?: string | null;
  movement_patterns: string[];
  move_speed: number;
  chase_speed: number;
  jump_strength: number;
  rig?: MonsterRig;
}

// ── Gabarits de monstre — Lot 11 ──────────────────────────────────────────

export interface RigTemplateSlot {
  slot_key: string;
  label: string;
  /** SpriteAsset.slot_hint dont ce slot propose les pièces — différent de slot_key (ex: deux slots
   * "arm-left"/"arm-right" puisent tous deux dans la même catégorie SpriteAsset "arm"). */
  asset_slot_hint: string;
  default_x: number;
  default_y: number;
  required: boolean;
  /** Slot instanciable N fois (seul le gabarit "Ver / serpent" l'utilise) — default_x/default_y
   * représentent alors l'espacement entre deux segments consécutifs, pas une position absolue. */
  repeatable: boolean;
  default_count?: number;
}

export interface RigTemplate {
  id: number;
  name: string;
  description: string;
  slots: RigTemplateSlot[];
  /** Structure interne consommée uniquement côté serveur (apply-template) — jamais interprétée ici. */
  default_skills: unknown[];
  created_at?: string;
}

export interface GameMap {
  id?: number;
  name: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DepthTier {
  id?: number;
  game_map: number;
  depth_index: number;
  void_rate: number;
}

export interface DepthTierBlockRate {
  id?: number;
  block: number | null;
  block_name?: string;
  rate: number;
}

export interface DepthTierMonsterSpawn {
  id?: number;
  monster: number | null;
  monster_name?: string;
  spawn_chance: number;
}

// ── Portails — Lot 5 (1.10) ───────────────────────────────────────────────

/** Cadre rectangulaire d'un seul type de block — seule forme actuellement supportée côté backend. */
export interface PortalFramePattern {
  shape: 'frame';
  width: number;
  height: number;
  block: number | null;
}

export interface Portal {
  id?: number;
  name: string;
  description?: string;
  frame_pattern: PortalFramePattern;
  destination_map: number | null;
  destination_map_name?: string | null;
  created_at?: string;
  updated_at?: string;
}

// ── Persistance des mondes — Lot 7 (section 3) ────────────────────────────

export interface WorldGenerationRules {
  tiers: TierRules[];
  monsterSpawns: { depthIndex: number; spawns: { monsterId: number; chance: number }[] }[];
}

export interface World {
  id?: number;
  name: string;
  source_map_name?: string;
  seed: number;
  created_by_email?: string;
  created_at?: string;
  updated_at?: string;
}

export interface WorldDetail extends World {
  generation_rules: WorldGenerationRules;
  /** Diff par rapport au terrain généré — clé "x,y" -> id de block ou null (case vidée). */
  block_diff: Record<string, number | null>;
}

export interface CharacterState {
  id?: number;
  world?: number;
  owner_email?: string;
  hp: number;
  position_x: number;
  position_y: number;
  /** {item_id (chaîne côté JSON) : quantité} */
  inventory: Record<string, number>;
  equipped_weapon_id: number | null;
  /** Préfixe dans assets/sprite-library/characters/ (ex: "adventurer") — cf. PLAYER_SKINS côté play.component. */
  appearance_skin?: string;
  updated_at?: string;
  /** Présent seulement en réponse du GET — cf. WorldViewSet.character côté backend. */
  created?: boolean;
}

// ── Assistant IA — Lot 2 (texte) / Lot 3 (image) ─────────────────────────

export type AIProvider = 'claude' | 'mistral' | 'gemini' | 'openai';
export type ImageProvider = 'gemini' | 'mistral' | 'openai';

export interface AIProviderConfig {
  provider: AIProvider;
  model_name: string;
  has_key: boolean;
  updated_at: string;
}

export interface CatalogueSuggestion {
  name: string;
  description: string;
  rationale: string;
  [stat: string]: unknown;
}

export interface GeneratedImage {
  image_base64: string;
  mime_type: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private kc = inject(KeycloakService);

  private get base(): string {
    return (window as unknown as EnvWindow).__env?.apiUrl
      ?? 'http://localhost:8097';
  }

  private get storageApiUrl(): string {
    return (window as unknown as EnvWindow).__env?.storageApiUrl
      ?? 'http://localhost:8093';
  }

  get relayUrl(): string {
    return (window as unknown as EnvWindow).__env?.relayUrl
      ?? 'ws://localhost:8098/ws';
  }

  /**
   * URL absolue d'une icône stockée dans storage, utilisable telle quelle
   * dans un <img [src]> — le JWT part en paramètre d'URL car ni une balise
   * <img> ne peut poser d'en-tête Authorization (cf. api/authentication.py
   * côté storage, fallback `?token=` ; patron déjà vérifié dans le lab par
   * atelier-3d/arbre-genealogique, cf. ApiService.mediaUrl() de ces apps).
   */
  iconUrl(path: string | null | undefined): string {
    if (!path) return '';
    const token = this.kc.getToken();
    return `${this.storageApiUrl}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  }

  /**
   * URL utilisable d'un SpriteAsset (Lot 10) — point UNIQUE de résolution, bifurque selon `source`
   * (cf. SpriteAsset.asset_url côté backend, même décision Lot 10) : cc0-bundled est un chemin
   * relatif statique déjà prêt à l'emploi (aucune requête storage/token, perf/cache préservés),
   * tout le reste passe par iconUrl() comme n'importe quelle icône storage.
   */
  spriteAssetUrl(asset: SpriteAsset): string {
    return asset.source === 'cc0-bundled' ? asset.asset_url : this.iconUrl(asset.asset_url);
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

  /** Relit une entité par id — utilisé notamment après icon() pour rafraîchir icon_url sans recharger toute la liste. */
  getEntity<T extends CatalogueEntityBase>(category: CatalogueCategoryPath, id: number): Observable<T> {
    return this.http.get<T>(`${this.base}/api/${category}/${id}/`);
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

  // ── Assistant IA — Lot 2 ──────────────────────────────────────────────────

  getAiConfig(provider: AIProvider): Observable<AIProviderConfig> {
    return this.http.get<AIProviderConfig>(`${this.base}/api/ai-config/${provider}/`);
  }
  saveAiConfig(provider: AIProvider, payload: { api_key?: string; model_name?: string }): Observable<AIProviderConfig> {
    return this.http.put<AIProviderConfig>(`${this.base}/api/ai-config/${provider}/`, payload);
  }
  suggestCatalogueEntity(
    category: SuggestCategory, provider: AIProvider, partial: Record<string, unknown>,
  ): Observable<CatalogueSuggestion> {
    return this.http.post<CatalogueSuggestion>(
      `${this.base}/api/catalogue-assistant/suggest/`, { category, provider, partial },
    );
  }

  // ── Assistant IA image — Lot 3 ───────────────────────────────────────────

  generateImage(prompt: string, provider: ImageProvider): Observable<GeneratedImage> {
    return this.http.post<GeneratedImage>(`${this.base}/api/image-assistant/generate/`, { prompt, provider });
  }

  /** Upload l'image choisie vers storage et l'associe à l'entité — jamais automatique, cf. AiImagePanelComponent. */
  useGeneratedImage<T extends CatalogueEntityBase>(
    category: CatalogueCategoryPath, id: number, image: GeneratedImage,
  ): Observable<T> {
    return this.http.post<T>(`${this.base}/api/${category}/${id}/icon/`, {
      image_base64: image.image_base64, mime_type: image.mime_type,
    });
  }

  /** Upload manuel d'un fichier local (image produite ailleurs) — même action que useGeneratedImage, en multipart. */
  uploadIconFile<T extends CatalogueEntityBase>(
    category: CatalogueCategoryPath, id: number, file: File,
  ): Observable<T> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<T>(`${this.base}/api/${category}/${id}/icon/`, formData);
  }

  // ── Monstres (1.8) ────────────────────────────────────────────────────────

  getMonsters(): Observable<Monster[]> {
    return this.http.get<Monster[]>(`${this.base}/api/monsters/`);
  }
  createMonster(data: Partial<Monster>): Observable<Monster> {
    return this.http.post<Monster>(`${this.base}/api/monsters/`, data);
  }
  updateMonster(id: number, data: Partial<Monster>): Observable<Monster> {
    return this.http.patch<Monster>(`${this.base}/api/monsters/${id}/`, data);
  }
  deleteMonster(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/monsters/${id}/`);
  }
  getMonsterSkills(monsterId: number): Observable<MonsterSkill[]> {
    return this.http.get<MonsterSkill[]>(`${this.base}/api/monsters/${monsterId}/skills/`);
  }
  addMonsterSkill(monsterId: number, data: MonsterSkill): Observable<MonsterSkill> {
    return this.http.post<MonsterSkill>(`${this.base}/api/monsters/${monsterId}/skills/`, data);
  }
  removeMonsterSkill(monsterId: number, skillId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/monsters/${monsterId}/skills/${skillId}/`);
  }
  getMonsterDrops(monsterId: number): Observable<MonsterDrop[]> {
    return this.http.get<MonsterDrop[]>(`${this.base}/api/monsters/${monsterId}/drops/`);
  }
  addMonsterDrop(monsterId: number, data: MonsterDrop): Observable<MonsterDrop> {
    return this.http.post<MonsterDrop>(`${this.base}/api/monsters/${monsterId}/drops/`, data);
  }
  removeMonsterDrop(monsterId: number, dropId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/monsters/${monsterId}/drops/${dropId}/`);
  }

  // ── Bibliothèque d'assets centralisée — Lot 10 ───────────────────────────

  getSpriteAssets(params?: { category?: SpriteAssetCategory; slotHint?: string; search?: string; tag?: string }): Observable<SpriteAsset[]> {
    const q = new URLSearchParams();
    if (params?.category) q.set('category', params.category);
    if (params?.slotHint) q.set('slot_hint', params.slotHint);
    if (params?.search) q.set('search', params.search);
    if (params?.tag) q.set('tag', params.tag);
    const qs = q.toString();
    return this.http.get<SpriteAsset[]>(`${this.base}/api/sprite-assets/${qs ? '?' + qs : ''}`);
  }

  /** Upload direct dans la bibliothèque partagée (page Bibliothèque, indépendamment de tout monstre
   * en cours d'édition) — `source` sera 'upload' côté serveur (déduit du champ `file`, jamais choisi ici). */
  createSpriteAssetFromFile(
    name: string, category: SpriteAssetCategory, slotHint: string, tags: string[], file: File,
  ): Observable<SpriteAsset> {
    const formData = new FormData();
    formData.append('name', name);
    formData.append('category', category);
    if (slotHint) formData.append('slot_hint', slotHint);
    if (tags.length) formData.append('tags', tags.join(','));
    formData.append('file', file);
    return this.http.post<SpriteAsset>(`${this.base}/api/sprite-assets/`, formData);
  }

  deleteSpriteAsset(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/sprite-assets/${id}/`);
  }

  // ── Gabarits de monstre — Lot 11 ──────────────────────────────────────────

  getRigTemplates(): Observable<RigTemplate[]> {
    return this.http.get<RigTemplate[]>(`${this.base}/api/rig-templates/`);
  }

  /** Matérialise un gabarit en Monster.rig — remplace intégralement le rig existant. `slotAssets`
   * doit couvrir tout slot `required` du gabarit (id de SpriteAsset). `segmentCount` ignoré pour
   * un gabarit sans slot repeatable. */
  applyRigTemplate(
    monsterId: number, templateId: number, slotAssets: Record<string, number>, segmentCount?: number,
  ): Observable<Monster> {
    return this.http.post<Monster>(`${this.base}/api/monsters/${monsterId}/apply-template/`, {
      template_id: templateId, slot_assets: slotAssets, segment_count: segmentCount,
    });
  }

  // ── Cartes — génération par profondeur (1.9) ─────────────────────────────

  getGameMaps(): Observable<GameMap[]> {
    return this.http.get<GameMap[]>(`${this.base}/api/game-maps/`);
  }
  createGameMap(data: Partial<GameMap>): Observable<GameMap> {
    return this.http.post<GameMap>(`${this.base}/api/game-maps/`, data);
  }
  updateGameMap(id: number, data: Partial<GameMap>): Observable<GameMap> {
    return this.http.patch<GameMap>(`${this.base}/api/game-maps/${id}/`, data);
  }
  deleteGameMap(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/game-maps/${id}/`);
  }

  getDepthTiers(gameMapId: number): Observable<DepthTier[]> {
    return this.http.get<DepthTier[]>(`${this.base}/api/depth-tiers/?game_map=${gameMapId}`);
  }
  createDepthTier(data: DepthTier): Observable<DepthTier> {
    return this.http.post<DepthTier>(`${this.base}/api/depth-tiers/`, data);
  }
  updateDepthTier(id: number, data: Partial<DepthTier>): Observable<DepthTier> {
    return this.http.patch<DepthTier>(`${this.base}/api/depth-tiers/${id}/`, data);
  }
  deleteDepthTier(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/depth-tiers/${id}/`);
  }
  getDepthTierBlockRates(tierId: number): Observable<DepthTierBlockRate[]> {
    return this.http.get<DepthTierBlockRate[]>(`${this.base}/api/depth-tiers/${tierId}/block-rates/`);
  }
  addDepthTierBlockRate(tierId: number, data: DepthTierBlockRate): Observable<DepthTierBlockRate> {
    return this.http.post<DepthTierBlockRate>(`${this.base}/api/depth-tiers/${tierId}/block-rates/`, data);
  }
  removeDepthTierBlockRate(tierId: number, rateId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/depth-tiers/${tierId}/block-rates/${rateId}/`);
  }
  getDepthTierMonsterSpawns(tierId: number): Observable<DepthTierMonsterSpawn[]> {
    return this.http.get<DepthTierMonsterSpawn[]>(`${this.base}/api/depth-tiers/${tierId}/monster-spawns/`);
  }
  addDepthTierMonsterSpawn(tierId: number, data: DepthTierMonsterSpawn): Observable<DepthTierMonsterSpawn> {
    return this.http.post<DepthTierMonsterSpawn>(`${this.base}/api/depth-tiers/${tierId}/monster-spawns/`, data);
  }
  removeDepthTierMonsterSpawn(tierId: number, spawnId: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/depth-tiers/${tierId}/monster-spawns/${spawnId}/`);
  }

  // ── Portails (1.10) ───────────────────────────────────────────────────────

  getPortals(): Observable<Portal[]> {
    return this.http.get<Portal[]>(`${this.base}/api/portals/`);
  }
  createPortal(data: Partial<Portal>): Observable<Portal> {
    return this.http.post<Portal>(`${this.base}/api/portals/`, data);
  }
  updatePortal(id: number, data: Partial<Portal>): Observable<Portal> {
    return this.http.patch<Portal>(`${this.base}/api/portals/${id}/`, data);
  }
  deletePortal(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/portals/${id}/`);
  }

  // ── Parties sauvegardées (Lot 7) ─────────────────────────────────────────

  getWorlds(): Observable<World[]> {
    return this.http.get<World[]>(`${this.base}/api/worlds/`);
  }
  getWorld(id: number): Observable<WorldDetail> {
    return this.http.get<WorldDetail>(`${this.base}/api/worlds/${id}/`);
  }
  createWorld(data: { name: string; source_map_name: string; seed: number; generation_rules: WorldGenerationRules }): Observable<WorldDetail> {
    return this.http.post<WorldDetail>(`${this.base}/api/worlds/`, data);
  }
  deleteWorld(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/api/worlds/${id}/`);
  }
  getCharacter(worldId: number): Observable<CharacterState> {
    return this.http.get<CharacterState>(`${this.base}/api/worlds/${worldId}/character/`);
  }
  updateCharacterAppearance(worldId: number, appearanceSkin: string): Observable<CharacterState> {
    return this.http.put<CharacterState>(`${this.base}/api/worlds/${worldId}/character/`, { appearance_skin: appearanceSkin });
  }
  saveProgress(
    worldId: number, payload: { block_diff?: Record<string, number | null>; character?: Partial<CharacterState> },
  ): Observable<{ saved: boolean }> {
    return this.http.post<{ saved: boolean }>(`${this.base}/api/worlds/${worldId}/save/`, payload);
  }
  /** Billet à usage unique pour ouvrir la connexion WebSocket vers le relais (Lot 8). */
  getRelayTicket(worldId: number): Observable<{ ticket: string; world_id: number }> {
    return this.http.post<{ ticket: string; world_id: number }>(`${this.base}/api/worlds/${worldId}/relay-ticket/`, {});
  }
}
