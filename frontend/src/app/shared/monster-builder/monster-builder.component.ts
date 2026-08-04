import { Component, inject, input, OnInit, Output, EventEmitter, signal, computed } from '@angular/core';
import {
  ApiService, Monster, MonsterRig, MonsterRigPart, RigSkill, RigSkillStep, RigTemplate, SpriteAsset,
} from '../../core/api.service';
import { describeMonsterRigPrompt } from '../image-prompt';

/** Slots d'un montage de monstre par pièces — même vocabulaire que l'ancien
 * monster-parts-manifest.json, désormais un simple regroupement d'affichage de SpriteAsset
 * (category='monster-part', slot_hint=<key>) plutôt qu'une source de données à part (Lot 10). */
const SLOT_LABELS: { key: string; label: string }[] = [
  { key: 'body', label: 'Corps' },
  { key: 'arm', label: 'Bras' },
  { key: 'leg', label: 'Jambes' },
  { key: 'eye', label: 'Yeux' },
  { key: 'eyebrow', label: 'Sourcils' },
  { key: 'mouth', label: 'Bouche' },
  { key: 'nose', label: 'Nez' },
  { key: 'detail', label: 'Corne, oreille, antenne' },
  { key: 'snot', label: 'Morve' },
];
interface PartSlot {
  key: string;
  label: string;
  items: SpriteAsset[];
}

interface PlacedPart {
  id: string;
  slot: string;
  assetId: number;
  x: number;
  y: number;
  flip: boolean;
  /** Contact avec un joueur = dégâts du monstre + joue la compétence 'attack' si une est définie. */
  isWeapon: boolean;
  /** Vérifie chaque frame le recouvrement avec le terrain — joue la compétence 'block-hit'. */
  collidesTerrain: boolean;
}

type SkillType = 'idle' | 'move-lateral' | 'jump' | 'attack' | 'block-hit';
type StepPose = { dx: number; dy: number; rotationDeg: number; tempAssetId?: number };
interface EditableStep {
  id: string;
  durationMs: number;
  poses: Map<string, StepPose>;
}
interface EditableSkill {
  id: string;
  name: string;
  type: SkillType;
  steps: EditableStep[];
}

const SKILL_TYPE_OPTIONS: { value: SkillType; label: string; loop: boolean }[] = [
  { value: 'idle', label: 'Immobile (boucle)', loop: true },
  { value: 'move-lateral', label: 'Déplacement latéral (boucle)', loop: true },
  { value: 'jump', label: 'Saut (une fois)', loop: false },
  { value: 'attack', label: 'Attaque au contact (une fois)', loop: false },
  { value: 'block-hit', label: 'Impact contre un bloc (une fois)', loop: false },
];
const REST_POSE: StepPose = { dx: 0, dy: 0, rotationDeg: 0 };

/** Vocabulaire partagé avec MonstersComponent (case à cocher de la modale d'édition) — déclaré ici
 * plutôt que dupliqué, importé par la page catalogue plutôt que l'inverse. */
export const MOVEMENT_PATTERNS: { value: string; label: string }[] = [
  { value: 'ground', label: 'Au sol' },
  { value: 'flying', label: 'Vol' },
  { value: 'jumping', label: 'Saut' },
  { value: 'chase', label: 'Poursuite' },
  { value: 'flee', label: 'Fuite' },
];

const CANVAS = 360;

/**
 * Assemble un monstre "riggé" à partir de pièces séparées puisées dans la bibliothèque d'assets
 * partagée (SpriteAsset, category='monster-part' — Lot 10 ; pack Kenney "Monster Builder" CC0 au
 * départ, cf. LICENSE.txt sous assets/sprite-library/, mais désormais aussi tout upload fait
 * depuis la page Bibliothèque), PUIS chorégraphie
 * comment le montage se déplace/attaque via des Compétences (RigSkill) — un seul système pour les
 * mouvements simples (immobile, déplacement latéral, saut) ET les attaques/impacts, plutôt qu'une
 * formule d'oscillation figée pour les uns et une réaction de collision à part pour les autres.
 * Chaque pièce a un identifiant STABLE (PlacedPart.id, jamais régénéré après sa création) : les
 * compétences y font référence, elles doivent survivre aux rechargements de cette page.
 *
 * Persisté en deux temps distincts :
 *   1. `Monster.rig` (JSON, {parts, skills}) — la vérité du montage ET des chorégraphies, relue par
 *      GameScene.buildRiggedMonster/tickRigPlayback pour rejouer exactement la même chose en jeu.
 *   2. Une image plate composite (positions de repos, aplaties une fois) uploadée comme icône
 *      classique (icon_path) — sert de vignette catalogue/liste, jamais utilisée en jeu quand `rig`
 *      est présent.
 */
