/**
 * Information-set MCTS play evaluator (self-play-league task 2.1).
 *
 * A custom `AutomatedActionStrategy` (the same object contract
 * `tunable-strategy.ts` / `learned-strategy.ts` use): it wraps the shipped
 * `best-deck-aware-lore-race` heuristic and re-orders the planner's own
 * candidate list by search value. The vendored engine is untouched — the
 * search simulates on clones of the authoritative state through the engine's
 * public constructor + `loadState` (the same restore path the vendor's
 * serialization.ts uses for production persistence).
 *
 * Search shape, per decision (documented design):
 * - Only "strategic" decisions are searched: >= 2 candidates with at least
 *   one playCard / quest / challenge / ink / activateAbility candidate.
 *   Forced chains (resolveBag/resolveEffect steps, single-candidate states)
 *   inherit the base ordering unchanged.
 * - Each of `iterations` (default 150) iterations:
 *     1. determinize a clone of the authoritative state — the opponent's
 *        hand ∪ deck instances are re-dealt uniformly (counts are public),
 *        and both deck orders are shuffled — sampling a world consistent
 *        with the actor's information set. Opponent inkwell identities are
 *        left in place (only their count is visible; spent ink has no
 *        future options). Pending reveals referencing re-dealt instances
 *        are not rewound (transient; playouts are short).
 *     2. restore the clone into a reused simulation engine and force-play
 *        the UCB-selected root candidate (one-candidate wrapper strategy;
 *        the engine's planner validates/executes top-down).
 *     3. playout with the heuristic policy (the wrapped base strategy for
 *        both seats) until game end, the end of the turn after the
 *        decision's turn (`playoutTurns`, default 1), or `maxPlayoutActions`
 *        (default 12) — whichever comes first.
 *     4. backpropagate a value: terminal win/loss = ±1, otherwise the lore
 *        margin scaled by the lore-to-win target and clamped to [-1, 1]
 *        (denser signal than raw win/loss at shallow playout depths).
 * - The tree is the root decision's candidate list (one UCB level); deeper
 *   lookahead happens only through heuristic playouts. The final ordering
 *   places searched candidates by mean value (ties → base rank), unvisited
 *   candidates after them in base order.
 * - Determinization uses a `mulberry32` stream seeded from
 *   (game seed, decision counter, decision fingerprint) — identical
 *   (seed, state) pairs replay identically; no `Math.random` anywhere.
 *
 * Known limits (honest approximations): a root candidate may reference an
 * opponent hand instance that the determinization moved (discard-forcing
 * effects); the engine then rejects it and the iteration scores the
 * pass-turn fallback. Engine RNG state continues from the cloned state, so
 * playouts are exact continuations of each determinized world.
 */
import { createLorcanaServerGame } from '@tcg/lorcana-engine';
import { mulberry32 } from '../prng';

/** structural views of the engine's planner types (loose, read-only) */
interface CandidateView {
  family: string;
  cardId?: string;
  attackerId?: string;
  defenderId?: string;
  bagId?: string;
  effectId?: string;
  firstPlayerId?: string;
  characterId?: string;
  locationId?: string;
  abilityIndex?: number;
}

interface SummaryView {
  candidate: CandidateView;
  stableKey?: string;
}

interface ContextView {
  actorId: string;
  opponentId?: string;
  turnNumber?: number;
  board?: {
    winner?: unknown;
    turnNumber?: number;
    players?: Record<string, { lore?: number }>;
  };
  authoritativeHints?: {
    state?: unknown;
  };
}

interface BaseStrategyView {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: ContextView,
    candidates: readonly unknown[],
  ): SummaryView[];
}

export interface IsMctsStrategyView {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: ContextView,
    candidates: readonly unknown[],
  ): SummaryView[];
}

/** board slice the search reads after a playout */
export interface SimBoard {
  winner?: unknown;
  turnNumber?: number;
  players?: Record<string, { lore?: number }>;
}

