/**
 * Browser bundle entry for the vendored engine (engine-winrate): wraps the
 * pinned checkout's full-rules game + the shipped heuristic bot into a
 * lazy-loadable ESM file under public/data/.
 *
 * Bundled by scripts/training/build-engine-bundle.ts, which injects the pin
 * metadata and the identity→engine-id table as compile-time defines — this
 * file must never import node builtins or read the filesystem, because the
 * artifact runs in the browser.
 *
 * Deck inputs are OUR catalog ids (canonical print ids, as in league decks
 * and DeckState.cards); the injected identity map resolves them to engine
 * card ids so the runtime never needs the arena card map.
 */
import { fromDeckToCardInstances, getAllCardsById } from '@tcg/lorcana-cards';
import { createLorcanaServerGame } from '@tcg/lorcana-engine';
import { AUTOMATED_ACTION_STRATEGIES } from '@tcg/lorcana-engine/automation';
import { createRecordCardCatalog } from '@tcg/shared/cards/catalog';

/** injected by build-engine-bundle.ts via esbuild `define` */
declare const __ENGINE_COMMIT__: string;
declare const __ENGINE_PIN_ATTRIBUTION__: string;
/** our catalog print id → engine card id (compile-time JSON) */
declare const __ENGINE_IDENTITY_MAP__: Record<string, string>;

export const engineCommit: string = __ENGINE_COMMIT__;
export const strategyId = 'best-deck-aware-lore-race';
export const attribution: string = __ENGINE_PIN_ATTRIBUTION__;

/** one seat's deck: our catalog id → copy count */
export type EngineDeckList = Record<string, number>;

export interface EngineGameLogTurn {
  turn: number;
  /** compact action summaries, in execution order */
  p1: string[];
  p2: string[];
  /** lore totals at the end of the turn */
  lore: { p1: number; p2: number };
}

export interface EngineGameResult {
  winner: 'p1' | 'p2' | null;
  turns: number;
  actions: number;
  incomplete: boolean;
  loreTimeline: Array<{ turn: number; p1: number; p2: number }>;
  log: EngineGameLogTurn[];
}

export interface EngineGameInput {
  deckA: EngineDeckList;
  deckB: EngineDeckList;
  seed: string;
  /** defaults to the seed-derived seat (deterministic) */
  firstPlayer?: 'p1' | 'p2';
}

interface EngineCardDef {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

interface BoardView {
  winner?: unknown;
  turnNumber?: number;
  players?: Record<string, { lore?: number }>;
  [key: string]: unknown;
}

interface ServerGame {
  getBoard(): BoardView;
  getCurrentActorId(): string | undefined;
  takeAutomatedActionForCurrentActor(options: { strategy: unknown }): {
    fallbackTaken?: string;
    selectedCandidate?: {
      family: string;
      cardId?: string;
      attackerId?: string;
      defenderId?: string;
      cardsToMulligan?: string[];
    };
  };
  getCardDefinitionByInstanceId?(id: string): EngineCardDef | undefined;
}

/** strategy object from the vendored registry (kept as an object, not an id) */
function bundledStrategy(): unknown {
  const option = AUTOMATED_ACTION_STRATEGIES.find(
    (s) => s.id === strategyId && !s.testOnly,
  );
  if (!option) throw new Error(`bundle strategy ${strategyId} missing`);
  return option.strategy;
}

/**
 * Deterministic seat construction, mirroring the arena's play.ts: the engine
 * draws instance ids from Math.random() and its planner breaks candidate ties
 * by instance id, so instances are re-keyed from (owner, position, card id).
 */
function deterministicCardsMaps(
  seats: Array<{ owner: string; cards: Record<string, number> }>,
  catalog: Record<string, unknown>,
): { cardInstances: Record<string, string>; owners: Record<string, string[]> } {
  const deckOf = (
    cards: Record<string, number>,
  ): Array<{ cardId: string; qty: number }> =>
    Object.entries(cards)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([cardId, qty]) => ({ cardId, qty }));

  const raw = fromDeckToCardInstances(
    seats.map(({ owner, cards }) => ({ owner, deck: deckOf(cards) })) as never,
  ) as {
    cardInstances: Record<string, string>;
    owners: Record<string, string[]>;
  };

  for (const [owner, instances] of Object.entries(raw.owners)) {
    for (const [index, instance] of instances.entries()) {
      const publicId = raw.cardInstances[instance];
      if (!publicId || !catalog[publicId]) {
        throw new Error(
          `card instance ${instance} resolves to unknown engine card ${publicId}`,
        );
      }
      const keyed = `${owner}-${String(index).padStart(3, '0')}-${publicId}`;
      raw.cardInstances[keyed] = publicId;
      delete raw.cardInstances[instance];
      instances[index] = keyed;
    }
  }
  return raw;
}

/** deterministic first-player derivation: the seed alone decides the seat */
export function firstPlayerFor(seed: string): 'p1' | 'p2' {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return (hash >>> 0) % 2 === 0 ? 'p1' : 'p2';
}

const displayName = (def: EngineCardDef | undefined): string => {
  if (!def?.name) return 'unknown card';
  return def.version ? `${def.name} — ${def.version}` : def.name;
};