@Component({
  selector: 'app-monster-builder',
  standalone: true,
  imports: [],
  templateUrl: './monster-builder.component.html',
})
export class MonsterBuilderComponent implements OnInit {
  private api = inject(ApiService);

  itemId = input.required<number>();
  monster = input.required<Monster>();
  initialRig = input<MonsterRig | undefined>(undefined);
  @Output() applied = new EventEmitter<void>();

  readonly canvasSize = CANVAS;
  readonly movementPatterns = MOVEMENT_PATTERNS;
  readonly skillTypeOptions = SKILL_TYPE_OPTIONS;

  // ── Déplacement & attaque (Monster.move_speed/chase_speed/jump_strength/attack_range_tiles/
  // movement_patterns) — visibles ET modifiables ici en plus de la modale "Modifier" du monstre. ──
  movementPatternsValue = signal<string[]>([]);
  moveSpeed = signal(35);
  chaseSpeed = signal(70);
  jumpStrength = signal(320);
  attackRangeTiles = signal(1.2);

  private monsterPartAssets = signal<SpriteAsset[]>([]);
  /** Regroupement d'affichage par slot (Lot 10 : les données viennent de l'API, SLOT_LABELS ne
   * pilote plus que le libellé/l'ordre) — tous les slots sont affichés même vides (palette
   * naissante, avant tout upload dans une catégorie). */
  slots = computed<PartSlot[]>(() => SLOT_LABELS.map(sl => ({
    ...sl, items: this.monsterPartAssets().filter(a => a.slot_hint === sl.key),
  })));
  loading = signal(false);
  error = signal<string | null>(null);
  placedParts = signal<PlacedPart[]>([]);
  selectedId = signal<string | null>(null);
  saving = signal(false);
  openPalette = signal<string | null>(null);
  showPrompts = signal(false);
  promptCopied = signal(false);
  /** Pour choisir l'image temporaire d'une pose d'étape (ex: un éclair de griffe, une explosion) —
   * catégorie "effect" de la bibliothèque partagée (cf. AiImagePanelComponent, Lot 10). */
  effectsItems = signal<SpriteAsset[]>([]);
  pickingTempImageFor = signal<string | null>(null);
  /** Résolution assetId → SpriteAsset, pour assetUrl() — couvre les deux seules catégories
   * consommées par cet éditeur (monster-part pour les pièces, effect pour les images temporaires). */
  private assetsById = computed<Map<number, SpriteAsset>>(
    () => new Map([...this.monsterPartAssets(), ...this.effectsItems()].map(a => [a.id, a])),
  );

  // ── Créer depuis un gabarit (Lot 11) ─────────────────────────────────────────────────────────
  templates = signal<RigTemplate[]>([]);
  selectedTemplateId = signal<number | null>(null);
  selectedTemplate = computed<RigTemplate | null>(() => this.templates().find(t => t.id === this.selectedTemplateId()) ?? null);
  /** slot_key -> SpriteAsset choisi pour ce slot (un seul, y compris pour un slot repeatable — le
   * même asset est répété sur tous les segments générés). */
  templateSlotAssets = signal<Map<string, number>>(new Map());
  templateSegmentCount = signal(6);
  applyingTemplate = signal(false);
  templateError = signal<string | null>(null);
  /** Un gabarit ne propose que des pièces de sa propre catégorie de slot (slot_hint) — même
   * regroupement que la palette normale, restreint aux slot_key du gabarit choisi. */
  templateSlotItems = computed<Map<string, SpriteAsset[]>>(() => {
    const map = new Map<string, SpriteAsset[]>();
    for (const slot of this.selectedTemplate()?.slots ?? []) {
      map.set(slot.slot_key, this.monsterPartAssets().filter(a => a.slot_hint === slot.asset_slot_hint));
    }
    return map;
  });
  templateReady = computed<boolean>(() => {
    const tpl = this.selectedTemplate();
    if (!tpl) return false;
    return tpl.slots.filter(s => s.required).every(s => this.templateSlotAssets().has(s.slot_key));
  });

