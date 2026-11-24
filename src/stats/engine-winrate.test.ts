import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckState } from '../data/types';
import {
  deckSignature,
  ENGINE_BATCH_SIZE,
  ENGINE_GAMES,
  type EnginePlayGame,
  engineBundleUrl,
  estimateEngineWinrate,
  fnv1a32,
  GAMES_PER_OPPONENT,
  loadEngineBundle,
  loadOpponents,
  OPPONENT_COUNT,
  type OpponentsArtifact,
  resetEngineBundleCache,
  runParallel,
  scheduleGames,
  wilsonInterval,
} from './engine-winrate';
import { clearEstimateCache } from './winrate-cache';

const deckA: DeckState = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 30, 2: 30 },
};
const deckB: DeckState = { ...deckA, cards: { 1: 20, 2: 40 } };

// the localStorage estimate cache persists across tests in this file — clear
// it so each test exercises the simulation instead of a cached result
beforeEach(() => clearEstimateCache());

// the localStorage estimate cache persists across tests — clear it so each
// test exercises the simulation instead of a previous test's cached result
beforeEach(() => clearEstimateCache());

const opponents: OpponentsArtifact = {
  format: 1,
  engineCommit: 'a'.repeat(40),
  strategyId: 'best-deck-aware-lore-race',
  generatedOn: '2026-11-24',
  decks: Array.from({ length: OPPONENT_COUNT }, (_, i) => ({
    id: `real:opp-${i}`,
    name: `Tournament deck ${i}`,
    inks: ['Amber'],
    cards: { 3: 60 - i, 4: i },
  })),
};

/** deterministic fake game: p1 wins on even seeds, turns = seed length */
const fakePlayGame: EnginePlayGame = ({ deckA: first, seed }) => {
  const userIsP1 = '1' in first; // the user deck carries card 1
  return Promise.resolve({
    winner: Number(seed) % 2 === 0 ? 'p1' : 'p2',
    turns: seed.length,
    incomplete: false,
    log: [
      {
        turn: 1,
        p1: [userIsP1 ? 'played Deck A card' : 'played Opponent'],
        p2: [userIsP1 ? 'played Opponent' : 'played Deck A card'],
        lore: { p1: 1, p2: 0 },
      },
    ],
  });
};

const run = (
  deck: DeckState,
  overrides: Parameters<typeof estimateEngineWinrate>[1] = {},
): ReturnType<typeof estimateEngineWinrate> =>
  estimateEngineWinrate(deck, { playGame: fakePlayGame, ...overrides });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEngineBundleCache();
});

describe('Wilson 95% confidence interval', () => {
  it('matches hand-computed reference values', () => {
    // 50% point estimate with n=10: the classic symmetric interval
    const five = wilsonInterval(5, 10);
    expect(five.low).toBeCloseTo(0.236593, 5);
    expect(five.high).toBeCloseTo(0.763407, 5);
    // zero wins: the interval is [0, 0.278] — never negative
    const zero = wilsonInterval(0, 10);
    expect(zero.low).toBe(0);
    expect(zero.high).toBeCloseTo(0.277533, 5);
    // 32/64: symmetric around 0.5, tighter than n=10
    const half = wilsonInterval(32, 64);
    expect(half.low).toBeCloseTo(0.381021, 5);
    expect(half.high).toBeCloseTo(0.618979, 5);
    expect(0.5 - half.low).toBeCloseTo(half.high - 0.5, 9);
    // boundary samples pin the mathematical bounds exactly (no float residue)
    expect(wilsonInterval(64, 64).high).toBe(1);
    expect(wilsonInterval(64, 64).low).toBeCloseTo(0.943376, 5);
    expect(wilsonInterval(0, 64).low).toBe(0);
    expect(wilsonInterval(1, 64).low).toBeCloseTo(0.002764, 5);
    expect(wilsonInterval(1, 64).high).toBeCloseTo(0.083341, 5);
  });

  it('stays inside the probability range and collapses without trials', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
    for (const [wins, trials] of [
      [0, 1],
      [1, 1],
      [3, 7],
      [17, 40],
    ] as const) {
      const ci = wilsonInterval(wins, trials);
      expect(ci.low).toBeGreaterThanOrEqual(0);
      expect(ci.high).toBeLessThanOrEqual(1);
      expect(ci.low).toBeLessThanOrEqual(ci.high);
      expect(ci.low).toBeLessThanOrEqual(wins / trials);
      expect(ci.high).toBeGreaterThanOrEqual(wins / trials);
    }
  });
});

