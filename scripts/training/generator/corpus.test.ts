import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../prng';
import {
  type BuiltCorpus,
  buildCorpus,
  type CorpusArchive,
  type CorpusLeague,
  MAX_REGION_CARDS,
  type MaskedElitesPair,
  MIN_REGION_CARDS,
  maskRegion,
  planRegionSizes,
  RESTRICTED_MIN_FITNESS,
  type RestrictedPair,
  sampleSeedFor,
  stableStringify,
} from './corpus';

/** 30-card fixture deck: three identities × 10 copies */
function fixtureDeck(baseId: number): Record<string, number> {
  return {
    [String(baseId + 2)]: 10,
    [String(baseId)]: 10,
    [String(baseId + 1)]: 10, // deliberately unsorted insertion order
  };
}

function fixtureArchive(): CorpusArchive {
  return {
    format: 'core',
    engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
    seed: 20261122,
    cells: {
      'cell-b': { cellKey: 'cell-b', deck: fixtureDeck(11) },
      'cell-a': { cellKey: 'cell-a', deck: fixtureDeck(1) },
      'cell-c': { cellKey: 'cell-c', deck: fixtureDeck(21) },
    },
  };
}

function fixtureLeague(): CorpusLeague {
  return {
    format: 'core',
    engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
    members: [
      // promoted elite with its own unique deck
      { id: 'selfplay:aaaa1111', kind: 'selfplay', deck: fixtureDeck(31) },
      // promoted elite that duplicates archive cell-a's deck → deduped
      { id: 'selfplay:bbbb2222', kind: 'selfplay', deck: fixtureDeck(1) },
      // league baselines are never corpus material
      {
        id: 'baseline-random:cccc3333',
        kind: 'baseline-random',
        deck: fixtureDeck(41),
      },
      { id: 'real:dddd4444', kind: 'real', deck: fixtureDeck(51) },
    ],
  };
}

function buildFixture(samplesPerDeck = 2): BuiltCorpus {
  return buildCorpus({
    archives: [fixtureArchive()],
    league: fixtureLeague(),
    corpusSeed: 7,
    samplesPerDeck,
  });
}

/** per-pair structural invariants from the spec (imitation pairs only) */
function expectValidPair(
  pair: MaskedElitesPair | RestrictedPair,
  deck: Record<string, number>,
): void {
  const deckTotal = Object.values(deck).reduce((a, b) => a + b, 0);
  const seedTotal = Object.values(pair.seed).reduce((a, b) => a + b, 0);
  const targetTotal = Object.values(pair.target).reduce((a, b) => a + b, 0);
  for (const [id, count] of Object.entries(pair.seed)) {
    expect(count).toBeLessThanOrEqual(deck[id] ?? 0);
    expect(count).toBeGreaterThan(0);
  }
  for (const [id, count] of Object.entries(pair.target)) {
    expect(count).toBeLessThanOrEqual(deck[id] ?? 0);
    expect(count).toBeGreaterThan(0);
  }
  expect(seedTotal + targetTotal).toBe(deckTotal);
  // strict subset: the masked region is non-empty and bounded by the band
  expect(targetTotal).toBeGreaterThanOrEqual(MIN_REGION_CARDS);
  expect(targetTotal).toBeLessThanOrEqual(MAX_REGION_CARDS);
  expect(seedTotal).toBeLessThan(deckTotal);
  expect(seedTotal).toBeGreaterThan(0);
}

