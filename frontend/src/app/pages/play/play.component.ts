import { Component, inject, NgZone, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { forkJoin, Observable, of } from 'rxjs';
import Phaser from 'phaser';
import {
  Artifact, ApiService, Block, CatalogueCategoryPath, DepthTier, DepthTierBlockRate,
  DepthTierMonsterSpawn, GameMap, Monster, Projectile, RecipeIngredient, Tool, Weapon,
  World, WorldGenerationRules,
} from '../../core/api.service';
import { colorForBlockId, TierRules } from '../../shared/world/terrain-generation';
import { GameScene, InitialCharacterState } from './game-scene';
import {
  InventoryEntry, WorldBlockDef, WorldItemRef, WorldMonsterDef, WorldMonsterSpawnRate,
  WorldRecipe, WorldToolDef, WorldWeaponDef,
} from './world-types';

interface CatalogBundle {
  blocks: Block[]; tools: Tool[]; items: { id: number; name: string; category: string; icon_url?: string | null }[];
  monsters: Monster[]; weapons: Weapon[]; projectiles: Projectile[]; artifacts: Artifact[];
}

/**
 * `forkJoin([])` (tableau vide) ne complète JAMAIS avec une valeur — un piège RxJS documenté,
 * pas une erreur : sans source à combiner, l'Observable se termine silencieusement sans jamais
 * appeler `next()`. Un `forkJoin({...})` englobant qui dépend de ce résultat reste alors bloqué
 * indéfiniment, sans erreur ni message. Une carte sans monstre (donc `monsterIds` vide) suffit à
 * déclencher ce cas — pas un scénario exotique.
 */
function forkJoinOrEmpty<T>(sources: Observable<T>[]): Observable<T[]> {
  return sources.length ? forkJoin(sources) : of([]);
}

/** Contexte propre à CHAQUE lancement (nouvelle partie vs reprise) — accumulé au fil de la chaîne de chargement. */
interface LaunchContext {
  worldId: number | null;
  worldName: string;
  sourceMapName: string;
  seed: number;
  initialBlockDiff?: Record<string, number | null>;
  initialCharacter?: InitialCharacterState;
}

/** Un autre joueur connecté au même monde (Lot 8) — pour le petit roster affiché en jeu. */
interface RemotePlayer {
  id: string;
  ownerEmail: string;
}

/**
 * Page Jouer (cahier des charges § 3 et § 6) — génère un monde réel à partir
 * des règles de la carte choisie (nouvelle partie) ou d'une sauvegarde
 * (Lot 7) et le rend jouable (déplacement, physique, minage/pose de blocks,
 * monstres, combat, craft) via Phaser. Une fois la partie lancée, se
 * connecte au service relais (Lot 8a) pour diffuser/recevoir la position des
 * autres joueurs et les changements de blocks en temps réel — GameScene ne
 * parle jamais lui-même au réseau, cette classe lit son état (
 * `getPlayerTransform`) et lui applique les mises à jour reçues
 * (`applyRemoteMove`/`applyRemoteBlockChange`). Le relais est un confort, pas
 * une dépendance dure : s'il est injoignable, la partie reste jouable en
 * solo (aucun blocage, juste pas de synchronisation).
 */
@Component({
  selector: 'app-play',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './play.component.html',
})
export class PlayComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private zone = inject(NgZone);

  maps = signal<GameMap[]>([]);
  loadingMaps = signal(true);
  savedWorlds = signal<World[]>([]);
  loadingWorlds = signal(true);
  loadingWorld = signal(false);
  error = signal<string | null>(null);

  selectedMapId: number | null = null;
  newWorldName = '';
  seed = 1;

  playing = signal(false);
  worldId = signal<number | null>(null);
  worldName = signal('');
  inventory = signal<InventoryEntry[]>([]);
  selectedBlockId = signal<number | null>(null);
  equippedWeaponId = signal<number | null>(null);
  miningProgress = signal<number | null>(null);
  miningBlockName = signal<string | null>(null);
  message = signal<string | null>(null);
  hp = signal(100);
  maxHp = signal(100);
  saving = signal(false);

  showCraft = signal(false);
  recipes: WorldRecipe[] = [];

  remotePlayers = signal<RemotePlayer[]>([]);

  private game: Phaser.Game | null = null;
  private scene: GameScene | null = null;
  private messageTimeout?: ReturnType<typeof setTimeout>;
  private pendingLaunchTimeout?: ReturnType<typeof setTimeout>;
  private relaySocket: WebSocket | null = null;
  private moveIntervalId?: ReturnType<typeof setInterval>;
  private selfId: string | null = null;
  private isHost = true;

  ngOnInit(): void {
    this.api.getGameMaps().subscribe({
      next: maps => { this.maps.set(maps); this.loadingMaps.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loadingMaps.set(false); },
    });
    this.refreshWorlds();
  }

  ngOnDestroy(): void {
    this.destroyGame();
  }

  mapById(id: number): GameMap {
    return this.maps().find(m => m.id === id)!;
  }

  private refreshWorlds(): void {
    this.loadingWorlds.set(true);
    this.api.getWorlds().subscribe({
      next: worlds => { this.savedWorlds.set(worlds); this.loadingWorlds.set(false); },
      error: err => { this.error.set(`Erreur ${err.status}`); this.loadingWorlds.set(false); },
    });
  }

  deleteWorld(world: World, event: Event): void {
    event.stopPropagation();
    if (!confirm(`Supprimer définitivement la partie "${world.name}" ?`)) return;
    this.api.deleteWorld(world.id!).subscribe({ next: () => this.refreshWorlds() });
  }

  // ── Nouvelle partie ───────────────────────────────────────────────────────

  startNewGame(map: GameMap): void {
    if (!this.newWorldName.trim()) { this.error.set('Donnez un nom à cette partie.'); return; }
    this.error.set(null);
    this.loadingWorld.set(true);

    this.api.getDepthTiers(map.id!).subscribe({
      next: tiers => {
        if (tiers.length === 0) {
          this.error.set('Cette carte n\'a aucun palier de profondeur — ajoutez-en depuis la page Cartes avant de jouer.');
          this.loadingWorld.set(false);
          return;
        }
        forkJoin({
          blockRates: forkJoin(tiers.map(t => this.api.getDepthTierBlockRates(t.id!))),
          monsterSpawns: forkJoin(tiers.map(t => this.api.getDepthTierMonsterSpawns(t.id!))),
        }).subscribe({
          next: ({ blockRates, monsterSpawns }) => {
            const blockCount = blockRates.reduce((n, list) => n + list.filter(r => r.block != null).length, 0);
            if (blockCount === 0) {
              this.error.set('Aucun bloc défini pour les paliers de cette carte — impossible de générer un monde.');
              this.loadingWorld.set(false);
              return;
            }
            const tierRules = this.buildTierRules(tiers, blockRates);
            const monsterSpawnsByTier = this.buildMonsterSpawnsByTier(tiers, monsterSpawns);
            this.loadCatalogAndLaunch(tierRules, monsterSpawnsByTier, {
              worldId: null, worldName: this.newWorldName.trim(), sourceMapName: map.name, seed: this.seed || 1,
            });
          },
          error: () => { this.error.set('Erreur lors du chargement des taux de blocks/monstres.'); this.loadingWorld.set(false); },
        });
      },
      error: () => { this.error.set('Erreur lors du chargement des paliers.'); this.loadingWorld.set(false); },
    });
  }

  private buildTierRules(tiers: DepthTier[], blockRateLists: DepthTierBlockRate[][]): TierRules[] {
    return tiers.map((t, i) => ({
      depthIndex: t.depth_index,
      voidRate: t.void_rate,
      blockRates: blockRateLists[i]
        .filter(r => r.block != null)
        .map(r => ({
          blockId: r.block as number, blockName: r.block_name ?? '',
          color: colorForBlockId(r.block as number), rate: r.rate,
        })),
    }));
  }

  private buildMonsterSpawnsByTier(
    tiers: DepthTier[], monsterSpawnLists: DepthTierMonsterSpawn[][],
  ): Map<number, WorldMonsterSpawnRate[]> {
    const map = new Map<number, WorldMonsterSpawnRate[]>();
    tiers.forEach((t, i) => {
      map.set(t.depth_index, monsterSpawnLists[i]
        .filter(s => s.monster != null)
        .map(s => ({ monsterId: s.monster as number, chance: s.spawn_chance })));
    });
    return map;
  }

  // ── Reprise d'une partie sauvegardée (Lot 7) ─────────────────────────────

  continueGame(world: World): void {
    this.error.set(null);
    this.loadingWorld.set(true);

    forkJoin({
      detail: this.api.getWorld(world.id!),
      character: this.api.getCharacter(world.id!),
    }).subscribe({
      next: ({ detail, character }) => {
        const tierRules = detail.generation_rules.tiers;
        const monsterSpawnsByTier = new Map<number, WorldMonsterSpawnRate[]>(
          detail.generation_rules.monsterSpawns.map(e => [e.depthIndex, e.spawns]),
        );
        // `created` = get_or_create vient de créer cette ligne (aucune sauvegarde antérieure) :
        // (x=0, y=0) ne correspond à aucun endroit réel du monde — laisser GameScene retomber sur
        // sa recherche de spawn normale plutôt que de "restaurer" une position bidon. Cas concret
        // en multijoueur : un deuxième joueur qui rejoint un monde tout juste créé par un autre,
        // avant sa première sauvegarde.
        const initialCharacter: InitialCharacterState | undefined = character.created ? undefined : {
          hp: character.hp,
          positionX: character.position_x,
          positionY: character.position_y,
          inventory: Object.fromEntries(Object.entries(character.inventory).map(([id, qty]) => [Number(id), qty])),
          equippedWeaponId: character.equipped_weapon_id,
        };
        this.loadCatalogAndLaunch(tierRules, monsterSpawnsByTier, {
          worldId: detail.id!, worldName: detail.name, sourceMapName: detail.source_map_name ?? '',
          seed: detail.seed, initialBlockDiff: detail.block_diff, initialCharacter,
        });
      },
      error: () => { this.error.set('Erreur lors du chargement de la partie sauvegardée.'); this.loadingWorld.set(false); },
    });
  }

  // ── Chaîne de chargement du catalogue, commune aux deux entrées ci-dessus ──

  private loadCatalogAndLaunch(
    tierRules: TierRules[], monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>, ctx: LaunchContext,
  ): void {
    const blockIds = [...new Set(tierRules.flatMap(t => t.blockRates.map(r => r.blockId)))];
    const monsterIds = [...new Set([...monsterSpawnsByTier.values()].flatMap(list => list.map(s => s.monsterId)))];

    forkJoin({
      blocks: this.api.getBlocks(),
      tools: this.api.getTools(),
      items: this.api.getItems(),
      monsters: this.api.getMonsters(),
      weapons: this.api.getWeapons(),
      projectiles: this.api.getProjectiles(),
      artifacts: this.api.getArtifacts(),
    }).subscribe({
      next: catalog => this.onCatalogLoaded(tierRules, monsterSpawnsByTier, blockIds, monsterIds, catalog, ctx),
      error: () => { this.error.set('Erreur lors du chargement du catalogue.'); this.loadingWorld.set(false); },
    });
  }

  private onCatalogLoaded(
    tierRules: TierRules[], monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>,
    blockIds: number[], monsterIds: number[], catalog: CatalogBundle, ctx: LaunchContext,
  ): void {
    forkJoin({
      blockDrops: forkJoinOrEmpty(blockIds.map(id => this.api.getBlockDrops(id))),
      monsterDrops: forkJoinOrEmpty(monsterIds.map(id => this.api.getMonsterDrops(id))),
    }).subscribe({
      next: ({ blockDrops, monsterDrops }) => this.onDropsLoaded(
        tierRules, monsterSpawnsByTier, blockIds, monsterIds, catalog, blockDrops, monsterDrops, ctx,
      ),
      error: () => { this.error.set('Erreur lors du chargement des tables de drop.'); this.loadingWorld.set(false); },
    });
  }

  private onDropsLoaded(
    tierRules: TierRules[], monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>,
    blockIds: number[], monsterIds: number[], catalog: CatalogBundle,
    blockDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    monsterDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    ctx: LaunchContext,
  ): void {
    // Recette potentielle pour tout objet des 5 catégories craftables (1.1) — le craft n'est pas
    // limité aux blocks/outils utilisés dans cette carte, tout le catalogue reste fabricable.
    const recipeTargets: { category: CatalogueCategoryPath; id: number; name: string }[] = [
      ...catalog.weapons.map(w => ({ category: 'weapons' as const, id: w.id!, name: w.name })),
      ...catalog.projectiles.map(p => ({ category: 'projectiles' as const, id: p.id!, name: p.name })),
      ...catalog.artifacts.map(a => ({ category: 'artifacts' as const, id: a.id!, name: a.name })),
      ...catalog.tools.map(t => ({ category: 'tools' as const, id: t.id!, name: t.name })),
      ...catalog.blocks.map(b => ({ category: 'blocks' as const, id: b.id!, name: b.name })),
    ];
    forkJoinOrEmpty(recipeTargets.map(t => this.api.getRecipe(t.category, t.id))).subscribe({
      next: recipeLists => this.onRecipesLoaded(
        tierRules, monsterSpawnsByTier, blockIds, monsterIds, catalog,
        blockDropLists, monsterDropLists, recipeTargets, recipeLists, ctx,
      ),
      error: () => { this.error.set('Erreur lors du chargement des recettes.'); this.loadingWorld.set(false); },
    });
  }

  private onRecipesLoaded(
    tierRules: TierRules[], monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>,
    blockIds: number[], monsterIds: number[], catalog: CatalogBundle,
    blockDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    monsterDropLists: { dropped_item: number | null; quantity: number; chance: number }[][],
    recipeTargets: { category: CatalogueCategoryPath; id: number; name: string }[],
    recipeLists: RecipeIngredient[][],
    ctx: LaunchContext,
  ): void {
    const blockDefs = new Map<number, WorldBlockDef>();
    blockIds.forEach((id, i) => {
      const b = catalog.blocks.find(bl => bl.id === id);
      if (!b) return;
      const flow = (b.flow_behavior ?? {}) as Record<string, unknown>;
      const spreadChance = typeof flow['spread_chance'] === 'number' ? flow['spread_chance'] as number : 0.5;
      blockDefs.set(id, {
        id, name: b.name, color: colorForBlockId(id), hardness: b.hardness, isLiquid: b.is_liquid,
        flowSpreadChance: spreadChance,
        drops: blockDropLists[i]
          .filter(d => d.dropped_item != null)
          .map(d => ({ itemId: d.dropped_item as number, quantity: d.quantity, chance: d.chance })),
      });
    });

    const toolDefs: WorldToolDef[] = catalog.tools.map(t => ({ id: t.id!, name: t.name, power: t.power, speed: t.speed }));

    const itemsById = new Map<number, WorldItemRef>();
    catalog.items.forEach(it => itemsById.set(it.id, { id: it.id, name: it.name, category: it.category, iconUrl: it.icon_url ?? null }));

    const monsterDefs = new Map<number, WorldMonsterDef>();
    monsterIds.forEach((id, i) => {
      const m = catalog.monsters.find(mo => mo.id === id);
      if (!m) return;
      monsterDefs.set(id, {
        id, name: m.name, hp: m.hp, detectionRange: m.detection_range, attackType: m.attack_type,
        attackDamage: m.attack_damage, attackRate: m.attack_rate, movementPatterns: m.movement_patterns,
        drops: monsterDropLists[i]
          .filter(d => d.dropped_item != null)
          .map(d => ({ itemId: d.dropped_item as number, quantity: d.quantity, chance: d.chance })),
      });
    });

    const weaponDefs: WorldWeaponDef[] = catalog.weapons.map(w => ({
      id: w.id!, name: w.name, style: w.style, damage: w.damage, attackRange: w.attack_range, attackRate: w.attack_rate,
    }));

    const recipes: WorldRecipe[] = recipeTargets
      .map((target, i) => ({ target, ingredients: recipeLists[i] ?? [] }))
      .filter(({ ingredients }) => ingredients.length > 0)
      .map(({ target, ingredients }) => ({
        itemId: target.id,
        itemName: target.name,
        ingredients: ingredients.map(ing => ({ itemId: ing.ingredient!, quantity: ing.quantity })),
      }));
    this.recipes = recipes;

    if (ctx.worldId != null) {
      this.loadingWorld.set(false);
      this.launchPhaser(tierRules, blockDefs, toolDefs, itemsById, monsterDefs, monsterSpawnsByTier, weaponDefs, ctx);
      return;
    }

    // Nouvelle partie : la sauvegarde n'existe pas encore côté serveur — on la crée maintenant
    // que les règles de génération complètes (blocks + monstres) sont connues.
    const generationRules: WorldGenerationRules = {
      tiers: tierRules,
      monsterSpawns: [...monsterSpawnsByTier.entries()].map(([depthIndex, spawns]) => ({ depthIndex, spawns })),
    };
    this.api.createWorld({
      name: ctx.worldName, source_map_name: ctx.sourceMapName, seed: ctx.seed, generation_rules: generationRules,
    }).subscribe({
      next: created => {
        this.loadingWorld.set(false);
        this.launchPhaser(tierRules, blockDefs, toolDefs, itemsById, monsterDefs, monsterSpawnsByTier, weaponDefs, {
          ...ctx, worldId: created.id!,
        });
      },
      error: () => { this.error.set('Erreur lors de la création de la partie.'); this.loadingWorld.set(false); },
    });
  }

  private launchPhaser(
    tiers: TierRules[], blockDefs: Map<number, WorldBlockDef>, tools: WorldToolDef[], itemsById: Map<number, WorldItemRef>,
    monsters: Map<number, WorldMonsterDef>, monsterSpawnsByTier: Map<number, WorldMonsterSpawnRate[]>,
    weapons: WorldWeaponDef[], ctx: LaunchContext,
  ): void {
    this.destroyGame();
    this.inventory.set([]);
    this.selectedBlockId.set(null);
    this.equippedWeaponId.set(ctx.initialCharacter?.equippedWeaponId ?? null);
    this.miningProgress.set(null);
    this.showCraft.set(false);
    this.worldId.set(ctx.worldId);
    this.worldName.set(ctx.worldName);
    // Le conteneur #phaser-container n'existe dans le DOM qu'une fois `playing`
    // passé à true (bloc @if du template) — Phaser résout son `parent` par id
    // dès la construction de Phaser.Game, donc il faut laisser Angular rendre
    // le div avant de l'appeler, sous peine d'un fallback silencieux vers
    // document.body (aucune erreur, juste un canvas qui n'apparaît jamais là
    // où l'overlay l'attend).
    this.playing.set(true);

    this.pendingLaunchTimeout = setTimeout(() => {
      this.zone.runOutsideAngular(() => {
        this.scene = new GameScene({
          seed: ctx.seed,
          tiers,
          blockDefs,
          tools,
          itemsById,
          monsters,
          monsterSpawnsByTier,
          weapons,
          recipes: this.recipes,
          initialBlockDiff: ctx.initialBlockDiff,
          initialCharacter: ctx.initialCharacter,
          onInventoryChange: entries => this.zone.run(() => this.inventory.set(entries)),
          onMiningProgress: (progress, blockName) => this.zone.run(() => {
            this.miningProgress.set(progress);
            this.miningBlockName.set(blockName);
          }),
          onMessage: text => this.zone.run(() => this.showMessage(text)),
          onHpChange: (hp, maxHp) => this.zone.run(() => { this.hp.set(hp); this.maxHp.set(maxHp); }),
          onNetworkSend: msg => {
            if (this.relaySocket?.readyState === WebSocket.OPEN) this.relaySocket.send(JSON.stringify(msg));
          },
        });
        this.game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: 'phaser-container',
          width: 960,
          height: 560,
          backgroundColor: '#1b2430',
          physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
          scene: [this.scene],
        });
      });
    }, 0);

    // worldId est toujours résolu à ce stade (soit repris tel quel dans onRecipesLoaded pour une
    // reprise, soit rempli juste après la création du World pour une nouvelle partie) — jamais
    // appelé avec worldId encore null.
    this.connectRelay(ctx.worldId!);
  }

  // ── Multijoueur (Lot 8a/8b) ────────────────────────────────────────────────

  /**
   * Confort, pas dépendance dure : toute erreur ici (billet refusé, relais
   * injoignable, WebSocket qui ne s'ouvre pas) laisse simplement la partie en
   * solo — jamais de blocage ni de message d'erreur affiché pour ça, cf.
   * docstring de la classe.
   */
  private connectRelay(worldId: number): void {
    this.remotePlayers.set([]);
    this.selfId = null;
    this.isHost = true; // hypothèse par défaut tant que le relais n'a pas confirmé — cf. GameScene.configureNetworkRole
    this.api.getRelayTicket(worldId).subscribe({
      next: ({ ticket }) => {
        const ws = new WebSocket(`${this.api.relayUrl}?ticket=${encodeURIComponent(ticket)}`);
        this.relaySocket = ws;
        ws.onmessage = ev => {
          let msg: { type: string; id?: string; [k: string]: unknown };
          try { msg = JSON.parse(ev.data); } catch { return; }
          this.zone.run(() => this.handleRelayMessage(msg));
        };
        ws.onopen = () => this.startPositionBroadcast();
        ws.onclose = () => { this.relaySocket = null; this.stopPositionBroadcast(); };
        ws.onerror = () => { /* dégradation silencieuse en solo */ };
      },
      error: () => { /* dégradation silencieuse en solo */ },
    });
  }

  private handleRelayMessage(msg: { type: string; id?: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'welcome': {
        this.selfId = msg['selfId'] as string;
        const hostId = msg['hostId'] as string;
        this.isHost = hostId === this.selfId;
        this.scene?.configureNetworkRole(this.selfId, this.isHost);
        const players = (msg['players'] as { id: string; ownerEmail: string }[])
          .filter(p => p.id !== this.selfId);
        this.remotePlayers.set(players);
        for (const p of players) this.scene?.addRemotePlayer(p.id, p.ownerEmail);
        break;
      }
      case 'host-changed': {
        const hostId = msg['hostId'] as string;
        this.isHost = hostId === this.selfId;
        if (this.selfId) this.scene?.configureNetworkRole(this.selfId, this.isHost);
        break;
      }
      case 'player-joined': {
        const player = { id: msg.id!, ownerEmail: msg['ownerEmail'] as string };
        this.remotePlayers.update(list => [...list, player]);
        this.scene?.addRemotePlayer(player.id, player.ownerEmail);
        break;
      }
      case 'player-left':
        this.remotePlayers.update(list => list.filter(p => p.id !== msg.id));
        this.scene?.removeRemotePlayer(msg.id!);
        break;
      case 'move':
        this.scene?.applyRemoteMove(msg.id!, msg['x'] as number, msg['y'] as number, msg['flipX'] as boolean);
        break;
      case 'block-change':
        this.scene?.applyRemoteBlockChange(msg['x'] as number, msg['y'] as number, msg['blockId'] as number | null);
        break;
      case 'monster-spawn':
        this.scene?.applyMonsterSpawn(
          msg['monsterId'] as string, msg['defId'] as number, msg['x'] as number, msg['y'] as number, msg['hp'] as number,
        );
        break;
      case 'monster-state':
        this.scene?.applyMonsterState(msg['monsters'] as { monsterId: string; x: number; y: number; hp: number }[]);
        break;
      case 'monster-death':
        this.scene?.applyMonsterDeath(msg['monsterId'] as string);
        break;
      case 'attack-request':
        // Seul l'hôte est autoritaire sur ses monstres — un non-hôte qui reçoit ça (cas rare :
        // deux clients se croient hôte un court instant après un host-changed) l'ignore simplement.
        if (this.isHost) {
          this.scene?.resolveAttackRequest(
            msg.id!, msg['monsterId'] as string, msg['weaponId'] as number | null, msg['x'] as number, msg['y'] as number,
          );
        }
        break;
      case 'loot':
        if (msg['targetId'] === this.selfId) this.scene?.applyLoot(msg['itemId'] as number, msg['quantity'] as number);
        break;
      case 'player-damage':
        if (msg['targetId'] === this.selfId) this.scene?.applyIncomingDamage(msg['damage'] as number);
        break;
      default:
        break; // protocole ouvert à extension — types inconnus ignorés
    }
  }

  private startPositionBroadcast(): void {
    this.stopPositionBroadcast();
    this.moveIntervalId = setInterval(() => {
      if (!this.scene || this.relaySocket?.readyState !== WebSocket.OPEN) return;
      const t = this.scene.getPlayerTransform();
      this.relaySocket.send(JSON.stringify({ type: 'move', x: t.x, y: t.y, flipX: t.flipX }));
    }, 150);
  }

  private stopPositionBroadcast(): void {
    if (this.moveIntervalId) { clearInterval(this.moveIntervalId); this.moveIntervalId = undefined; }
  }

  private disconnectRelay(): void {
    this.stopPositionBroadcast();
    if (this.relaySocket) { this.relaySocket.onclose = null; this.relaySocket.close(); this.relaySocket = null; }
    this.remotePlayers.set([]);
    this.selfId = null;
    this.isHost = true;
  }

  selectInventoryItem(entry: InventoryEntry): void {
    if (entry.category === 'block') {
      const next = this.selectedBlockId() === entry.itemId ? null : entry.itemId;
      this.selectedBlockId.set(next);
      this.scene?.setSelectedBlock(next);
    } else if (entry.category === 'weapon') {
      const next = this.equippedWeaponId() === entry.itemId ? null : entry.itemId;
      this.equippedWeaponId.set(next);
      this.scene?.setEquippedWeapon(next);
    }
  }

  craftableRecipes(): (WorldRecipe & { canCraft: boolean; ingredientLabel: string })[] {
    const inv = this.inventory();
    const nameOf = (id: number) => inv.find(e => e.itemId === id)?.name ?? `#${id}`;
    const qtyOf = (id: number) => inv.find(e => e.itemId === id)?.quantity ?? 0;
    return this.recipes.map(r => ({
      ...r,
      canCraft: r.ingredients.every(ing => qtyOf(ing.itemId) >= ing.quantity),
      ingredientLabel: r.ingredients.map(ing => `${ing.quantity}× ${nameOf(ing.itemId)} (${qtyOf(ing.itemId)} dispo)`).join(', '),
    }));
  }

  craft(itemId: number): void {
    this.scene?.craftItem(itemId);
  }

  toggleCraft(): void {
    this.showCraft.update(v => !v);
  }

  // ── Sauvegarde (Lot 7) ────────────────────────────────────────────────────

  save(): void {
    const id = this.worldId();
    if (!this.scene || id == null || this.saving()) return;
    this.saving.set(true);
    const blockDiff = this.scene.getBlockDiff();
    const character = this.scene.getCharacterState();
    this.api.saveProgress(id, {
      block_diff: blockDiff,
      character: {
        hp: character.hp, position_x: character.positionX, position_y: character.positionY,
        inventory: Object.fromEntries(Object.entries(character.inventory).map(([k, v]) => [String(k), v])),
        equipped_weapon_id: character.equippedWeaponId,
      },
    }).subscribe({
      next: () => { this.saving.set(false); this.showMessage('Partie sauvegardée.'); },
      error: () => { this.saving.set(false); this.showMessage('Erreur lors de la sauvegarde.'); },
    });
  }

  quit(): void {
    const id = this.worldId();
    if (this.scene && id != null) {
      const blockDiff = this.scene.getBlockDiff();
      const character = this.scene.getCharacterState();
      this.api.saveProgress(id, {
        block_diff: blockDiff,
        character: {
          hp: character.hp, position_x: character.positionX, position_y: character.positionY,
          inventory: Object.fromEntries(Object.entries(character.inventory).map(([k, v]) => [String(k), v])),
          equipped_weapon_id: character.equippedWeaponId,
        },
      }).subscribe({
        next: () => { this.destroyGame(); this.refreshWorlds(); },
        error: () => { this.destroyGame(); this.refreshWorlds(); },
      });
    } else {
      this.destroyGame();
    }
  }

  private destroyGame(): void {
    if (this.pendingLaunchTimeout) { clearTimeout(this.pendingLaunchTimeout); this.pendingLaunchTimeout = undefined; }
    this.disconnectRelay();
    if (this.game) { this.game.destroy(true); this.game = null; }
    this.scene = null;
    this.worldId.set(null);
    this.playing.set(false);
  }

  private showMessage(text: string): void {
    this.message.set(text);
    if (this.messageTimeout) clearTimeout(this.messageTimeout);
    this.messageTimeout = setTimeout(() => this.message.set(null), 3000);
  }
}