/** compact human-readable action line for the per-game review log */
function describeCandidate(
  candidate: NonNullable<
    ReturnType<
      ServerGame['takeAutomatedActionForCurrentActor']
    >['selectedCandidate']
  >,
  definitionFor: (id: string | undefined) => EngineCardDef | undefined,
): string {
  switch (candidate.family) {
    case 'putCardIntoInkwell':
      return `inked ${displayName(definitionFor(candidate.cardId))}`;
    case 'playCard':
      return `played ${displayName(definitionFor(candidate.cardId))}`;
    case 'quest':
      return `quested with ${displayName(definitionFor(candidate.cardId))}`;
    case 'challenge': {
      const attacker = displayName(definitionFor(candidate.attackerId));
      const defender = displayName(definitionFor(candidate.defenderId));
      return `${attacker} challenged ${defender}`;
    }
    case 'activateAbility':
      return `activated ${displayName(definitionFor(candidate.cardId))}`;
    case 'moveCharacterToLocation':
      return `${displayName(definitionFor(candidate.cardId))} moved to ${displayName(definitionFor(candidate.defenderId))}`;
    case 'alterHand':
      return `mulliganed ${candidate.cardsToMulligan?.length ?? 0} card(s)`;
    case 'chooseWhoGoesFirst':
      return 'chose who goes first';
    default:
      return `resolved ${candidate.family}`;
  }
}

/** resolve our catalog ids to engine ids; throws when a card is unmapped */
export function toEngineDeck(cards: EngineDeckList): Record<string, number> {
  const engine: Record<string, number> = {};
  for (const [ourId, count] of Object.entries(cards)) {
    if (count <= 0) continue;
    const engineId = __ENGINE_IDENTITY_MAP__[ourId];
    if (!engineId) throw new Error(`catalog id ${ourId} has no engine mapping`);
    engine[engineId] = (engine[engineId] ?? 0) + count;
  }
  return engine;
}

/** Play one full-rules game (heuristic bot both seats) and summarize it. */
export async function createGame(
  input: EngineGameInput,
): Promise<EngineGameResult> {
  const byId = (await getAllCardsById()) as unknown as Record<
    string,
    EngineCardDef
  >;
  const seats = [
    { owner: 'p1', cards: toEngineDeck(input.deckA) },
    { owner: 'p2', cards: toEngineDeck(input.deckB) },
  ];
  const cardsMaps = deterministicCardsMaps(seats, byId);
  const players = [
    { id: 'p1', name: 'Your deck' },
    { id: 'p2', name: 'Baseline deck' },
  ];
  const strategy = bundledStrategy();
  const lorcana = createLorcanaServerGame(
    players.map((player) => ({ player })),
    {
      seed: input.seed,
      goingFirst: input.firstPlayer ?? firstPlayerFor(input.seed),
      cardCatalog: createRecordCardCatalog('lorcana:cards', byId) as never,
      players,
      cardsMaps,
    },
  ) as unknown as ServerGame;

  const definitionFor = (id: string | undefined): EngineCardDef | undefined =>
    id ? lorcana.getCardDefinitionByInstanceId?.(id) : undefined;

  const MAX_ACTIONS = 2_000;
  const loreTimeline: Array<{ turn: number; p1: number; p2: number }> = [];
  const log: EngineGameLogTurn[] = [];
  let open: EngineGameLogTurn | null = null;
  let lastTurn = 0;
  let actions = 0;
  let winner: 'p1' | 'p2' | null = null;
  let incomplete = true;

  const readLore = (): { p1: number; p2: number } => {
    const board = lorcana.getBoard();
    return {
      p1: board.players?.p1?.lore ?? 0,
      p2: board.players?.p2?.lore ?? 0,
    };
  };
  const closeTurn = (): void => {
    if (open && open.p1.length + open.p2.length > 0) {
      open.lore = readLore();
      log.push(open);
    }
    open = null;
  };

  for (let i = 0; i < MAX_ACTIONS; i++) {
    const board = lorcana.getBoard();
    if (typeof board.winner === 'string') {
      winner =
        board.winner === 'p1' || board.winner === 'p2' ? board.winner : null;
      incomplete = false;
      break;
    }
    const turn = Math.max(1, board.turnNumber ?? 1);
    if (turn !== lastTurn) {
      closeTurn();
      loreTimeline.push({ turn, ...readLore() });
      lastTurn = turn;
      open = { turn, p1: [], p2: [], lore: { p1: 0, p2: 0 } };
    }
    const actor = lorcana.getCurrentActorId();
    if (!actor) break; // no actor and no winner: record as incomplete
    const result = lorcana.takeAutomatedActionForCurrentActor({
      strategy,
    });
    actions += 1;
    const line = result.selectedCandidate
      ? describeCandidate(result.selectedCandidate, definitionFor)
      : result.fallbackTaken === 'passTurn'
        ? 'passed'
        : result.fallbackTaken === 'concede'
          ? 'conceded'
          : 'resolved board state';
    if (open) open[actor === 'p1' ? 'p1' : 'p2'].push(line);
    if (result.fallbackTaken === 'concede') {
      const after = lorcana.getBoard();
      if (typeof after.winner === 'string') {
        winner =
          after.winner === 'p1' || after.winner === 'p2' ? after.winner : null;
        incomplete = false;
      }
      break;
    }
  }
  closeTurn();
  // the final turn never sees a turn flip — its lore snapshot is the board now
  if (log.length > 0 && lastTurn > (log[log.length - 1]!.turn ?? 0)) {
    log[log.length - 1]!.lore = readLore();
  }

  return {
    winner,
    turns: lastTurn,
    actions,
    incomplete,
    loreTimeline,
    log,
  };
}
