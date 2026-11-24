import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { type RaceResult, simulateRace } from './goldfish';
import {
  chunkSeed,
  deckSignature,
  estimateWinrate,
  fnv1a32,
  WINRATE_CHUNKS,
  WINRATE_PROFILE_ID,
  WINRATE_TRIALS_PER_CHUNK,
  wilsonInterval,
} from './winrate-estimate';

// pass-through module mock: lets the cancellation test count the chunks the
// estimator actually ran (the estimator consumes simulateRace directly)
vi.mock('./goldfish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./goldfish')>();
  return { ...actual, simulateRace: vi.fn(actual.simulateRace) };
});

/** the unmocked simulator, for pool-equivalence and impl restoration */
let realSimulateRace: typeof simulateRace;
beforeAll(async () => {
  ({ simulateRace: realSimulateRace } = await vi.importActual('./goldfish'));
});

const fast = makeCard({
  id: 1,
  name: 'Fast',
  cost: 1,
  lore: 2,
  willpower: 9,
  inkwell: true,
});
const ink = makeCard({
  id: 2,
  name: 'Ink',
  cost: 1,
  type: 'Action',
  inkwell: true,
});
const slow = makeCard({ id: 3, name: 'Slow', cost: 4, lore: 1, willpower: 3 });

const byId = byIdMap([fast, ink, slow]);
const deckA: DeckState = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 20, 2: 40 },
};
const deckB: DeckState = { ...deckA, cards: { 3: 30, 2: 30 } };

afterEach(() => {
  // restore the pass-through implementation between tests
  vi.mocked(simulateRace).mockImplementation((...args) =>
    realSimulateRace(...args),
  );
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
    // 1000/2000: symmetric around 0.5, tighter than n=10
    const half = wilsonInterval(1000, 2000);
    expect(half.low).toBeCloseTo(0.478108, 5);
    expect(half.high).toBeCloseTo(0.521892, 5);
    expect(0.5 - half.low).toBeCloseTo(half.high - 0.5, 9);
    // boundary samples pin the mathematical bounds exactly (no float residue)
    expect(wilsonInterval(2000, 2000).high).toBe(1);
    expect(wilsonInterval(2000, 2000).low).toBeCloseTo(0.998083, 5);
    expect(wilsonInterval(0, 2000).low).toBe(0);
    expect(wilsonInterval(1, 1000).low).toBeCloseTo(0.000177, 5);
    expect(wilsonInterval(1, 1000).high).toBeCloseTo(0.005643, 5);
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
    expect(deckSignature(deckA)).toBe('1:20,2:40');
    // same content, different insertion order → same signature
    expect(deckSignature({ ...deckA, cards: { 2: 40, 1: 20 } })).toBe(
      deckSignature(deckA),
    );
    // title is display state — the estimate does not depend on it
    expect(deckSignature({ ...deckA, title: 'Renamed' })).toBe(
      deckSignature(deckA),
    );
    expect(deckSignature(deckB)).not.toBe(deckSignature(deckA));
  });

  it('derives distinct per-chunk seeds from one seed base', () => {
    const seedBase = fnv1a32(deckSignature(deckA));
    const seeds = Array.from({ length: WINRATE_CHUNKS }, (_, i) =>
      chunkSeed(seedBase, i),
    );
    expect(new Set(seeds).size).toBe(WINRATE_CHUNKS);
    // stable: same inputs, same seed
    expect(chunkSeed(seedBase, 3)).toBe(chunkSeed(seedBase, 3));
  });
});

describe('estimateWinrate', () => {
  it('is deterministic per deck (same deck → identical pooled estimate)', async () => {
    const first = await estimateWinrate(deckA, byId);
    const second = await estimateWinrate(deckA, byId);
    expect(first).toEqual(second);
    expect(first!.trials).toBe(WINRATE_CHUNKS * WINRATE_TRIALS_PER_CHUNK);
    expect(first!.profileId).toBe(WINRATE_PROFILE_ID);
    expect(first!.winRate).toBe(first!.wins / first!.trials);
    // pinned: the pooled batches for this fixture land on 930 wins
    expect(first!.wins).toBe(930);
    expect(first!.ci.low).toBeCloseTo(0.443229, 5);
    expect(first!.ci.high).toBeCloseTo(0.486906, 5);
  });

  it('differs across decks (different signature → different seeds)', async () => {
    const a = await estimateWinrate(deckA, byId);
    const b = await estimateWinrate(deckB, byId);
    expect(a!.wins).not.toBe(b!.wins); // 930 vs 0 for these fixtures
    expect(fnv1a32(deckSignature(deckA))).not.toBe(
      fnv1a32(deckSignature(deckB)),
    );
  });

  it('pools the five independent 400-trial batches exactly', async () => {
    // the chunked run is a batched estimate, not a stream split: it must equal
    // manually pooling five simulateRace calls seeded chunkSeed(seedBase, i)
    const seedBase = fnv1a32(deckSignature(deckA));
    let wins = 0;
    for (let i = 0; i < WINRATE_CHUNKS; i++) {
      const race = realSimulateRace(deckA, byId, WINRATE_PROFILE_ID, {
        trials: WINRATE_TRIALS_PER_CHUNK,
        seed: chunkSeed(seedBase, i),
      })!;
      wins += Math.round(race.winRate * WINRATE_TRIALS_PER_CHUNK);
    }
    const estimate = await estimateWinrate(deckA, byId);
    expect(estimate!.wins).toBe(wins);
  });

  it('yields between chunks so the UI thread gets a slot', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      await estimateWinrate(deckA, byId);
      // one macrotask yield after every chunk except the last
      expect(setTimeoutSpy).toHaveBeenCalledTimes(WINRATE_CHUNKS - 1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('cancellation discards the run: abort after chunk 2 → null, chunk 3 never starts', async () => {
    const mock = vi.mocked(simulateRace);
    mock.mockClear();
    mock.mockImplementation((...args: Parameters<typeof simulateRace>) => {
      const result = realSimulateRace(...args);
      if (mock.mock.calls.length === 2) abort(); // chunk 2 just finished
      return result as RaceResult;
    });
    let aborted = false;
    const abort = (): void => {
      aborted = true;
    };
    try {
      const result = await estimateWinrate(deckA, byId, {
        shouldAbort: () => aborted,
      });
      expect(result).toBeNull(); // finished chunks are discarded, no partial result
      expect(mock).toHaveBeenCalledTimes(2); // chunk 3's check saw the token and stopped
    } finally {
      mock.mockImplementation((...args) => realSimulateRace(...args));
    }
  });

  it('a pre-aborted run starts no chunk and resolves null', async () => {
    const mock = vi.mocked(simulateRace);
    mock.mockClear();
    const result = await estimateWinrate(deckA, byId, {
      shouldAbort: () => true,
    });
    expect(result).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('resolves null when no deck card resolves to the catalog', async () => {
    const staleDeck: DeckState = { ...deckA, cards: { 9999: 60 } };
    expect(await estimateWinrate(staleDeck, byId)).toBeNull();
  });
});
