/**
 * Aperçu de génération de terrain (Lot 4, cahier des charges 1.9, point 1) :
 * prototype de l'algorithme de génération procédurale par palier de
 * profondeur, uniquement pour valider à l'œil le critère d'acceptation
 * (« filons visuellement cohérents entre paliers adjacents ») — l'algorithme
 * définitif utilisé en jeu (Lot 6) n'est pas figé ici, cf. cahier des
 * charges section 7.
 *
 * Bruit de valeur 2D (pas de dépendance externe — mulberry32 + interpolation
 * lissée) : UN champ de bruit continu par « slot » (vide + chaque type de
 * bloc), partagé sur toute la hauteur de la carte (jamais réinitialisé à une
 * frontière de palier). Chaque cellule est assignée au slot dont
 * `bruit(x, y) * taux_du_palier_courant` est maximal (arg-max pondéré). Comme
 * le champ de bruit est continu en (x, y) et que seul le poids change d'un
 * palier à l'autre, un filon présent des deux côtés d'une frontière de
 * palier s'estompe progressivement plutôt que de s'arrêter net — c'est ce
 * qui produit la cohérence verticale demandée, sans avoir besoin de
 * corréler explicitement deux bruits différents entre eux.
 */

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

class ValueNoise2D {
  private readonly size = 64;
  private readonly grid: Float32Array;

  constructor(seed: number) {
    const rand = mulberry32(seed);
    this.grid = new Float32Array(this.size * this.size);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rand();
  }

  private sample(ix: number, iy: number): number {
    const x = ((ix % this.size) + this.size) % this.size;
    const y = ((iy % this.size) + this.size) % this.size;
    return this.grid[y * this.size + x];
  }

  /** Valeur continue dans [0,1) en (x, y), coordonnées fractionnaires acceptées. */
  noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smoothstep(x - ix);
    const fy = smoothstep(y - iy);
    const top = this.sample(ix, iy) + fx * (this.sample(ix + 1, iy) - this.sample(ix, iy));
    const bottom = this.sample(ix, iy + 1) + fx * (this.sample(ix + 1, iy + 1) - this.sample(ix, iy + 1));
    return top + fy * (bottom - top);
  }
}

export interface TierBlockRate {
  blockId: number;
  blockName: string;
  color: string;
  rate: number;
}

export interface TierRules {
  depthIndex: number;
  voidRate: number;
  blockRates: TierBlockRate[];
}

export interface GeneratedCell {
  kind: 'void' | 'block';
  blockId?: number;
  blockName?: string;
  color: string;
}

/** Couleur déterministe par id de bloc — uniquement pour distinguer les filons à l'œil, jamais stockée. */
export function colorForBlockId(id: number): string {
  const hue = (id * 47) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

const NOISE_SCALE = 0.15; // plus petit = filons plus larges/étalés

export function generateTerrainPreview(
  seed: number, width: number, tiers: TierRules[], rowsPerTier: number,
): GeneratedCell[][] {
  const sorted = [...tiers].sort((a, b) => a.depthIndex - b.depthIndex);
  const noiseBySlot = new Map<string, ValueNoise2D>();
  const noiseFor = (slotKey: string, offset: number): ValueNoise2D => {
    let n = noiseBySlot.get(slotKey);
    if (!n) { n = new ValueNoise2D(seed + offset); noiseBySlot.set(slotKey, n); }
    return n;
  };

  const rows: GeneratedCell[][] = [];
  let globalY = 0;
  for (const tier of sorted) {
    for (let r = 0; r < rowsPerTier; r++, globalY++) {
      const row: GeneratedCell[] = [];
      for (let x = 0; x < width; x++) {
        let bestBlock: TierBlockRate | null = null;
        let bestScore = noiseFor('void', 0).noise(x * NOISE_SCALE, globalY * NOISE_SCALE) * tier.voidRate;
        for (const br of tier.blockRates) {
          const score = noiseFor(`block-${br.blockId}`, br.blockId * 97 + 13)
            .noise(x * NOISE_SCALE, globalY * NOISE_SCALE) * br.rate;
          if (score > bestScore) { bestScore = score; bestBlock = br; }
        }
        row.push(bestBlock
          ? { kind: 'block', blockId: bestBlock.blockId, blockName: bestBlock.blockName, color: bestBlock.color }
          : { kind: 'void', color: 'transparent' });
      }
      rows.push(row);
    }
  }
  return rows;
}