describe('seeding primitives', () => {
  it('hashes with FNV-1a 32-bit over UTF-16 code units', () => {
    // pinned against the reference implementation (learned-fill ships the
    // same algorithm lowercased first; these inputs have no case to fold)
    expect(fnv1a32('gaston')).toBe(4118703771);
    expect(fnv1a32('')).toBe(2166136261);
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('signature covers card content only, order-independently', () => {
    expect(deckSignature(deckA)).toBe('1:30,2:30');
    // same content, different insertion order → same signature
    expect(deckSignature({ ...deckA, cards: { 2: 30, 1: 30 } })).toBe(
      deckSignature(deckA),
    );
    // title is display state — the estimate does not depend on it
    expect(deckSignature({ ...deckA, title: 'Renamed' })).toBe(
      deckSignature(deckA),
    );
    expect(deckSignature(deckB)).not.toBe(deckSignature(deckA));
  });
});

describe('scheduleGames', () => {
  it('pre-commits the 64-game budget over 4 opponents with seat alternation', () => {
    const schedule = scheduleGames(fnv1a32(deckSignature(deckA)));
    expect(schedule).toHaveLength(ENGINE_GAMES);
    expect(new Set(schedule.map((g) => g.opponentIndex)).size).toBe(
      OPPONENT_COUNT,
    );
    for (let o = 0; o < OPPONENT_COUNT; o++) {
      const seats = schedule
        .filter((g) => g.opponentIndex === o)
        .map((g) => g.seat);
      expect(seats).toHaveLength(GAMES_PER_OPPONENT);
      // strict alternation: 8 games per seat
      expect(seats.filter((s) => s === 'p1')).toHaveLength(
        GAMES_PER_OPPONENT / 2,
      );
      expect(seats.filter((s) => s === 'p2')).toHaveLength(
        GAMES_PER_OPPONENT / 2,
      );
      for (const [i, seat] of seats.entries())
        expect(seat).toBe(i % 2 === 0 ? 'p1' : 'p2');
    }
  });

  it('is deterministic per deck and distinct across decks', () => {
    const a = scheduleGames(fnv1a32(deckSignature(deckA)));
    expect(scheduleGames(fnv1a32(deckSignature(deckA)))).toEqual(a);
    const b = scheduleGames(fnv1a32(deckSignature(deckB)));
    expect(b).not.toEqual(a);
    // every game gets its own seed
    expect(new Set(a.map((g) => g.seed)).size).toBe(ENGINE_GAMES);
  });
});

it('runs the full pre-committed budget and pools wins into a Wilson CI', async () => {
  const estimate = await run(deckA, { opponents });
  expect(estimate).not.toBeNull();
  expect(estimate!.games).toBe(ENGINE_GAMES);
  expect(estimate!.played).toHaveLength(ENGINE_GAMES);
  expect(estimate!.winRate).toBe(estimate!.wins / ENGINE_GAMES);
  expect(estimate!.ci).toEqual(wilsonInterval(estimate!.wins, ENGINE_GAMES));
  expect(estimate!.engineCommit).toBe(opponents.engineCommit);
});

it('is deterministic per deck (same deck → identical games and estimate)', async () => {
  clearEstimateCache(); // this test needs the cache across its two runs
  const first = await run(deckA, { opponents });
  const second = await run(deckA, { opponents });
  // the second run hits the estimate cache: identical games, cached: true
  expect(second).not.toBeNull();
  expect(second!.cached).toBe(true);
  const { cached: _cached, ...firstWithoutFlag } = first!;
  const { cached: _cached2, ...secondWithoutFlag } = second!;
  expect(secondWithoutFlag).toEqual(firstWithoutFlag);
  // different deck → different seeds → different game outcomes
  const other = await run(deckB, { opponents });
  expect(other).not.toEqual(first);
});

it('alternates the user seat: even games as p1, odd as p2 with decks swapped', async () => {
  const calls: Array<{ deckA: unknown; deckB: unknown; seed: string }> = [];
  const spy: EnginePlayGame = (input) => {
    calls.push({ ...input });
    return fakePlayGame(input);
  };
  await run(deckA, { opponents, playGame: spy });
  expect(calls).toHaveLength(ENGINE_GAMES);
  const first = calls[0]!;
  const second = calls[1]!;
  // game 0: user deck as p1 vs opponent 0; game 1: mirrored
  expect(first.deckA).toEqual(deckA.cards);
  expect(first.deckB).toEqual(opponents.decks[0]!.cards);
  expect(second.deckA).toEqual(opponents.decks[0]!.cards);
  expect(second.deckB).toEqual(deckA.cards);
  // each opponent hosts 16 games in a contiguous block
  expect(calls[GAMES_PER_OPPONENT]!.deckB).toEqual(opponents.decks[1]!.cards);
});

it('reports progress in batch steps so the loader can show X/Y games', async () => {
  const progress: Array<{ completed: number; total: number }> = [];
  await run(deckA, { opponents, onProgress: (p) => progress.push(p) });
  expect(progress).toHaveLength(ENGINE_GAMES / ENGINE_BATCH_SIZE);
  expect(progress.map((p) => p.completed)).toEqual(
    Array.from(
      { length: ENGINE_GAMES / ENGINE_BATCH_SIZE },
      (_, i) => (i + 1) * ENGINE_BATCH_SIZE,
    ),
  );
  expect(progress[0]!.total).toBe(ENGINE_GAMES);
});

it('yields between batches so the UI thread gets a slot', async () => {
  const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
  try {
    await run(deckA, { opponents });
    // one macrotask yield after every batch except the last
    expect(setTimeoutSpy).toHaveBeenCalledTimes(
      ENGINE_GAMES / ENGINE_BATCH_SIZE - 1,
    );
  } finally {
    setTimeoutSpy.mockRestore();
  }
});

it('cancellation discards the run: abort mid-schedule → null, no further games', async () => {
  const played: string[] = [];
  const spy: EnginePlayGame = (input) => {
    played.push(input.seed);
    // abort once 12 games have finished (3 batches)
    if (played.length === 12) token.abort = true;
    return fakePlayGame(input);
  };
  const token = { abort: false };
  const estimate = await run(deckA, {
    opponents,
    playGame: spy,
    shouldAbort: () => token.abort,
  });
  expect(estimate).toBeNull(); // finished games are discarded, no partial result
  expect(played).toHaveLength(12); // batch 4's pre-check stopped the run
});

it('a pre-aborted run starts no game and resolves null', async () => {
  const spy: EnginePlayGame = vi.fn(fakePlayGame);
  const estimate = await run(deckA, {
    opponents,
    playGame: spy,
    shouldAbort: () => true,
  });
  expect(estimate).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

it('voids the run when a game throws (unmapped deck or engine error)', async () => {
  const played: string[] = [];
  const spy: EnginePlayGame = vi.fn((input) => {
    if (played.length === 5) throw new Error('unmapped card');
    played.push(input.seed);
    return fakePlayGame(input);
  });
  const estimate = await run(deckA, { opponents, playGame: spy });
  expect(estimate).toBeNull();
  // a partial winrate would overstate the deck — the run stops there
  expect(spy).toHaveBeenCalledTimes(6); // 4 + 2 games into the second batch
});

it('resolves null for an empty or zero-count deck', async () => {
  expect(await run({ ...deckA, cards: {} }, { opponents })).toBeNull();
  expect(await run({ ...deckA, cards: { 1: 0 } }, { opponents })).toBeNull();
});

it('resolves null when no opponent pool is available and rejects empty pools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 404 })),
  );
  expect(
    await estimateEngineWinrate(deckA, { playGame: fakePlayGame }),
  ).toBeNull();
  // a shipped artifact with no decks is just as unusable
  expect(
    await estimateEngineWinrate(deckA, {
      opponents: { ...opponents, decks: [] },
      playGame: fakePlayGame,
    }),
  ).toBeNull();
});

it('captures the per-game review log (opponent, seat, winner, turn lines)', async () => {
  const estimate = await run(deckA, { opponents });
  const game = estimate!.played[0]!;
  expect(game.opponentId).toBe(opponents.decks[0]!.id);
  expect(game.opponentName).toBe(opponents.decks[0]!.name);
  expect(game.seat).toBe('p1');
  expect(game.log[0]!.p1).toEqual(['played Deck A card']);
  const mirrored = estimate!.played[1]!;
  expect(mirrored.seat).toBe('p2');
  expect(mirrored.log[0]!.p1).toEqual(['played Opponent']);
});

describe('engine bundle loading', () => {
  it('caches the loaded bundle module per URL', async () => {
    const source =
      'export const marker = "bundle"; export const createGame = async () => ({});';
    const url = `data:text/javascript,${encodeURIComponent(source)}`;
    const first = await loadEngineBundle(url);
    expect((first as unknown as { marker?: string }).marker).toBe('bundle');
    // a second call reuses the imported module — the 8 MB artifact parses once
    const second = await loadEngineBundle(url);
    expect(second).toBe(first);
  });

  it('plays through the real bundle path: BASE_URL points at an importable module', async () => {
    // BASE_URL is prefixed onto `data/engine-bundle-<commit8>.js` — a
    // data: module whose code ends in a line comment makes the remainder of
    // the URL inert, so the estimator exercises its real default game player
    vi.stubEnv(
      'BASE_URL',
      'data:text/javascript,export const createGame=async()=>({winner:"p1",turns:2,incomplete:false,log:[]})//',
    );
    const estimate = await estimateEngineWinrate(deckA, {
      ...{ opponents: { ...opponents, engineCommit: 'b'.repeat(40) } },
    });
    expect(estimate).not.toBeNull();
    // the fake bundle always has p1 winning: user wins every p1-seat game
    expect(estimate!.wins).toBe(ENGINE_GAMES / 2);
    expect(estimate!.played.every((g) => g.turns === 2)).toBe(true);
  });

  it('resolves null when the engine bundle cannot be loaded', async () => {
    // no injected playGame → the real path tries the bundle import and fails
    const estimate = await estimateEngineWinrate(deckA, { opponents });
    expect(estimate).toBeNull();
  });
});

describe('opponent pool loading', () => {
  it('fetches and validates the shipped artifact', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(opponents), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pool = await loadOpponents();
    expect(pool).toEqual(opponents);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('data/winrate-opponents.json'),
      { cache: 'no-cache' },
    );
  });

  it('resolves null on fetch failure or a malformed artifact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    expect(await loadOpponents()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadOpponents()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...opponents, decks: [] }), {
            status: 200,
          }),
      ),
    );
    expect(await loadOpponents()).toBeNull();
  });

  it('builds the bundle URL from the commit8 and the base path', () => {
    expect(engineBundleUrl(opponents.engineCommit, '/')).toBe(
      '/data/engine-bundle-aaaaaaaa.js',
    );
  });
});