  // ── Compétences (chorégraphies) ──────────────────────────────────────────────────────────────
  skills = signal<EditableSkill[]>([]);
  selectedSkillId = signal<string | null>(null);
  selectedStepId = signal<string | null>(null);
  previewOffsets = signal<Map<string, StepPose> | null>(null);
  previewPlaying = signal(false);
  private previewRafId: number | null = null;

  rigPrompt = computed<string>(() => describeMonsterRigPrompt(this.monster()));
  selectedPart = computed<PlacedPart | null>(() => this.placedParts().find(p => p.id === this.selectedId()) ?? null);
  selectedSkill = computed<EditableSkill | null>(() => this.skills().find(s => s.id === this.selectedSkillId()) ?? null);
  selectedStep = computed<EditableStep | null>(() => this.selectedSkill()?.steps.find(s => s.id === this.selectedStepId()) ?? null);

  private dragId: string | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;
  private readonly onPointerMove = (e: PointerEvent): void => this.handlePointerMove(e);
  private readonly onPointerUp = (): void => this.handlePointerUp();

  ngOnInit(): void {
    const m = this.monster();
    this.movementPatternsValue.set([...(m.movement_patterns ?? [])]);
    this.moveSpeed.set(m.move_speed);
    this.chaseSpeed.set(m.chase_speed);
    this.jumpStrength.set(m.jump_strength);
    this.attackRangeTiles.set(m.attack_range_tiles);

    this.loading.set(true);
    this.api.getSpriteAssets({ category: 'monster-part' }).subscribe({
      next: assets => {
        this.monsterPartAssets.set(assets);
        this.openPalette.set(this.slots()[0]?.key ?? null);
        this.loading.set(false);
      },
      error: () => { this.error.set('Impossible de charger les pièces de monstre.'); this.loading.set(false); },
    });
    this.api.getSpriteAssets({ category: 'effect' }).subscribe({
      next: assets => this.effectsItems.set(assets),
      error: () => {},
    });

    this.api.getRigTemplates().subscribe({
      next: templates => this.templates.set(templates),
      error: () => {},
    });

    this.applyRigToState(this.initialRig());
  }

  /** Recharge placedParts/skills depuis un MonsterRig — factorisé pour servir aussi bien au
   * chargement initial (ngOnInit) qu'à l'application d'un gabarit (applyTemplate ci-dessous), qui
   * REMPLACE le montage courant exactement comme le ferait une réouverture de la page avec un
   * nouveau rig. */
  private applyRigToState(rig: MonsterRig | undefined): void {
    // id REPRIS tel quel (jamais régénéré) — les compétences y font référence, cf. docstring.
    // Repli sur un id neuf pour un montage sauvegardé avant l'introduction de ce champ (l'ancien
    // système d'animation par pièce qu'il portait alors, `animate`, est simplement ignoré : aucune
    // compétence ne pouvait y faire référence puisque les compétences n'existaient pas encore).
    // `slot` reste indicatif (jamais relu ailleurs dans ce composant) : correct une fois la
    // palette chargée, vide sinon — sans effet sur le montage lui-même.
    this.placedParts.set((rig?.parts ?? []).map(p => ({
      id: p.id ?? crypto.randomUUID(), slot: this.assetsById().get(p.assetId)?.slot_hint ?? '',
      assetId: p.assetId, x: p.x, y: p.y, flip: p.flip,
      isWeapon: !!p.isWeapon, collidesTerrain: !!p.collidesTerrain,
    })));
    this.skills.set((rig?.skills ?? []).map(s => ({
      id: s.id, name: s.name, type: s.type,
      steps: s.steps.map(step => ({
        id: crypto.randomUUID(), durationMs: step.durationMs,
        poses: new Map(Object.entries(step.poses)),
      })),
    })));
  }

