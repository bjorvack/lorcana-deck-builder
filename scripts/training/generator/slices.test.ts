import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import type { League } from '../arena/league';
import type { LegalPool } from '../arena/map-elites-mutation';
import { mulberry32 } from '../prng';
import {
  MIN_REGION_CARDS,
  planRegionSizes,
  REGIONS_PER_SAMPLE,
  RESTRICTED_MIN_FITNESS,
  SAMPLES_PER_DECK,
} from './corpus';
import {
  buildPoolSlice,
  countCorpusStrata,
  enforceSlicePairCap,
  estimatePairsPerDeck,
  foldCorpusStrata,
  runSlicePool,
  runSlices,
  SLICE_PAIR_CAP,
  type SliceCapDeck,
  sliceCondition,
  sliceCorpusDeckId,
  slicePairShare,
  sliceSeed,
  sliceSizeWithinTolerance,
} from './slices';

const mkCard = (id: number): Card => ({
  id,
  name: `Card ${id}`,
  fullName: `Card ${id}`,
  groupKey: `card-${id}`,
  inks: ['Amber'] as Card['inks'],
  isDualInk: false,
  cost: 3,
  inkwell: true,
  type: 'Character',
  subtypes: ['Floodborn'],
  isSong: false,
  franchise: 'Test',
  setCode: 'TST',
  setName: 'Test',
  setNumber: 1,
  setType: 'expansion',
  rarity: 'common',
  maxCopies: 3,
  lore: 2,
  text: '',
  keywords: [],
  tags: [],
  deckRuleEffects: [],
  payoffs: [],
  images: {},
  formats: { core: true, infinity: true },
});

/** synthetic 200-identity pool — big enough for meaningful 50% draws */
const bigPool: LegalPool = new Map(
  Array.from({ length: 200 }, (_, i) => [
    1000 + i,
    { maxCopies: 3, inks: ['Amber'] },
  ]),
);

// 45 identities — small enough for fast fake-evaluator searches, big enough
// that every 50% slice can still build 60-card decks (≥ 13 × 3 cards)
const smallIds = Array.from({ length: 45 }, (_, i) => 100 + i);
const smallCards: Card[] = smallIds.map(mkCard);
const smallPool: LegalPool = new Map(
  smallIds.map((id) => [id, { maxCopies: 3, inks: ['Amber'] }]),
);

const league: League = {
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  seededOn: '2026-11-22T09:24:18.575Z',
  members: [
    {
      id: 'baseline-random:test',
      kind: 'baseline-random',
      deck: Object.fromEntries(
        smallIds.slice(0, 20).map((id) => [String(id), 3]),
      ),
      share: 1,
      origin: 'fixture',
    },
  ],
};

/** deterministic fake: fitness by candidate index (0.30 … 0.55, strict >0.45 keeps 2 of 6) */
const indexFitnessEvaluator =
  () => async (candidates: Array<{ index: number }>) =>
    candidates.map((candidate) => ({
      index: candidate.index,
      fitness: 0.3 + 0.05 * (candidate.index % 6),
      games: 80,
    }));

const runSlice = (
  overrides: Partial<Parameters<typeof runSlicePool>[0]> = {},
) =>
  runSlicePool({
    sliceIndex: 0,
    fullPool: smallPool,
    cards: smallCards,
    league,
    seedBase: 20261123,
    evaluate: indexFitnessEvaluator(),
    ...overrides,
  });

const deckOf = (total: number): Record<string, number> => ({ '1000': total });

describe('slice seeds and conditions', () => {
  it('uses the pre-committed seed formula 20261123 + 900 + i', () => {
    expect(sliceSeed(0)).toBe(20261123 + 900);
    expect(sliceSeed(3)).toBe(20261123 + 903);
    expect(sliceSeed(7)).toBe(20261123 + 907);
    expect(sliceSeed(3, 20261123)).toBe(sliceSeed(3));
  });

  it('tags slices with condition and corpus deck id', () => {
    expect(sliceCondition(3)).toBe('pool-slice:3');
    expect(sliceCorpusDeckId(3, 'gen-0-cand-1')).toBe(
      'pool-slice:3:gen-0-cand-1',
    );
  });
});