describe('runParallel (direct)', () => {
  it('partitions across workers and re-assembles in schedule order', async () => {
    class MockWorker {
      static instances: MockWorker[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      terminated = false;
      constructor() {
        MockWorker.instances.push(this);
      }
      terminate() {
        this.terminated = true;
      }
      postMessage(data: { games: Array<{ scheduleIndex: number }> }) {
        // the worker plays each game and reports it with its schedule index
        for (const game of data.games) {
          this.onmessage?.({
            data: {
              type: 'game',
              index: game.scheduleIndex,
              summary: {
                opponentId: 'opp-0',
                opponentName: 'Baseline 0',
                seat: game.scheduleIndex % 2 === 0 ? 'p1' : 'p2',
                seed: game.seed,
                winner: game.scheduleIndex % 2 === 0 ? 'p1' : 'p2',
                turns: 10,
                log: [],
              },
            },
          } as MessageEvent);
        }
        this.onmessage?.({ data: { type: 'done' } } as MessageEvent);
      }
    }
    vi.stubGlobal('Worker', MockWorker);
    MockWorker.instances = [];

    const tasks = scheduleGames(42).map((task, scheduleIndex) => ({
      scheduleIndex,
      deckA: { 1: 60 },
      deckB: { 2: 60 },
      seed: task.seed,
      opponentId: 'opp-0',
      opponentName: 'Baseline 0',
      seat: task.seat,
    }));
    const estimate = await runParallel('6de59de1', 'cache-key', tasks, {});

    // bit-identical regardless of the partition: all 64 games, schedule order
    expect(estimate!.games).toBe(64);
    expect(estimate!.played.map((g) => g.seed)).toEqual(
      tasks.map((t) => t.seed),
    );
    for (const worker of MockWorker.instances) {
      expect(worker.terminated).toBe(true);
    }
  });
});

describe('runParallel error path', () => {
  it('a worker error voids the run and terminates all workers', async () => {
    class ErrorWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      terminated = false;
      postMessage() {
        // one worker errors at spawn-time instead of playing
        this.onerror?.(new ErrorEvent('error', { message: 'bundle broken' }));
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal('Worker', ErrorWorker);
    const tasks = scheduleGames(42).map((task, scheduleIndex) => ({
      scheduleIndex,
      deckA: { 1: 60 },
      deckB: { 2: 60 },
      seed: task.seed,
      opponentId: 'opp-0',
      opponentName: 'Baseline 0',
      seat: task.seat,
    }));
    const estimate = await runParallel('6de59de1', 'cache-key', tasks, {});
    expect(estimate).toBeNull();
  });
});