  /** Point UNIQUE de résolution d'un SpriteAsset en URL affichable (cf. ApiService.spriteAssetUrl)
   * — chaîne vide si l'asset référencé a été supprimé de la bibliothèque depuis (image cassée,
   * même dégradation silencieuse qu'un fichier statique manquant avant le Lot 10). */
  assetUrl(assetId: number): string {
    const asset = this.assetsById().get(assetId);
    return asset ? this.api.spriteAssetUrl(asset) : '';
  }

  togglePalette(key: string): void {
    this.openPalette.set(this.openPalette() === key ? null : key);
  }

  // ── Créer depuis un gabarit (Lot 11) ─────────────────────────────────────────────────────────

  selectTemplate(id: number | null): void {
    this.selectedTemplateId.set(id);
    this.templateSlotAssets.set(new Map());
    this.templateError.set(null);
    const tpl = this.templates().find(t => t.id === id);
    const repeatable = tpl?.slots.find(s => s.repeatable);
    this.templateSegmentCount.set(repeatable?.default_count ?? 6);
  }

  pickTemplateSlotAsset(slotKey: string, assetId: number): void {
    this.templateSlotAssets.update(map => new Map(map).set(slotKey, assetId));
  }

  setTemplateSegmentCount(value: number): void {
    this.templateSegmentCount.set(Math.max(2, Math.min(20, Math.round(value))));
  }

  /** Matérialise le gabarit choisi en un vrai Monster.rig côté serveur, PUIS recharge l'état local
   * exactement comme au chargement de la page (applyRigToState) — même montage, éditable ensuite
   * avec les outils déjà existants (drag, compétences...), rien de spécifique au gabarit à partir
   * de là. Remplace tout montage existant : confirmation explicite si des pièces sont déjà posées. */
  applyTemplate(): void {
    const tpl = this.selectedTemplate();
    if (!tpl || !this.templateReady()) return;
    if (this.placedParts().length > 0
      && !confirm('Cela remplace le montage actuel par le gabarit choisi. Continuer ?')) return;

    this.applyingTemplate.set(true);
    this.templateError.set(null);
    const slotAssets = Object.fromEntries(this.templateSlotAssets());
    const hasRepeatable = tpl.slots.some(s => s.repeatable);
    this.api.applyRigTemplate(
      this.itemId(), tpl.id, slotAssets, hasRepeatable ? this.templateSegmentCount() : undefined,
    ).subscribe({
      next: updated => {
        this.applyingTemplate.set(false);
        this.applyRigToState(updated.rig);
        this.selectTemplate(null);
      },
      error: err => {
        this.applyingTemplate.set(false);
        this.templateError.set(err.error?.slot_assets?.[0] ?? err.error?.detail ?? `Erreur ${err.status}`);
      },
    });
  }

