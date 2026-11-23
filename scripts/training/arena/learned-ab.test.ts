import { describe, expect, it } from 'vitest';
import {
  bootstrapUpliftCi,
  gateVerdict,
  PAIRS_PER_REGIME,
  type PairTally,
  regimeForPair,
  TOTAL_PAIRS,
} from './learned-ab';

describe('A/B regime construction (task 5.1)', () => {
  it('covers the three user-facing regimes over 12 deck-pairs', () => {
    const names = Array.from(
      { length: TOTAL_PAIRS },
      (_, i) => regimeForPair(i).name,
    );
    expect(names.filter((name) => name === 'unrestricted')).toHaveLength(4);
    expect(names.filter((name) => name === 'declared-inks')).toHaveLength(4);
    expect(names.filter((name) => name === 'franchise')).toHaveLength(4);
    expect(TOTAL_PAIRS).toBe(3 * PAIRS_PER_REGIME);
  });

  it('uses the two representative ink pairs and both feasible franchises', () => {
    expect(regimeForPair(4).inks).toEqual(['Ruby', 'Sapphire']);
    expect(regimeForPair(6).inks).toEqual(['Amethyst', 'Emerald']);
    expect(regimeForPair(8).franchises).toEqual(['Frozen']);
    expect(regimeForPair(10).franchises).toEqual(['Lilo & Stitch']);
    expect(regimeForPair(0).inks).toBeUndefined();
    expect(regimeForPair(0).franchises).toBeUndefined();
  });
});

describe('bootstrap uplift CI (paired, cluster-resampled)', () => {
  it('returns ~0 uplift with a tight CI for identical variants', () => {
    const tallies: PairTally[] = Array.from({ length: 12 }, () => ({
      learnedWins: 40,
      learnedGames: 80,
      shippedWins: 40,
      shippedGames: 80,
    }));
    const ci = bootstrapUpliftCi(tallies, 2000, 7);
    expect(ci.uplift).toBe(0);
    expect(ci.ciLow).toBeLessThanOrEqual(0);
    expect(ci.ciHigh).toBeGreaterThanOrEqual(0);
  });

  it('resolves a large true uplift with a positive CI low', () => {
    const tallies: PairTally[] = Array.from({ length: 12 }, () => ({
      learnedWins: 60,
      learnedGames: 80,
      shippedWins: 30,
      shippedGames: 80,
    }));
    const ci = bootstrapUpliftCi(tallies, 2000, 7);
    expect(ci.uplift).toBeCloseTo(0.375, 3);
    expect(ci.ciLow).toBeGreaterThan(0.3);
  });

  it('keeps a CI spanning zero for near-tie variants', () => {
    // near-tie pooled rates WITH between-pair variation (the resampling unit)
    const tallies: PairTally[] = [
      { learnedWins: 44, learnedGames: 80, shippedWins: 40, shippedGames: 80 },
      { learnedWins: 38, learnedGames: 80, shippedWins: 42, shippedGames: 80 },
      { learnedWins: 43, learnedGames: 80, shippedWins: 36, shippedGames: 80 },
      { learnedWins: 36, learnedGames: 80, shippedWins: 41, shippedGames: 80 },
      { learnedWins: 45, learnedGames: 80, shippedWins: 43, shippedGames: 80 },
      { learnedWins: 39, learnedGames: 80, shippedWins: 44, shippedGames: 80 },
      { learnedWins: 42, learnedGames: 80, shippedWins: 37, shippedGames: 80 },
      { learnedWins: 37, learnedGames: 80, shippedWins: 42, shippedGames: 80 },
      { learnedWins: 44, learnedGames: 80, shippedWins: 38, shippedGames: 80 },
      { learnedWins: 40, learnedGames: 80, shippedWins: 39, shippedGames: 80 },
      { learnedWins: 38, learnedGames: 80, shippedWins: 40, shippedGames: 80 },
      { learnedWins: 43, learnedGames: 80, shippedWins: 42, shippedGames: 80 },
    ];
    const ci = bootstrapUpliftCi(tallies, 2000, 7);
    expect(ci.uplift).toBeCloseTo(0.0052, 3);
    expect(ci.ciLow).toBeLessThan(0);
    expect(ci.ciHigh).toBeGreaterThan(0);
  });

  it('is deterministic for a fixed seed and order-independent per pair', () => {
    const tallies: PairTally[] = [
      { learnedWins: 50, learnedGames: 80, shippedWins: 40, shippedGames: 80 },
      { learnedWins: 44, learnedGames: 80, shippedWins: 46, shippedGames: 80 },
      { learnedWins: 52, learnedGames: 80, shippedWins: 38, shippedGames: 80 },
      { learnedWins: 47, learnedGames: 80, shippedWins: 44, shippedGames: 80 },
    ];
    const a = bootstrapUpliftCi(tallies, 1000, 99);
    const b = bootstrapUpliftCi(tallies, 1000, 99);
    expect(a).toEqual(b);
    const shuffled = [tallies[2]!, tallies[0]!, tallies[3]!, tallies[1]!];
    const c = bootstrapUpliftCi(shuffled, 1000, 99);
    expect(c.uplift).toBe(a.uplift);
  });

  it('degrades gracefully on empty input', () => {
    expect(bootstrapUpliftCi([])).toEqual({ uplift: 0, ciLow: 0, ciHigh: 0 });
  });
});

describe('gate verdict (the pre-committed rule)', () => {
  it('passes only on a positive aggregate CI low with zero illegal decks', () => {
    expect(gateVerdict({ ciLow: 0.013 }, 0).verdict).toBe('SHIPPED');
    expect(gateVerdict({ ciLow: 0.013 }, 0).passed).toBe(true);
    expect(gateVerdict({ ciLow: 0 }, 0).verdict).toBe('NOT_SHIPPED');
    expect(gateVerdict({ ciLow: -0.01 }, 0).verdict).toBe('NOT_SHIPPED');
  });

  it('records any illegal deck as gate-fail evidence regardless of uplift', () => {
    const verdict = gateVerdict({ ciLow: 0.05 }, 1);
    expect(verdict.verdict).toBe('NOT_SHIPPED');
    expect(verdict.reason).toMatch(/illegal/i);
    expect(verdict.ciLow).toBe(0.05);
  });
});
