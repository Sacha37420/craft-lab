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

export interface WorldMonsterDef {
  id: number;
  name: string;
  hp: number;
  detectionRange: number;
  attackType: 'melee' | 'ranged' | 'magic';
  attackDamage: number;
  attackRate: number;
  movementPatterns: string[];
  drops: WorldMonsterDrop[];
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