describe('buildPoolSlice', () => {
  it('is deterministic per seed and a verbatim subset of the pool', () => {
    const first = buildPoolSlice(bigPool, 3);
    const second = buildPoolSlice(bigPool, 3);
    expect([...first.entries()]).toEqual([...second.entries()]);
    for (const [id, entry] of first) {
      expect(bigPool.get(id)).toEqual(entry);
    }
  });

  it('draws each identity independently with p = 0.5 (~100 of 200)', () => {
    for (let i = 0; i < 8; i++) {
      const slice = buildPoolSlice(bigPool, i);
      expect(slice.size).toBeGreaterThan(60);
      expect(slice.size).toBeLessThan(140);
      expect(sliceSizeWithinTolerance(bigPool.size, slice.size)).toBe(true);
    }
  });

  it('produces different slices for different indices', () => {
    const zero = [...buildPoolSlice(bigPool, 0).keys()];
    const one = [...buildPoolSlice(bigPool, 1).keys()];
    expect(zero).not.toEqual(one);
  });
});

describe('sliceSizeWithinTolerance', () => {
  it('accepts the binomial ±sigma band', () => {
    // 100 identities: expected 50, sd 5 → 3σ = 15
    expect(sliceSizeWithinTolerance(100, 50)).toBe(true);
    expect(sliceSizeWithinTolerance(100, 55)).toBe(true);
    expect(sliceSizeWithinTolerance(100, 65)).toBe(true);
    expect(sliceSizeWithinTolerance(100, 66)).toBe(false);
    expect(sliceSizeWithinTolerance(100, 35)).toBe(true);
    expect(sliceSizeWithinTolerance(100, 34)).toBe(false);
  });
});

describe('estimatePairsPerDeck', () => {
  it('mirrors corpus.ts masking: samples × regions', () => {
    expect(estimatePairsPerDeck(deckOf(60))).toBe(SAMPLES_PER_DECK * 3);
    expect(estimatePairsPerDeck(deckOf(16))).toBe(SAMPLES_PER_DECK * 2);
    expect(estimatePairsPerDeck(deckOf(MIN_REGION_CARDS))).toBe(
      SAMPLES_PER_DECK * 1,
    );
    expect(estimatePairsPerDeck(deckOf(MIN_REGION_CARDS - 1))).toBe(0);
  });

  it('agrees with planRegionSizes for every deck size in the band', () => {
    for (let total = MIN_REGION_CARDS; total <= 72; total++) {
      expect(estimatePairsPerDeck(deckOf(total))).toBe(
        SAMPLES_PER_DECK * planRegionSizes(total, mulberry32(total)).length,
      );
    }
    expect(REGIONS_PER_SAMPLE).toBe(3);
  });

  it('rejects malformed deck entries', () => {
    expect(() => estimatePairsPerDeck({ '1000': 0 })).toThrow(/malformed/);
    expect(() => estimatePairsPerDeck({ '1000': 1.5 })).toThrow(/malformed/);
  });
});

describe('slicePairShare', () => {
  it('computes slice pairs over total pairs', () => {
    expect(slicePairShare(25, 75)).toBe(0.25);
    expect(slicePairShare(0, 100)).toBe(0);
    expect(slicePairShare(0, 0)).toBe(0);
  });
});