  toggleMovementPattern(value: string): void {
    this.movementPatternsValue.update(list => list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  }

  setMoveSpeed(value: number): void { this.moveSpeed.set(value); }
  setChaseSpeed(value: number): void { this.chaseSpeed.set(value); }
  setJumpStrength(value: number): void { this.jumpStrength.set(value); }
  setAttackRangeTiles(value: number): void { this.attackRangeTiles.set(value); }

  toggleShowPrompts(): void {
    this.showPrompts.update(v => !v);
  }

  copyRigPrompt(): void {
    navigator.clipboard.writeText(this.rigPrompt()).then(() => {
      this.promptCopied.set(true);
      setTimeout(() => this.promptCopied.set(false), 2000);
    });
  }

  // ── Montage (pièces) ──────────────────────────────────────────────────────────────────────────

  addPart(assetId: number, slotKey: string): void {
    const id = crypto.randomUUID();
    this.placedParts.update(parts => [...parts, { id, slot: slotKey, assetId, x: 0, y: 0, flip: false, isWeapon: false, collidesTerrain: false }]);
    this.selectedId.set(id);
  }

  toggleWeapon(id: string): void {
    this.placedParts.update(parts => parts.map(p => p.id === id ? { ...p, isWeapon: !p.isWeapon } : p));
  }

  toggleCollidesTerrain(id: string): void {
    this.placedParts.update(parts => parts.map(p => p.id === id ? { ...p, collidesTerrain: !p.collidesTerrain } : p));
  }

  select(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }

  remove(id: string): void {
    this.placedParts.update(parts => parts.filter(p => p.id !== id));
    if (this.selectedId() === id) this.selectedId.set(null);
  }

  toggleFlip(id: string): void {
    this.placedParts.update(parts => parts.map(p => p.id === id ? { ...p, flip: !p.flip } : p));
  }

  bringForward(id: string): void {
    this.placedParts.update(parts => {
      const i = parts.findIndex(p => p.id === id);
      if (i < 0 || i === parts.length - 1) return parts;
      const next = [...parts];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });
  }

  sendBackward(id: string): void {
    this.placedParts.update(parts => {
      const i = parts.findIndex(p => p.id === id);
      if (i <= 0) return parts;
      const next = [...parts];
      [next[i], next[i - 1]] = [next[i - 1], next[i]];
      return next;
    });
  }

  startDrag(id: string, event: PointerEvent): void {
    event.preventDefault();
    this.selectedId.set(id);
    const part = this.placedParts().find(p => p.id === id);
    if (!part) return;
    this.dragId = id;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragOriginX = part.x;
    this.dragOriginY = part.y;
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.dragId) return;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;
    const id = this.dragId;
    this.placedParts.update(parts => parts.map(p => p.id === id ? { ...p, x: this.dragOriginX + dx, y: this.dragOriginY + dy } : p));
  }

  private handlePointerUp(): void {
    this.dragId = null;
    document.removeEventListener('pointermove', this.onPointerMove);
  }

  // ── Compétences (chorégraphies) ──────────────────────────────────────────────────────────────

  addSkill(): void {
    const id = crypto.randomUUID();
    this.skills.update(list => [...list, { id, name: `Compétence ${list.length + 1}`, type: 'attack', steps: [] }]);
    this.selectedSkillId.set(id);
    this.selectedStepId.set(null);
  }

  removeSkill(id: string): void {
    this.stopPreview();
    this.skills.update(list => list.filter(s => s.id !== id));
    if (this.selectedSkillId() === id) { this.selectedSkillId.set(null); this.selectedStepId.set(null); }
  }

  selectSkill(id: string): void {
    this.stopPreview();
    this.selectedSkillId.set(this.selectedSkillId() === id ? null : id);
    this.selectedStepId.set(null);
  }

  renameSkill(id: string, name: string): void {
    this.skills.update(list => list.map(s => s.id === id ? { ...s, name } : s));
  }

  setSkillType(id: string, type: SkillType): void {
    this.skills.update(list => list.map(s => s.id === id ? { ...s, type } : s));
  }

  addStep(skillId: string): void {
    const id = crypto.randomUUID();
    this.skills.update(list => list.map(s => s.id === skillId
      ? { ...s, steps: [...s.steps, { id, durationMs: 200, poses: new Map() }] }
      : s));
    this.selectedStepId.set(id);
  }

  removeStep(skillId: string, stepId: string): void {
    this.skills.update(list => list.map(s => s.id === skillId ? { ...s, steps: s.steps.filter(st => st.id !== stepId) } : s));
    if (this.selectedStepId() === stepId) this.selectedStepId.set(null);
  }

  selectStep(id: string): void {
    this.stopPreview();
    this.selectedStepId.set(this.selectedStepId() === id ? null : id);
  }

  setStepDuration(skillId: string, stepId: string, durationMs: number): void {
    this.skills.update(list => list.map(s => s.id !== skillId ? s : {
      ...s, steps: s.steps.map(st => st.id === stepId ? { ...st, durationMs: Math.max(1, durationMs) } : st),
    }));
  }