/** the simulation engine surface the search needs (vendored server or fake) */
export interface SimEngine {
  loadState(state: unknown): void;
  getCurrentActorId(): string | undefined;
  getBoard(): SimBoard;
  takeAutomatedActionForCurrentActor(options: { strategy: unknown }): unknown;
}

export type SimEngineFactory = (state: unknown) => SimEngine;

/** cardsMaps shape (`deterministicCardsMaps` output) for the default factory */
export interface SimCardsMaps {
  cardInstances: Record<string, string>;
  owners: Record<string, string[]>;
}

export interface IsMctsOptions {
  /** per-game seed — the same seed replays the same decision */
  seed: string;
  /** search budget per decision (default 150) */
  iterations?: number;
  /** hard playout action cap (default 12) */
  maxPlayoutActions?: number;
  /** playout through the end of this many further turns (default 1) */
  playoutTurns?: number;
  /** UCB1 exploration constant (default 1.2) */
  exploration?: number;
  /**
   * simulator factory (injectable for tests). Default: restore the state
   * into a vendored `createLorcanaServerGame` instance — requires `cardsMaps`
   * and `cardCatalog` matching the live game.
   */
  createEngine?: SimEngineFactory;
  /** instance → definition map of THIS game (default-factory input) */
  cardsMaps?: SimCardsMaps;
  /** engine card catalog (default-factory input) */
  cardCatalog?: unknown;
}

/** authoritative-state slices the determinizer touches */
interface StateView {
  ctx?: {
    random?: { seed?: string; draws?: number };
    matchID?: string;
    gameID?: string;
    status?: { choosingFirstPlayer?: string };
    zones?: {
      private?: {
        zoneCards?: Record<string, string[]>;
        cardIndex?: Record<
          string,
          { zoneKey?: string; index?: number; ownerID?: string }
        >;
      };
    };
  };
  G?: { loreToWin?: number };
}

const DEFAULT_ITERATIONS = 150;
const DEFAULT_MAX_PLAYOUT_ACTIONS = 12;
const DEFAULT_PLAYOUT_TURNS = 1;
const DEFAULT_EXPLORATION = 1.2;

/** families whose choice actually shapes the game — everything else is
 * mostly forced resolution the base strategy already handles */
const SEARCH_FAMILIES = new Set([
  'playCard',
  'quest',
  'challenge',
  'putCardIntoInkwell',
  'activateAbility',
  'moveCharacterToLocation',
]);