describe('enforceSlicePairCap', () => {
  const capDeck = (
    deckId: string,
    sliceIndex: number,
    fitness: number,
    pairs = 42,
  ): SliceCapDeck => ({
    corpusDeckId: sliceCorpusDeckId(sliceIndex, deckId),
    sliceIndex,
    deckId,
    fitness,
    pairs,
  });

  it('keeps every deck when the share is under the cap', () => {
    const decks = [capDeck('a', 0, 0.9), capDeck('b', 1, 0.8)];
    const result = enforceSlicePairCap(decks, 300);
    expect(result.enforced).toBe(false);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toEqual([]);
    expect(result.shareBefore).toBeCloseTo(84 / 384, 12);
    expect(result.shareAfter).toBe(result.shareBefore);
  });

  it('does not enforce at exactly the cap (share must exceed it)', () => {
    const decks = [capDeck('a', 0, 0.9, 50), capDeck('b', 1, 0.8, 50)];
    const result = enforceSlicePairCap(decks, 300);
    expect(result.shareBefore).toBeCloseTo(SLICE_PAIR_CAP, 12);
    expect(result.enforced).toBe(false);
    expect(result.kept).toHaveLength(2);
  });

  it('drops lowest-fitness decks until under the cap', () => {
    const decks = [
      capDeck('a', 0, 0.55),
      capDeck('b', 1, 0.9),
      capDeck('c', 2, 0.7),
      capDeck('d', 3, 0.6),
    ];
    const result = enforceSlicePairCap(decks, 132);
    expect(result.shareBefore).toBeCloseTo(168 / 300, 12);
    expect(result.enforced).toBe(true);
    // 168 → 126 → 84 → 42 pairs: three drops, only the fittest survives
    expect(result.dropped.map((deck) => deck.corpusDeckId)).toEqual([
      'pool-slice:0:a',
      'pool-slice:3:d',
      'pool-slice:2:c',
    ]);
    expect(result.kept.map((deck) => deck.corpusDeckId)).toEqual([
      'pool-slice:1:b',
    ]);
    expect(result.shareAfter).toBeCloseTo(42 / 174, 12);
    expect(result.shareAfter).toBeLessThanOrEqual(SLICE_PAIR_CAP);
  });

  it('breaks fitness ties by slice index, then deck id', () => {
    const decks = [
      capDeck('gen-0-cand-0', 1, 0.5),
      capDeck('gen-0-cand-9', 0, 0.5),
      capDeck('gen-0-cand-5', 0, 0.5),
    ];
    // 126 slice pairs vs 126 others: drop two decks → 42/168 = exactly 0.25
    const result = enforceSlicePairCap(decks, 126);
    expect(result.dropped.map((deck) => deck.corpusDeckId)).toEqual([
      'pool-slice:0:gen-0-cand-5',
      'pool-slice:0:gen-0-cand-9',
    ]);
    expect(result.kept.map((deck) => deck.corpusDeckId)).toEqual([
      'pool-slice:1:gen-0-cand-0',
    ]);
    expect(result.shareAfter).toBeCloseTo(SLICE_PAIR_CAP, 12);
  });

  it('is independent of input order', () => {
    const decks = [
      capDeck('a', 0, 0.55),
      capDeck('b', 1, 0.9),
      capDeck('c', 2, 0.7),
      capDeck('d', 3, 0.6),
    ];
    const reversed = enforceSlicePairCap([...decks].reverse(), 132);
    const forward = enforceSlicePairCap(decks, 132);
    expect(reversed.dropped).toEqual(forward.dropped);
    expect(reversed.kept).toEqual(forward.kept);
  });

  it('rejects caps outside (0, 1]', () => {
    expect(() => enforceSlicePairCap([], 10, 0)).toThrow(/cap/);
    expect(() => enforceSlicePairCap([], 10, 1.5)).toThrow(/cap/);
  });
});

describe('countCorpusStrata and foldCorpusStrata', () => {
  const sampleCorpus = {
    pairs: [
      { stratum: 'masked-elites' },
      { stratum: 'restricted', condition: 'inks:ruby-sapphire' },
      { stratum: 'restricted', condition: 'pool-slice:0' },
      { stratum: 'pool-slice' },
      { stratum: 'substitution-delta' },
      { stratum: 'coverage' },
    ],
  };

  it('counts pairs per stratum and carves out slice pairs', () => {
    const counts = countCorpusStrata(sampleCorpus);
    expect(counts.byStratum).toEqual({
      'masked-elites': 1,
      'substitution-delta': 1,
      restricted: 2,
      'pool-slice': 1,
      coverage: 1,
    });
    expect(counts.poolSlicePairs).toBe(2);
  });

  it('folds corpora per-stratum: the max wins, later files cannot erase strata', () => {
    const folded = foldCorpusStrata([
      countCorpusStrata(sampleCorpus),
      countCorpusStrata({
        pairs: [{ stratum: 'masked-elites' }, { stratum: 'masked-elites' }],
      }),
    ]);
    // the second file carries no restricted/coverage/delta pairs — a rebuild
    // that did not measure them; the earlier counts must survive the fold
    expect(folded.byStratum['masked-elites']).toBe(2);
    expect(folded.byStratum.restricted).toBe(2);
    expect(folded.byStratum.coverage).toBe(1);
    expect(folded.byStratum['substitution-delta']).toBe(1);
    expect(folded.poolSlicePairs).toBe(2);
  });

  it('throws on unknown strata', () => {
    expect(() => countCorpusStrata({ pairs: [{ stratum: 'bogus' }] })).toThrow(
      /unknown stratum/,
    );
  });
});