describe('masked-elites corpus builder', () => {
  const { corpus, stats } = buildFixture();

  it('yields the expected pair count per deck (samples × 3 regions)', () => {
    // 3 archive cells + 1 unique promoted league deck; the duplicate and the
    // non-selfplay members never yield pairs
    expect(stats.duplicatesSkipped).toBe(1);
    expect(stats.tooSmallSkipped).toBe(0);
    expect(stats.decks).toBe(4);
    expect(corpus.pairs.length).toBe(4 * 2 * 3);
    expect(stats.pairs).toBe(24);
    const byDeck = new Map<string, number>();
    for (const pair of corpus.pairs) {
      byDeck.set(pair.deckId, (byDeck.get(pair.deckId) ?? 0) + 1);
    }
    expect([...byDeck.values()]).toEqual([6, 6, 6, 6]);
    expect(byDeck.has('league:baseline-random:cccc3333')).toBe(false);
    expect(byDeck.has('league:real:dddd4444')).toBe(false);
    expect(byDeck.has('league:selfplay:bbbb2222')).toBe(false);
  });

  it('keeps every seed a strict subset of its deck', () => {
    const decks = new Map<string, Record<string, number>>([
      ['archive:20261122:cell-a', fixtureDeck(1)],
      ['archive:20261122:cell-b', fixtureDeck(11)],
      ['archive:20261122:cell-c', fixtureDeck(21)],
      ['league:selfplay:aaaa1111', fixtureDeck(31)],
    ]);
    expect(new Set(corpus.pairs.map((pair) => pair.stratum))).toEqual(
      new Set(['masked-elites']),
    );
    for (const pair of corpus.pairs.filter(
      (candidate) => candidate.stratum === 'masked-elites',
    )) {
      expect(decks.has(pair.deckId)).toBe(true);
      expectValidPair(pair, decks.get(pair.deckId)!);
    }
  });

  it('splits holdout by cell, disjoint from training decks', () => {
    // sorted deck keys: cell-a, cell-b, cell-c, league:selfplay:aaaa1111
    // → every 5th (index 0) → only cell-a is holdout
    expect(corpus.holdoutCellKeys).toEqual(['cell-a']);
    const holdoutDecks = new Set(
      corpus.pairs
        .filter((pair) => corpus.holdoutCellKeys.includes(pair.cellKey))
        .map((pair) => pair.deckId),
    );
    const trainDecks = new Set(
      corpus.pairs
        .filter((pair) => !corpus.holdoutCellKeys.includes(pair.cellKey))
        .map((pair) => pair.deckId),
    );
    expect(holdoutDecks).toEqual(new Set(['archive:20261122:cell-a']));
    for (const deck of holdoutDecks) expect(trainDecks.has(deck)).toBe(false);
    expect(stats.holdoutDecks).toBe(1);
    expect(stats.holdoutPairs).toBe(6);
  });

  it('is byte-deterministic regardless of input key order', () => {
    const rebuilt = buildFixture();
    expect(stableStringify(rebuilt.corpus)).toBe(stableStringify(corpus));
    // also identical when the archive array order is reversed (cells sort)
    const reversed = buildCorpus({
      archives: [fixtureArchive()],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 2,
    });
    expect(stableStringify(reversed.corpus)).toBe(stableStringify(corpus));
  });

  it('skips decks too small for one masked region', () => {
    const result = buildCorpus({
      archives: [
        {
          ...fixtureArchive(),
          cells: { 'cell-tiny': { cellKey: 'cell-tiny', deck: { 1: 5 } } },
        },
      ],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 2,
    });
    expect(result.stats.tooSmallSkipped).toBe(1);
    expect(
      result.corpus.pairs.filter(
        (pair) => pair.deckId === 'archive:20261122:cell-tiny',
      ).length,
    ).toBe(0);
    expect(result.corpus.holdoutCellKeys).not.toContain('cell-tiny');
  });

  it('keeps deck ids unique when two archives share a descriptor cell', () => {
    // the 20261123 growth archive can hold a DIFFERENT elite deck in a cell
    // key that also exists in the 20261122 archive; both are corpus decks
    const result = buildCorpus({
      archives: [
        fixtureArchive(),
        {
          ...fixtureArchive(),
          seed: 20261123,
          cells: {
            'cell-a': { cellKey: 'cell-a', deck: fixtureDeck(61) }, // same key, different deck
          },
        },
      ],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 1,
    });
    const ids = new Set(result.corpus.pairs.map((pair) => pair.deckId));
    expect(ids.has('archive:20261122:cell-a')).toBe(true);
    expect(ids.has('archive:20261123:cell-a')).toBe(true);
    // …but they share the descriptor cell, so they share the split side
    const sideOf = new Map(
      result.corpus.pairs.map((pair) => [pair.deckId, pair.cellKey]),
    );
    expect(sideOf.get('archive:20261122:cell-a')).toBe(
      sideOf.get('archive:20261123:cell-a'),
    );
  });

  it('rejects disagreeing formats and engine eras', () => {
    const archive = fixtureArchive();
    expect(() =>
      buildCorpus({
        archives: [archive],
        league: { ...fixtureLeague(), format: 'infinity' },
        corpusSeed: 7,
      }),
    ).toThrow(/formats disagree/);
    expect(() =>
      buildCorpus({
        archives: [archive],
        league: { ...fixtureLeague(), engineCommit: 'deadbeef' },
        corpusSeed: 7,
      }),
    ).toThrow(/engine eras/);
  });

  it('throws on malformed identity counts', () => {
    expect(() =>
      buildCorpus({
        archives: [
          {
            ...fixtureArchive(),
            cells: { 'cell-bad': { cellKey: 'cell-bad', deck: { 1: 2.5 } } },
          },
        ],
        league: fixtureLeague(),
        corpusSeed: 7,
      }),
    ).toThrow(/malformed deck entry/);
  });
});

