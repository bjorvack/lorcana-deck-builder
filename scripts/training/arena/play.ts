import { fromDeckToCardInstances } from '@tcg/lorcana-cards';
import { createLorcanaServerGame } from '@tcg/lorcana-engine';
import type { AutomatedActionStrategy } from '@tcg/lorcana-engine/automation';
import { AUTOMATED_ACTION_STRATEGIES } from '@tcg/lorcana-engine/automation';
import { createRecordCardCatalog } from '@tcg/shared/cards/catalog';
import type { CardMap } from './card-map';
import type { EngineCatalog } from './engine-cards';

export interface SeatSpec {
  /** canonical print id → count */
  cards: Record<string, number>;
  strategyId: string;
}

export interface GameRecord {
  engineCommit: string;
  seed: string;
  firstPlayer: 'p1' | 'p2';
  decks: { p1: Record<string, number>; p2: Record<string, number> };
  strategies: { p1: string; p2: string };
  winner: string | null;
  turns: number;
  actions: number;
  fallbacks: { passTurn: number; concede: number };
  loreTimeline: Array<{ turn: number; p1: number; p2: number }>;
  incomplete: boolean;
}

export const MAX_ACTIONS = 2_000;

export function strategyById(id: string): AutomatedActionStrategy {
  const option = AUTOMATED_ACTION_STRATEGIES.find(
    (s) => s.id === id && !s.testOnly,
  );
  if (!option) {
    throw new Error(
      `unknown strategy id "${id}"; available: ${AUTOMATED_ACTION_STRATEGIES.filter(
        (s) => !s.testOnly,
      )
        .map((s) => s.id)
        .join(', ')}`,
    );
  }
  return option.strategy as unknown as AutomatedActionStrategy;
}

/**
 * Deterministic seat construction. fromDeckToCardInstances draws card
 * instance ids from unseeded Math.random(), and the planner breaks candidate
 * ties by instance-id comparison — so identical seeds would diverge. Re-key
 * every instance from (owner, deck position, card id) instead; the deck order
 * itself is derived from the sorted card list, so the whole pipeline is
 * seed-independent until the engine's own seeded RNG takes over.
 */
export function deterministicCardsMaps(
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

  const instanceKey = (
    owner: string,
    index: number,
    publicId: string,
  ): string => `${owner}-${String(index).padStart(3, '0')}-${publicId}`;

  for (const [owner, instances] of Object.entries(raw.owners)) {
    for (const [index, instance] of instances.entries()) {
      const publicId = raw.cardInstances[instance];
      if (!publicId || !catalog[publicId]) {
        throw new Error(
          `card instance ${instance} resolves to unknown engine card ${publicId}`,
        );
      }
      const keyed = instanceKey(owner, index, publicId);
      raw.cardInstances[keyed] = publicId;
      delete raw.cardInstances[instance];
      instances[index] = keyed;
    }
  }
  return raw;
}

/** Deterministic first-player derivation: the seed alone decides the seat. */
export function firstPlayerFor(seed: string): 'p1' | 'p2' {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return (hash >>> 0) % 2 === 0 ? 'p1' : 'p2';
}

/** Play one AI-vs-AI game to completion and return the record. */
export function playGame(input: {
  catalog: EngineCatalog;
  cardMap: CardMap;
  deckA: Record<string, number>;
  deckB: Record<string, number>;
  /** registry id or a strategy object (custom/tuned strategies) */
  strategyA: string | AutomatedActionStrategy;
  strategyB: string | AutomatedActionStrategy;
  seed: string;
}): GameRecord {
  const { catalog, cardMap, seed } = input;
  const toEngine = (cards: Record<string, number>): Record<string, number> =>
    Object.fromEntries(
      Object.entries(cards).map(([identity, count]) => {
        const entry = cardMap.byIdentity[identity];
        if (!entry)
          throw new Error(`identity ${identity} has no engine mapping`);
        return [entry.engineId, count];
      }),
    );

  const seats = [
    { owner: 'p1', cards: toEngine(input.deckA) },
    { owner: 'p2', cards: toEngine(input.deckB) },
  ];
  const cardsMaps = deterministicCardsMaps(seats, catalog.byId);
  const players = [
    { id: 'p1', name: 'Deck A' },
    { id: 'p2', name: 'Deck B' },
  ];
  const lorcana = createLorcanaServerGame(
    players.map((player) => ({ player })),
    {
      seed,
      // the seed decides the seat so matchup win rates balance out across a
      // run — hardcoding deck A as first player would bias every estimate
      goingFirst: firstPlayerFor(seed),
      cardCatalog: createRecordCardCatalog(
        'lorcana:cards',
        catalog.byId,
      ) as never,
      players,
      cardsMaps,
    },
  );

  const resolveStrategy = (
    s: string | AutomatedActionStrategy,
  ): AutomatedActionStrategy => (typeof s === 'string' ? strategyById(s) : s);
  const strategyFor = (actor: string): AutomatedActionStrategy =>
    resolveStrategy(actor === 'p1' ? input.strategyA : input.strategyB);

  const fallbacks = { passTurn: 0, concede: 0 };
  const loreTimeline: Array<{ turn: number; p1: number; p2: number }> = [];
  let lastTurn = 0;
  let actions = 0;
  let winner: string | null = null;
  let incomplete = true;

  for (let i = 0; i < MAX_ACTIONS; i++) {
    const board = lorcana.getBoard() as {
      winner?: string;
      turnNumber?: number;
      players?: Record<string, { lore?: number }>;
    };
    if (typeof board.winner === 'string') {
      winner = String(board.winner);
      incomplete = false;
      break;
    }
    const turn = board.turnNumber ?? 0;
    if (turn !== lastTurn) {
      loreTimeline.push({
        turn,
        p1: board.players?.p1?.lore ?? 0,
        p2: board.players?.p2?.lore ?? 0,
      });
      lastTurn = turn;
    }
    const actor = lorcana.getCurrentActorId();
    if (!actor) break; // no actor and no winner: record as incomplete
    const result = lorcana.takeAutomatedActionForCurrentActor({
      strategy: strategyFor(actor),
    });
    actions += 1;
    if (result.fallbackTaken === 'passTurn') fallbacks.passTurn += 1;
    if (result.fallbackTaken === 'concede') fallbacks.concede += 1;
    if (result.fallbackTaken === 'concede') {
      const after = lorcana.getBoard() as { winner?: string };
      if (typeof after.winner === 'string') {
        winner = after.winner;
        incomplete = false;
      }
      break;
    }
  }

  return {
    engineCommit: catalog.engineCommit,
    seed,
    firstPlayer: firstPlayerFor(seed),
    decks: { p1: input.deckA, p2: input.deckB },
    strategies: {
      p1:
        typeof input.strategyA === 'string'
          ? input.strategyA
          : input.strategyA.name,
      p2:
        typeof input.strategyB === 'string'
          ? input.strategyB
          : input.strategyB.name,
    },
    winner,
    turns: lastTurn,
    actions,
    fallbacks,
    loreTimeline,
    incomplete,
  };
}