describe('runSlicePool', () => {
  it('records the slice draw, search stats and slice-tagged decks', async () => {
    const leagueBefore = structuredClone(league);
    const { stats, decks } = await runSlice();
    expect(stats).toMatchObject({
      sliceIndex: 0,
      condition: 'pool-slice:0',
      seed: 20261123 + 900,
      candidatesEvaluated: 12,
      games: 960,
      dropped: false,
    });
    expect(stats.poolSize).toBeGreaterThan(0);
    expect(stats.poolSize).toBeLessThanOrEqual(smallPool.size);
    expect(stats.expectedPoolSize).toBe(smallPool.size * 0.5);
    expect(stats.sizeWithinTolerance).toBe(true);
    expect(stats.cells).toBeGreaterThanOrEqual(1);
    expect(stats.cellsPassingThreshold).toBeGreaterThanOrEqual(1);
    // index fitness 0.50/0.55 per generation → ≥ 2 passing decks
    expect(decks.length).toBeGreaterThanOrEqual(2);
    expect(stats.passingDecks).toBe(decks.length);
    const compositions = new Set<string>();
    for (const deck of decks) {
      expect(deck.stratum).toBe('pool-slice');
      expect(deck.condition).toBe('pool-slice:0');
      expect(deck.sliceIndex).toBe(0);
      expect(deck.deckId).toMatch(/^gen-\d+-cand-\d+$/);
      expect(deck.fitness).toBeGreaterThan(RESTRICTED_MIN_FITNESS);
      compositions.add(JSON.stringify(Object.entries(deck.deck).sort()));
    }
    expect(compositions.size).toBe(decks.length);
    // the shared league is never mutated by a slice run
    expect(league).toEqual(leagueBefore);
  });

  it('keeps decks at or below the threshold out without dropping the slice', async () => {
    const { stats, decks } = await runSlice({
      evaluate: (candidates) =>
        Promise.resolve(
          candidates.map((candidate) => ({
            index: candidate.index,
            fitness: candidate.index % 2 === 0 ? 0.55 : RESTRICTED_MIN_FITNESS,
            games: 80,
          })),
        ),
    });
    // strict >: at-threshold decks are excluded, the slice itself survives
    expect(stats).toMatchObject({ dropped: false, passingDecks: 6 });
    expect(decks).toHaveLength(6);
    for (const deck of decks) {
      expect(deck.fitness).toBe(0.55);
    }
  });

  it('records a thrown search as an honest slice-failed drop', async () => {
    const { stats, decks } = await runSlice({
      evaluate: (_candidates) =>
        Promise.reject(new Error('chunk worker crashed')),
    });
    expect(stats).toMatchObject({ dropped: true, reason: 'slice-failed' });
    expect(stats.error).toMatch(/chunk worker crashed/);
    expect(decks).toEqual([]);
  });
});

describe('runSlices', () => {
  it('runs slices with per-slice seeds and continues past failures', async () => {
    const runs = await runSlices({
      sliceCount: 3,
      fullPool: smallPool,
      cards: smallCards,
      league,
      seedBase: 20261123,
      evaluate: (sliceIndex) =>
        sliceIndex === 1
          ? (_candidates) => Promise.reject(new Error('slice 1 broken'))
          : indexFitnessEvaluator(),
    });
    expect(runs.map((run) => run.stats.sliceIndex)).toEqual([0, 1, 2]);
    expect(runs.map((run) => run.stats.seed)).toEqual([
      20261123 + 900,
      20261123 + 901,
      20261123 + 902,
    ]);
    // slice 1 failed honestly; slices 0 and 2 are unaffected
    expect(runs[1]!.stats).toMatchObject({
      dropped: true,
      reason: 'slice-failed',
      error: 'slice 1 broken',
    });
    expect(runs[1]!.decks).toEqual([]);
    expect(runs[0]!.stats.dropped).toBe(false);
    expect(runs[2]!.stats.dropped).toBe(false);
    expect(runs[0]!.decks.length).toBeGreaterThan(0);
    expect(runs[2]!.decks.length).toBeGreaterThan(0);
  });

  it('resumes deterministically: an identical re-run replays the same slice', async () => {
    const first = await runSlice();
    const second = await runSlice();
    expect(second.stats).toEqual(first.stats);
    expect(second.decks).toEqual(first.decks);
  });
});