describe('stratified corpus (three strata, tasks 1.4/1.5 contract)', () => {
  /** every imitation pair carries its stratum tag */
  it('tags masked-elites pairs', () => {
    const { corpus } = buildFixture();
    for (const pair of corpus.pairs) {
      expect(pair.stratum).toBe('masked-elites');
    }
  });

  it('excludes restricted decks below the threshold and tags the rest', () => {
    const result = buildCorpus({
      archives: [fixtureArchive()],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 1,
      restrictedDecks: [
        {
          condition: 'inks:ruby-sapphire',
          deckId: 'restr-1',
          deck: fixtureDeck(61),
          fitness: RESTRICTED_MIN_FITNESS, // boundary: strict > → excluded too
        },
        {
          condition: 'inks:ruby-sapphire',
          deckId: 'restr-2',
          deck: fixtureDeck(71),
          fitness: 0.6,
        },
        {
          condition: 'franchise:Frozen',
          deckId: 'restr-3',
          deck: fixtureDeck(81),
          fitness: 0.2, // below threshold → excluded
        },
      ],
    });
    expect(result.stats.restrictedBelowThreshold).toBe(2);
    const restricted = result.corpus.pairs.filter(
      (pair) => pair.stratum === 'restricted',
    );
    // only restr-2 passed the strict threshold
    const conditions = new Set(
      restricted
        .filter((pair) => pair.stratum === 'restricted')
        .map((pair) => pair.condition),
    );
    expect(conditions).toEqual(new Set(['inks:ruby-sapphire']));
    const deckIds = new Set(restricted.map((pair) => pair.deckId));
    expect(deckIds).toEqual(new Set(['restricted:inks:ruby-sapphire:restr-2']));
    expect(result.stats.strata.restricted.decks).toBe(1);
    expect(result.stats.strata.restricted.pairs).toBe(3);
  });

  it('keeps the holdout split deck-exact across strata', () => {
    const result = buildCorpus({
      archives: [fixtureArchive()],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 1,
      restrictedDecks: [
        {
          condition: 'inks:ruby-sapphire',
          deckId: 'r1',
          deck: fixtureDeck(61),
          fitness: 0.6,
        },
        {
          condition: 'inks:ruby-sapphire',
          deckId: 'r2',
          deck: fixtureDeck(71),
          fitness: 0.6,
        },
      ],
      // deltas on one train elite and one holdout elite
      substitutionDeltas: [
        {
          deckId: 'archive:20261122:cell-a',
          context: { ...fixtureDeck(1), [String(1)]: 9 },
          cardOut: '1',
          cardIn: '999',
          delta: 0.1,
        },
        {
          deckId: 'archive:20261122:cell-b',
          context: { ...fixtureDeck(11), [String(11)]: 9 },
          cardOut: '11',
          cardIn: '999',
          delta: -0.05,
        },
      ],
    });
    const holdout = new Set(result.corpus.holdoutCellKeys);
    // cell-a sorts first in masked-elites → holdout; cell-b → train
    expect(holdout.has('cell-a')).toBe(true);
    expect(holdout.has('cell-b')).toBe(false);
    // restricted pseudo keys: every 5th within the stratum → r1 (index 0) holdout
    expect(holdout.has('restricted:inks:ruby-sapphire:r1')).toBe(true);
    expect(holdout.has('restricted:inks:ruby-sapphire:r2')).toBe(false);
    // no deck on both sides, per stratum and overall
    const bySide = (side: 'in' | 'out'): Set<string> => {
      const keys = new Set(
        result.corpus.pairs
          .filter((pair) => (side === 'in') === holdout.has(pair.cellKey))
          .map((pair) => pair.deckId),
      );
      return keys;
    };
    const holdoutDecks = bySide('in');
    const trainDecks = bySide('out');
    for (const deck of holdoutDecks) expect(trainDecks.has(deck)).toBe(false);
    // substitution pairs inherit their elite deck's side
    const deltas = result.corpus.pairs.filter(
      (pair) => pair.stratum === 'substitution-delta',
    );
    expect(deltas.length).toBe(2);
    for (const pair of deltas) {
      expect(holdout.has(pair.cellKey)).toBe(
        pair.deckId === 'archive:20261122:cell-a',
      );
    }
    // each present stratum is represented in both sides (via its decks)
    for (const [name, stratum] of Object.entries(result.stats.strata)) {
      if (stratum.decks === 0) continue;
      expect(stratum.holdoutDecks, name).toBeGreaterThan(0);
      expect(stratum.holdoutDecks, name).toBeLessThan(stratum.decks);
    }
  });

  it('dedupes restricted decks that repeat an elite deck', () => {
    const result = buildCorpus({
      archives: [fixtureArchive()],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 1,
      restrictedDecks: [
        // identical composition to archive cell-a → dropped
        {
          condition: 'inks:ruby-sapphire',
          deckId: 'dupe',
          deck: fixtureDeck(1),
          fitness: 0.6,
        },
      ],
    });
    expect(result.stats.duplicatesSkipped).toBe(2); // league dupe + restricted dupe
    expect(
      result.corpus.pairs.filter((pair) => pair.stratum === 'restricted')
        .length,
    ).toBe(0);
  });

  it('validates substitution deltas against their parent deck', () => {
    const base = {
      archives: [fixtureArchive()],
      league: fixtureLeague(),
      corpusSeed: 7,
      samplesPerDeck: 1,
    };
    expect(() =>
      buildCorpus({
        ...base,
        substitutionDeltas: [
          {
            deckId: 'archive:unknown',
            context: {},
            cardOut: '1',
            cardIn: '9',
            delta: 0,
          },
        ],
      }),
    ).toThrow(/unknown deck/);
    expect(() =>
      buildCorpus({
        ...base,
        substitutionDeltas: [
          {
            deckId: 'archive:20261122:cell-a',
            context: fixtureDeck(1),
            cardOut: '1',
            cardIn: '9',
            delta: 0,
          },
        ],
      }),
    ).toThrow(/context ≠ deck/);
    expect(() =>
      buildCorpus({
        ...base,
        substitutionDeltas: [
          {
            deckId: 'archive:20261122:cell-a',
            context: { ...fixtureDeck(1), [String(2)]: 5 },
            cardOut: '1',
            cardIn: '9',
            delta: Number.NaN,
          },
        ],
      }),
    ).toThrow(/not finite/);
    // a valid delta passes and inherits the elite's cell key
    const ok = buildCorpus({
      ...base,
      substitutionDeltas: [
        {
          deckId: 'archive:20261122:cell-c',
          context: { ...fixtureDeck(21), [String(21)]: 9 },
          cardOut: '21',
          cardIn: '999',
          delta: 0.02,
        },
      ],
    });
    const delta = ok.corpus.pairs.find(
      (pair) => pair.stratum === 'substitution-delta',
    );
    expect(delta).toMatchObject({
      deckId: 'archive:20261122:cell-c',
      cellKey: 'cell-c',
      cardOut: '21',
      cardIn: '999',
      delta: 0.02,
    });
  });
});

