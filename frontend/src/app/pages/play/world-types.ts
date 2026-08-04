/**
 * Types partagés entre PlayComponent (récupère le catalogue via l'API) et
 * GameScene (Phaser, ne parle jamais à l'API directement — cf. game-scene.ts).
 */

export interface WorldBlockDrop {
  itemId: number;
  quantity: number;
  chance: number;
}

export interface WorldBlockDef {
  id: number;
  name: string;
  color: string;
  hardness: number;
  isLiquid: boolean;
  /** Probabilité de propagation par tick vers une case vide adjacente — cf. GameScene.tickLiquids. */
  flowSpreadChance: number;
  /** Vide pour un bloc non généré naturellement (uniquement craftable) — le drop par défaut est alors lui-même. */
  drops: WorldBlockDrop[];
  /** URL absolue déjà résolue (storage + token, cf. ApiService.iconUrl) — null si aucune icône définie
   * dans le catalogue, auquel cas GameScene retombe sur la couleur procédurale `color`. */
  iconUrl: string | null;
}

export interface WorldToolDef {
  id: number;
  name: string;
  power: number;
  speed: number;
}

export interface InventoryEntry {
  itemId: number;
  name: string;
  iconUrl: string | null;
  category: string;
  quantity: number;
}

/** Item minimal nécessaire pour peupler l'inventaire de départ / résoudre les noms de drops. */
export interface WorldItemRef {
  id: number;
  name: string;
  category: string;
  iconUrl: string | null;
}

// ── Lot 6b : monstres, combat, craft ──────────────────────────────────────

export interface WorldMonsterDrop {
  itemId: number;
  quantity: number;
  chance: number;
}

export interface WorldMonsterRigPart {
  id: string;
  /** Référence un SpriteAsset (Lot 10) — sert de clé de texture Phaser stable, cf. GameScene.rigPartKey. */
  assetId: number;
  /** URL déjà résolue (ApiService.spriteAssetUrl, cf. PlayComponent) — chemin relatif statique pour
   * le CC0 embarqué, URL storage + token pour le contenu utilisateur. Résolue UNE fois avant le
   * lancement de Phaser, jamais recalculée dans GameScene (qui ne parle jamais à l'API). */
  textureUrl: string;
  x: number;
  y: number;
  flip: boolean;
  /** Contact avec un joueur = dégâts (cf. GameScene.tickRigCollisions) — remplace le calcul par
   * distance habituel pour ce monstre dès qu'au moins une pièce porte ce flag, et joue la
   * compétence de type 'attack' si une est définie. */
  isWeapon?: boolean;
  /** Vérifie chaque frame le recouvrement avec les blocks solides du terrain — joue la compétence
   * de type 'block-hit' si une est définie. */
  collidesTerrain?: boolean;
}

export interface WorldRigSkillPose {
  dx: number;
  dy: number;
  rotationDeg: number;
  tempAssetId?: number;
  /** URL déjà résolue de tempAssetId — cf. WorldMonsterRigPart.textureUrl, même principe. */
  tempTextureUrl?: string;
}

export interface WorldRigSkillStep {
  durationMs: number;
  poses: Record<string, WorldRigSkillPose>;
}

/** Chorégraphie nommée sur tout le montage — cf. MonsterRig.skills (api.service.ts) pour la
 * sémantique complète des 5 types et de la boucle idle/move-lateral vs une-fois jump/attack/
 * block-hit. */
export interface WorldRigSkill {
  id: string;
  name: string;
  type: 'idle' | 'move-lateral' | 'jump' | 'attack' | 'block-hit';
  steps: WorldRigSkillStep[];
}

/** Projectile réellement simulé (Lot 12) — propriété du Projectile catalogue lui-même (icône +
 * vitesse), résolu une fois par PlayComponent, réutilisé aussi bien par un tir joueur
 * (WorldWeaponDef.projectile) que par un tir monstre (WorldMonsterDef.projectile). */
export interface WorldProjectileDef {
  id: number;
  name: string;
  damage: number;
  speed: number;
  iconUrl: string | null;
}

export interface WorldMonsterDef {
  id: number;
  name: string;
  hp: number;
  detectionRange: number;
  attackType: 'melee' | 'ranged' | 'magic';
  attackDamage: number;
  attackRate: number;
  attackRangeTiles: number;
  /** Absent = ancien comportement (dégât instantané par distance), cf. WorldProjectileDef. */
  projectile?: WorldProjectileDef;
  movementPatterns: string[];
  moveSpeed: number;
  chaseSpeed: number;
  jumpStrength: number;
  drops: WorldMonsterDrop[];
  /** URL absolue déjà résolue (storage + token) — null si aucune icône définie, repli sur le rond de couleur procédural. */
  iconUrl: string | null;
  /** Montage par pièces + chorégraphies, textures déjà résolues en URL (cf. WorldMonsterRigPart,
   * Lot 10 — statique pour le CC0 embarqué, storage pour le contenu utilisateur) — undefined pour
   * un monstre à icône plate classique. */
  rig?: { parts: WorldMonsterRigPart[]; skills: WorldRigSkill[] };
}

export interface WorldMonsterSpawnRate {
  monsterId: number;
  chance: number;
}

export interface WorldWeaponDef {
  id: number;
  name: string;
  style: 'melee' | 'ranged' | 'magic' | 'summon';
  damage: number;
  attackRange: number | null;
  attackRate: number | null;
  /** Absent = ancien comportement (dégât instantané dès que la cible est à portée). Premier
   * WeaponProjectile configuré pour cette arme (une arme peut viser plusieurs munitions
   * différentes via WeaponProjectile — Lot 12 ne simule que la première, pas de sélection de
   * munition côté joueur pour l'instant). */
  projectile?: WorldProjectileDef;
}

export interface WorldRecipeIngredient {
  itemId: number;
  quantity: number;
}

export interface WorldRecipe {
  itemId: number;
  itemName: string;
  ingredients: WorldRecipeIngredient[];
}
