import { Artifact, Block, Monster, Projectile, Tool, Weapon } from '../core/api.service';

/**
 * Construit le "seed" descriptif passé à AiImagePanelComponent (promptSeed) — la partie propre à
 * chaque entité du catalogue. Le suffixe technique commun (format, transparence, cadrage — cf.
 * AiImagePanelComponent.ngOnInit) reste ajouté une seule fois là-bas, pas ici, pour ne jamais le
 * dupliquer par catégorie.
 *
 * But : que le prompt affiché dans le panneau (bouton "Copier le prompt") soit directement
 * utilisable tel quel dans un générateur externe (ChatGPT/GPT-image, Midjourney...), pas seulement
 * dans les 3 fournisseurs configurés dans l'app — d'où des indices visuels dérivés des stats
 * réelles (niveau, dégâts, patterns de déplacement...) plutôt qu'un simple nom+description.
 */

const seg = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' — ');

function monsterTierAndMoves(m: Monster): { tier: string; moves: string } {
  const tier = m.level <= 2 ? 'ennemi faible/basique, peu impressionnant'
    : m.level <= 5 ? 'ennemi intermédiaire, robuste'
    : 'ennemi redoutable, quasi mini-boss';
  const moves: string[] = [];
  if (m.movement_patterns.includes('flying')) moves.push('possède des ailes, vole');
  if (m.movement_patterns.includes('jumping')) moves.push('pattes ressorts/bondissantes');
  if (m.movement_patterns.includes('chase')) moves.push('posture agressive et menaçante');
  if (m.movement_patterns.includes('flee')) moves.push('silhouette craintive et nerveuse');
  if (moves.length === 0) moves.push('créature terrestre, se déplace au sol');
  return { tier, moves: moves.join(', ') };
}

export function describeMonsterForPrompt(m: Monster): string {
  const { tier, moves } = monsterTierAndMoves(m);
  return seg(
    m.name,
    m.description,
    `Niveau ${m.level} (${tier}), ${m.hp} PV, attaque ${m.attack_type} (${m.attack_damage} dégâts)`,
    moves,
  );
}

const RIG_ELEMENTS: { label: string; required: boolean; instruction: string }[] = [
  {
    label: 'CORPS', required: true,
    instruction: 'torse/tête combinés en une seule forme globale, SANS bras, jambes, yeux ni bouche dessinés dessus (posés par-dessus séparément).',
  },
  {
    label: 'BRAS', required: true,
    instruction: 'UN SEUL bras (pas la paire, dupliqué en miroir ensuite), de l\'épaule à la main — épaule tout en HAUT de l\'image, bras pendant vers le bas, cadrage ajusté sans marge au-dessus de l\'épaule, forme symétrique (pas de motif à sens unique).',
  },
  {
    label: 'JAMBE', required: true,
    instruction: 'UNE SEULE jambe (pas la paire, dupliquée en miroir ensuite), de la hanche au pied — hanche tout en HAUT de l\'image, jambe pendant vers le bas, cadrage ajusté sans marge au-dessus de la hanche, forme symétrique.',
  },
  { label: 'YEUX', required: true, instruction: 'le ou les yeux, vue de face, sans aucune autre partie du visage ni du corps.' },
  { label: 'BOUCHE', required: true, instruction: 'la bouche seule, vue de face, sans aucune autre partie du visage ni du corps.' },
  { label: 'NEZ (optionnel)', required: false, instruction: 'le nez/naseau/museau seul, vue de face.' },
  { label: 'SOURCIL (optionnel)', required: false, instruction: 'un sourcil/arcade sourcilière seul, vue de face.' },
  {
    label: 'CORNE / OREILLE / ANTENNE (optionnel)', required: false,
    instruction: 'UN SEUL accessoire de tête (choisis le plus adapté à la description) — pas la paire, dupliqué en miroir ensuite — point d\'attache en BAS de l\'image (posé sur le sommet du corps), forme symétrique.',
  },
  { label: 'DÉTAIL bave/morve (optionnel)', required: false, instruction: 'un petit détail isolé et discret adapté à la créature.' },
];