  poseFor(step: EditableStep, partId: string): StepPose {
    return step.poses.get(partId) ?? REST_POSE;
  }

  private updatePose(skillId: string, stepId: string, partId: string, patch: Partial<StepPose>): void {
    this.skills.update(list => list.map(s => {
      if (s.id !== skillId) return s;
      return {
        ...s,
        steps: s.steps.map(st => {
          if (st.id !== stepId) return st;
          const poses = new Map(st.poses);
          poses.set(partId, { ...this.poseFor(st, partId), ...patch });
          return { ...st, poses };
        }),
      };
    }));
  }

  setPoseDx(skillId: string, stepId: string, partId: string, dx: number): void { this.updatePose(skillId, stepId, partId, { dx }); }
  setPoseDy(skillId: string, stepId: string, partId: string, dy: number): void { this.updatePose(skillId, stepId, partId, { dy }); }
  setPoseRotation(skillId: string, stepId: string, partId: string, rotationDeg: number): void { this.updatePose(skillId, stepId, partId, { rotationDeg }); }

  toggleTempImagePicker(partId: string): void {
    this.pickingTempImageFor.set(this.pickingTempImageFor() === partId ? null : partId);
  }

  pickTempImage(skillId: string, stepId: string, partId: string, assetId: number): void {
    this.updatePose(skillId, stepId, partId, { tempAssetId: assetId });
    this.pickingTempImageFor.set(null);
  }

  clearTempImage(skillId: string, stepId: string, partId: string): void {
    this.updatePose(skillId, stepId, partId, { tempAssetId: undefined });
  }

  /** Joue la chorégraphie complète sur l'aperçu (canvas), en boucle pour idle/move-lateral, une
   * fois pour les 3 autres types — même logique d'interpolation que GameScene.tickRigPlayback,
   * dupliquée ici volontairement (l'éditeur n'a pas de moteur Phaser à sa disposition). */
  playPreview(skill: EditableSkill): void {
    if (skill.steps.length === 0) return;
    this.stopPreview();
    this.previewPlaying.set(true);
    const loop = SKILL_TYPE_OPTIONS.find(o => o.value === skill.type)?.loop ?? false;
    let stepIndex = 0;
    let stepStart = performance.now();
    let fromPoses = new Map<string, StepPose>();

    const frame = (now: number): void => {
      if (!this.previewPlaying()) return;
      const step = skill.steps[stepIndex];
      const t = Math.min(1, (now - stepStart) / step.durationMs);
      const offsets = new Map<string, StepPose>();
      for (const p of this.placedParts()) {
        const from = fromPoses.get(p.id) ?? REST_POSE;
        const to = this.poseFor(step, p.id);
        offsets.set(p.id, {
          dx: from.dx + (to.dx - from.dx) * t,
          dy: from.dy + (to.dy - from.dy) * t,
          rotationDeg: from.rotationDeg + (to.rotationDeg - from.rotationDeg) * t,
          tempAssetId: to.tempAssetId,
        });
      }
      this.previewOffsets.set(offsets);

      if (t >= 1) {
        const isLast = stepIndex >= skill.steps.length - 1;
        if (isLast && !loop) { this.stopPreview(); return; }
        fromPoses = new Map(this.placedParts().map(p => [p.id, this.poseFor(step, p.id)]));
        stepIndex = isLast ? 0 : stepIndex + 1;
        stepStart = now;
      }
      this.previewRafId = requestAnimationFrame(frame);
    };
    this.previewRafId = requestAnimationFrame(frame);
  }

  stopPreview(): void {
    this.previewPlaying.set(false);
    if (this.previewRafId != null) cancelAnimationFrame(this.previewRafId);
    this.previewRafId = null;
    this.previewOffsets.set(null);
  }

  /** Décalage d'aperçu de la pièce (jeu ou édition d'une étape) — {0,0,0} hors lecture, cf.
   * playPreview. Utilisé par le template pour positionner/tourner/retexturer chaque `.rig-part`. */
  previewFor(partId: string): StepPose {
    return this.previewOffsets()?.get(partId) ?? REST_POSE;
  }