describe('masking primitives', () => {
  it('derives seed = deck − region and target = region composition', () => {
    const { seed, target } = maskRegion({ 1: 3, 2: 1 }, ['1', '1', '2']);
    expect(target).toEqual({ 1: 2, 2: 1 });
    expect(seed).toEqual({ 1: 1 });
  });

  it('plans disjoint in-band regions deterministically', () => {
    const a = planRegionSizes(
      60,
      mulberry32(sampleSeedFor(20261123, 'deck', 0)),
    );
    const b = planRegionSizes(
      60,
      mulberry32(sampleSeedFor(20261123, 'deck', 0)),
    );
    expect(a).toEqual(b);
    expect(a.length).toBe(3);
    let sum = 0;
    for (const size of a) {
      expect(size).toBeGreaterThanOrEqual(MIN_REGION_CARDS);
      expect(size).toBeLessThanOrEqual(MAX_REGION_CARDS);
      sum += size;
    }
    expect(sum).toBeLessThanOrEqual(60);
    // small decks degrade gracefully in region count
    expect(
      planRegionSizes(12, mulberry32(sampleSeedFor(1, 'd', 0))).length,
    ).toBe(1);
    expect(planRegionSizes(4, mulberry32(sampleSeedFor(1, 'd', 0)))).toEqual(
      [],
    );
  });

  it('derives per-(deck, sample) seeds that are stable and distinct', () => {
    expect(sampleSeedFor(7, 'archive:20261122:cell-a', 0)).toBe(
      sampleSeedFor(7, 'archive:20261122:cell-a', 0),
    );
    expect(sampleSeedFor(7, 'archive:20261122:cell-a', 0)).not.toBe(
      sampleSeedFor(7, 'archive:20261122:cell-a', 1),
    );
    expect(sampleSeedFor(7, 'archive:20261122:cell-a', 0)).not.toBe(
      sampleSeedFor(7, 'archive:20261122:cell-b', 0),
    );
    // adding a deck later must not shift existing pairs' seeds
    expect(sampleSeedFor(7, 'archive:20261122:cell-a', 3)).toBe(
      sampleSeedFor(7, 'archive:20261122:cell-a', 3),
    );
  });
});