/**
 * UN SEUL prompt (pas un par pièce, cf. version précédente jugée trop lourde à l'usage) couvrant le
 * montage complet du monstre — décrit le personnage une fois puis énumère explicitement chaque
 * élément à fournir en image séparée. Toujours nécessaire dès qu'on veut du contenu personnalisé
 * (pas la bibliothèque Kenney) dans le compositeur par glisser-déposer : un générateur d'image, sans
 * cette consigne explicite, rend par défaut UNE seule image du monstre entier assemblé — inutilisable
 * telle quelle pièce par pièce.
 */
export function describeMonsterRigPrompt(m: Monster): string {
  const { tier, moves } = monsterTierAndMoves(m);
  const bible = seg(
    `Personnage : ${m.name}`,
    m.description,
    `Niveau ${m.level} (${tier}), attaque ${m.attack_type}`,
    moves,
  );
  const list = RIG_ELEMENTS
    .map((el, i) => `${i + 1}. ${el.label} — ${el.instruction}`)
    .join('\n');

  return `${bible}.\n\n`
    + `Ce personnage doit être fourni en PLUSIEURS IMAGES SÉPARÉES, une par élément distinct du corps — `
    + `PAS une seule image du monstre entier assemblé. Génère une image indépendante pour chacun des `
    + `éléments suivants, chacune cadrée UNIQUEMENT sur cet élément :\n\n${list}\n\n`
    + `Contraintes communes à TOUTES ces images (indispensable, à respecter pour chacune) : même style `
    + `2D illustré/vectoriel façon Terraria, mêmes couleurs et proportions d'une image à l'autre `
    + `(cohérence essentielle — ces images seront recombinées pour former un seul monstre animé), fond `
    + `ENTIÈREMENT transparent (PNG), cadrage carré 1:1 ajusté au contenu (pas de grande marge vide), `
    + `sans texte ni watermark ni logo.`;
}

export function describeWeaponForPrompt(w: Weapon): string {
  const styleHint: Record<string, string> = {
    melee: 'arme de corps-à-corps (lame, masse ou hache tenue en main)',
    ranged: 'arme à distance (arc, arbalète ou fronde)',
    magic: 'arme magique (bâton, sceptre ou orbe orné de runes/énergie)',
    summon: 'objet d\'invocation (totem ou emblème rituel)',
  };
  const power = w.damage >= 8 ? 'lame/tête large et imposante, arme puissante' : 'arme légère et rapide';
  return seg(w.name, w.description, styleHint[w.style] ?? '', `${w.damage} dégâts — ${power}`);
}

export function describeToolForPrompt(t: Tool): string {
  const kind = t.tool_type === 'pickaxe' ? 'pioche de mineur, tête métallique' : 'hache d\'abattage, tête large';
  const heft = t.power >= 3 ? 'outil robuste et lourd' : 'outil simple et léger';
  return seg(t.name, t.description, kind, heft);
}

export function describeBlockForPrompt(b: Block): string {
  const nature = b.is_liquid
    ? 'texture de tuile pour un liquide (eau/lave), surface fluide et translucide'
    : `texture de tuile pour un bloc solide de terrain, dureté ${b.hardness}`;
  return seg(b.name, b.description, nature, 'vue de face plate, sans relief 3D, pensée pour paver une grille répétée');
}

export function describeProjectileForPrompt(p: Projectile): string {
  return seg(p.name, p.description, `${p.damage} dégâts`, 'petit projectile isolé en plein vol, silhouette dynamique, éventuelle traînée d\'effet');
}

export function describeArtifactForPrompt(a: Artifact): string {
  return seg(a.name, a.description, 'accessoire/artefact magique porté par le joueur, objet précieux et distinctif');
}