  // ── Sauvegarde / composite ────────────────────────────────────────────────────────────────────

  private loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // Pièce potentiellement servie par storage (Lot 10, contenu utilisateur — cross-origin en
      // dev local où storageApiUrl est un port différent) : sans ça, dessiner l'image dans le
      // canvas ci-dessous le "tainterait" et ferait échouer toBlob() plus loin. Sans effet sur les
      // pièces CC0 (même origine, aucun en-tête CORS requis pour elles).
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Échec de chargement : ${url}`));
      img.src = url;
    });
  }

  private cropToContent(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const ctx = canvas.getContext('2d')!;
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return canvas;
    const pad = 6;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d')!.drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /** Aplatit le montage de REPOS (jamais une pose de compétence) en une image plate — sert d'icône
   * catalogue/liste, jamais utilisée en jeu tant que `rig` reste présent (cf. docstring de la classe). */
  private async compositeFlatPng(): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS; canvas.height = CANVAS;
    const ctx = canvas.getContext('2d')!;
    const cx = CANVAS / 2, cy = CANVAS / 2;
    for (const part of this.placedParts()) {
      const img = await this.loadImage(this.assetUrl(part.assetId));
      ctx.save();
      const px = cx + part.x, py = cy + part.y;
      ctx.translate(px, py);
      if (part.flip) ctx.scale(-1, 1);
      ctx.drawImage(img, -img.width / 2, -img.height / 2, img.width, img.height);
      ctx.restore();
    }
    const cropped = this.cropToContent(canvas);
    return new Promise((resolve, reject) => {
      cropped.toBlob(b => (b ? resolve(b) : reject(new Error('Échec de conversion en image.'))), 'image/png');
    });
  }

  /**
   * Enregistre TOUJOURS déplacement/attaque (mêmes champs que la modale "Modifier" du monstre) —
   * indépendant du montage par pièces/compétences, qui reste optionnel : un monstre à icône plate
   * classique (aucune pièce placée) doit pouvoir régler sa vitesse/portée sans montage. Le rig
   * (parts + skills) et l'icône composite ne partent qu'en plus, s'il y a des pièces posées.
   */
  async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      const patch: Partial<Monster> = {
        movement_patterns: this.movementPatternsValue(),
        move_speed: this.moveSpeed(),
        chase_speed: this.chaseSpeed(),
        jump_strength: this.jumpStrength(),
        attack_range_tiles: this.attackRangeTiles(),
      };
      if (this.placedParts().length > 0) {
        const parts: MonsterRigPart[] = this.placedParts().map(p => ({
          id: p.id, assetId: p.assetId, x: Math.round(p.x), y: Math.round(p.y), flip: p.flip,
          isWeapon: p.isWeapon, collidesTerrain: p.collidesTerrain,
        }));
        const skills: RigSkill[] = this.skills().map(s => ({
          id: s.id, name: s.name, type: s.type,
          steps: s.steps.map((st): RigSkillStep => ({
            durationMs: st.durationMs,
            poses: Object.fromEntries(st.poses),
          })),
        }));
        patch.rig = { parts, skills };
      }
      const iconFile = this.placedParts().length > 0
        ? new File([await this.compositeFlatPng()], `monstre-rig-${this.itemId()}.png`, { type: 'image/png' })
        : null;

      this.api.updateMonster(this.itemId(), patch).subscribe({
        next: () => {
          if (!iconFile) { this.saving.set(false); this.applied.emit(); return; }
          this.api.uploadIconFile('monsters', this.itemId(), iconFile).subscribe({
            next: () => { this.saving.set(false); this.applied.emit(); },
            error: err => { this.saving.set(false); this.error.set(err.error?.detail ?? `Erreur ${err.status}`); },
          });
        },
        error: err => { this.saving.set(false); this.error.set(err.error?.detail ?? `Erreur ${err.status}`); },
      });
    } catch (e) {
      this.saving.set(false);
      this.error.set(e instanceof Error ? e.message : 'Échec du montage.');
    }
  }
}