/** FNV-1a → uint32, the arena's cheap stable string hash */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** stable per-candidate key (structural subset of the planner's key) */
function candidateKey(candidate: CandidateView): string {
  switch (candidate.family) {
    case 'playCard':
      return `playCard:${candidate.cardId ?? ''}`;
    case 'putCardIntoInkwell':
      return `putCardIntoInkwell:${candidate.cardId ?? ''}`;
    case 'quest':
      return `quest:${candidate.cardId ?? ''}`;
    case 'challenge':
      return `challenge:${candidate.attackerId ?? ''}:${candidate.defenderId ?? ''}`;
    case 'activateAbility':
      return `activateAbility:${candidate.cardId ?? ''}:${candidate.abilityIndex ?? ''}`;
    case 'moveCharacterToLocation':
      return `move:${candidate.characterId ?? ''}:${candidate.locationId ?? ''}`;
    case 'resolveBag':
      return `resolveBag:${candidate.bagId ?? ''}`;
    case 'resolveEffect':
      return `resolveEffect:${candidate.effectId ?? ''}`;
    default:
      return `${candidate.family}:${candidate.cardId ?? candidate.firstPlayerId ?? ''}`;
  }
}

/** Fisher-Yates over a mutable array (rng: seeded mulberry32 stream) */
function shuffle<T>(items: T[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

/**
 * Determinize hidden zones in-place on a state CLONE: shuffle the actor's
 * deck order, then re-deal the opponent's hand ∪ deck (hand count is
 * public). Card-index entries are kept consistent with zone membership.
 */
export function determinizeHiddenZones(
  state: StateView,
  actorId: string,
  opponentId: string,
  rng: () => number,
): void {
  const zoneCards = state.ctx?.zones?.private?.zoneCards;
  const cardIndex = state.ctx?.zones?.private?.cardIndex;
  if (!zoneCards || !cardIndex) return;
  const reindex = (zoneKey: string): void => {
    const ids = zoneCards[zoneKey];
    if (!ids) return;
    for (const [index, id] of ids.entries()) {
      const entry = cardIndex[id];
      if (entry) {
        entry.zoneKey = zoneKey;
        entry.index = index;
      }
    }
  };
  const actorDeck = `deck:${actorId}`;
  if (zoneCards[actorDeck]?.length) {
    shuffle(zoneCards[actorDeck]!, rng);
    reindex(actorDeck);
  }
  const oppHandKey = `hand:${opponentId}`;
  const oppDeckKey = `deck:${opponentId}`;
  const hand = zoneCards[oppHandKey] ?? [];
  const deck = zoneCards[oppDeckKey] ?? [];
  if (!hand.length && !deck.length) return;
  const pool = [...hand, ...deck];
  shuffle(pool, rng);
  zoneCards[oppHandKey] = pool.slice(0, hand.length);
  zoneCards[oppDeckKey] = pool.slice(hand.length);
  reindex(oppHandKey);
  reindex(oppDeckKey);
}

/**
 * Default simulator factory: restore a state clone into a fresh vendored
 * engine (`_skipInitialization` + `loadState` — the vendor serialization.ts
 * restore path). Requires the game's cardsMaps + card catalog.
 */
export function defaultSimEngineFactory(
  cardsMaps: SimCardsMaps,
  cardCatalog: unknown,
): SimEngineFactory {
  return (state) => {
    const view = state as StateView;
    const players = Object.keys(cardsMaps.owners).map((id) => ({ id }));
    const engine = createLorcanaServerGame(
      players.map((player) => ({ player })),
      {
        seed: view.ctx?.random?.seed ?? 'is-mcts',
        cardsMaps: cardsMaps as never,
        cardCatalog: cardCatalog as never,
        players,
        matchID: view.ctx?.matchID,
        gameID: view.ctx?.gameID,
        goingFirst: (view.ctx?.status?.choosingFirstPlayer ?? 'p1') as
          | 'p1'
          | 'p2',
        capturePatches: true,
        _skipInitialization: true,
      },
    );
    engine.loadState(state as never);
    return engine as unknown as SimEngine;
  };
}

/**
 * Build the IS-MCTS evaluator around a base strategy. The base supplies the
 * candidate summaries (its ordering is the playout policy and the fallback
 * order); the search re-orders them by value.
 */
export function isMctsStrategy(
  base: BaseStrategyView,
  opts: IsMctsOptions,
): IsMctsStrategyView {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const maxPlayoutActions =
    opts.maxPlayoutActions ?? DEFAULT_MAX_PLAYOUT_ACTIONS;
  const playoutTurns = opts.playoutTurns ?? DEFAULT_PLAYOUT_TURNS;
  const exploration = opts.exploration ?? DEFAULT_EXPLORATION;
  if (iterations < 1) throw new Error('is-mcts: iterations must be >= 1');
  const createEngine =
    opts.createEngine ??
    (() => {
      if (!opts.cardsMaps || !opts.cardCatalog)
        throw new Error(
          'is-mcts: the default simulator needs cardsMaps + cardCatalog (or inject createEngine)',
        );
      return defaultSimEngineFactory(opts.cardsMaps, opts.cardCatalog);
    })();

  let sim: SimEngine | null = null;
  let decisionCounter = 0;

  const name = `is-mcts(i${iterations})`;

  return {
    name,
    informationPolicy: base.informationPolicy,
    summarizeCandidates(context, candidates) {
      const baseOrder = base.summarizeCandidates(context, candidates);
      decisionCounter += 1;
      if (
        baseOrder.length < 2 ||
        !baseOrder.some((summary) =>
          SEARCH_FAMILIES.has(summary.candidate.family),
        ) ||
        typeof context.board?.winner === 'string' ||
        !context.authoritativeHints?.state
      ) {
        return baseOrder; // forced or terminal step: no search
      }
      const actorId = context.actorId;
      const opponentId = context.opponentId ?? (actorId === 'p1' ? 'p2' : 'p1');
      const rawState = context.authoritativeHints.state as StateView;

      const fingerprint = [
        context.turnNumber ?? 0,
        actorId,
        context.board?.players?.[actorId]?.lore ?? 0,
        context.board?.players?.[opponentId]?.lore ?? 0,
        baseOrder.map((s) => candidateKey(s.candidate)).join('|'),
      ].join('#');
      const rng = mulberry32(
        hashSeed(`${opts.seed}|${decisionCounter}|${fingerprint}`),
      );

      if (!sim) sim = createEngine(rawState);

      interface Child {
        summary: SummaryView;
        baseRank: number;
        visits: number;
        value: number;
      }
      const children: Child[] = baseOrder.map((summary, baseRank) => ({
        summary,
        baseRank,
        visits: 0,
        value: 0,
      }));

      const loreToWin = Math.max(1, rawState.G?.loreToWin ?? 20);
      const startTurn = context.board?.turnNumber ?? 0;

      for (let iteration = 0; iteration < iterations; iteration++) {
        // UCB1 selection: unvisited children first (base order), then the
        // highest mean + exploration bonus, ties → base rank
        let selected = children[0]!;
        if (children.some((child) => child.visits === 0)) {
          selected = children.find((child) => child.visits === 0)!;
        } else {
          const total = children.reduce((sum, child) => sum + child.visits, 0);
          let bestScore = Number.NEGATIVE_INFINITY;
          for (const child of children) {
            const score =
              child.value / child.visits +
              exploration *
                Math.sqrt(Math.log(total) / Math.max(1, child.visits));
            if (score > bestScore) {
              bestScore = score;
              selected = child;
            }
          }
        }

        // determinize + restore this iteration's world
        const world = structuredClone(rawState);
        determinizeHiddenZones(world, actorId, opponentId, rng);
        sim.loadState(world);

        // force-play the selected root candidate (planner validates/executes)
        sim.takeAutomatedActionForCurrentActor({
          strategy: {
            name: `${name}:forced`,
            summarizeCandidates: () => [
              {
                candidate: selected.summary.candidate,
                stableKey: `is-mcts:${candidateKey(selected.summary.candidate)}`,
                family: selected.summary.candidate.family,
                heuristics: [],
              },
            ],
          },
        });

        // playout with the heuristic policy until the value horizon
        for (let action = 0; action < maxPlayoutActions; action++) {
          const board = sim.getBoard();
          if (typeof board.winner === 'string') break;
          if ((board.turnNumber ?? 0) > startTurn + playoutTurns) break;
          if (!sim.getCurrentActorId()) break;
          sim.takeAutomatedActionForCurrentActor({ strategy: base });
        }

        // value: terminal ±1, else clamped lore margin / lore-to-win
        const board = sim.getBoard();
        let value: number;
        if (board.winner === actorId) value = 1;
        else if (typeof board.winner === 'string') value = -1;
        else {
          const my = board.players?.[actorId]?.lore ?? 0;
          const opp = board.players?.[opponentId]?.lore ?? 0;
          value = Math.max(-1, Math.min(1, (my - opp) / loreToWin));
        }
        selected.visits += 1;
        selected.value += value;
      }

      const searched = children
        .filter((child) => child.visits > 0)
        .sort(
          (a, b) =>
            b.value / b.visits - a.value / a.visits || a.baseRank - b.baseRank,
        );
      const unsearched = children
        .filter((child) => child.visits === 0)
        .sort((a, b) => a.baseRank - b.baseRank);
      return [...searched, ...unsearched].map((child) => child.summary);
    },
  };
}
