import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import {
  elitesDeckProblems,
  type LegalPool,
} from '../arena/map-elites-mutation';
import {
  buildCorpus,
  COVERAGE_TRAIN_WEIGHT,
  type Corpus,
  type CorpusArchive,
  type CorpusLeague,
  type CorpusPair,
  type CoveragePair,
} from './corpus';
import {
  coverageHistogram,
  coverageSeedFor,
  deltasFromReport,
  identityOccurrences,
  type PlannedSweepDeck,
  pairMentionedIdentities,
  planSweepDecks,
  topFranchiseInks,
  unseenIdentities,
  widenRestrictedPool,
} from './coverage';

// ---- fixtures ----

const mkCard = (
  id: number,
  inks: string[],
  franchise: string,
  overrides: Partial<Card> = {},
): Card => ({
  id,
  name: `Card ${id}`,
  fullName: `Card ${id}`,
  groupKey: `card-${id}`,
  inks: inks as Card['inks'],
  isDualInk: inks.length > 1,
  cost: 3,
  inkwell: true,
  type: 'Character',
  subtypes: ['Floodborn'],
  isSong: false,
  franchise,
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
  ...overrides,
});

/** 30-card fixture deck over three identities */
function fixtureDeck(baseId: number): Record<string, number> {
  return {
    [String(baseId)]: 10,
    [String(baseId + 1)]: 10,
    [String(baseId + 2)]: 10,
  };
}

const fixtureArchive: CorpusArchive = {
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  seed: 20261122,
  cells: {
    'cell-a': { cellKey: 'cell-a', deck: fixtureDeck(1) },
    'cell-b': { cellKey: 'cell-b', deck: fixtureDeck(11) },
  },
};

const fixtureLeague: CorpusLeague = {
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  members: [
    { id: 'selfplay:aaaa1111', kind: 'selfplay', deck: fixtureDeck(21) },
  ],
};

/** LegalPool from fixture cards (fixture maxCopies are always numeric) */
const poolOf = (cards: Card[]): LegalPool =>
  new Map(
    cards.map((card) => [
      card.id,
      { maxCopies: card.maxCopies as number, inks: card.inks },
    ]),
  );

// 45 Amber + 45 Ruby identities (3 copies each) — enough ink-legal filler
// for 60-card sweep decks around any single-ink forced group
const poolCards = [
  ...Array.from({ length: 45 }, (_, i) => mkCard(600 + i, ['Amber'], 'F')),
  ...Array.from({ length: 45 }, (_, i) => mkCard(700 + i, ['Ruby'], 'F')),
];
const sweepPool: LegalPool = poolOf(poolCards);

const fixtureCorpus: Corpus = buildCorpus({
  archives: [fixtureArchive],
  league: fixtureLeague,
  corpusSeed: 7,
  samplesPerDeck: 2,
}).corpus;

// pool: the fixture identities (all mentioned) plus 30 uncovered extras
const poolIds: number[] = [];
for (const pair of fixtureCorpus.pairs) {
  for (const id of pairMentionedIdentities(pair)) {
    const numeric = Number(id);
    if (!poolIds.includes(numeric)) poolIds.push(numeric);
  }
}
poolIds.push(...Array.from({ length: 30 }, (_, i) => 100 + i));

// ---- unseen-card detection ----

describe('unseenIdentities', () => {
  it('returns pool identities appearing in zero pairs', () => {
    const unseen = unseenIdentities(poolIds, fixtureCorpus.pairs);
    expect(unseen).toEqual(Array.from({ length: 30 }, (_, i) => 100 + i));
  });

  it('counts substitution-delta endpoints as mentions', () => {
    const pairs: CorpusPair[] = [
      ...fixtureCorpus.pairs,
      {
        stratum: 'substitution-delta',
        deckId: 'archive:20261122:cell-a',
        cellKey: 'cell-a',
        context: { 1: 9 },
        cardOut: '1',
        cardIn: '777',
        delta: 0.05,
      },
    ];
    const unseen = unseenIdentities([1, 777, 999], pairs);
    expect(unseen).toEqual([999]);
  });

  it('returns every id when the corpus is empty', () => {
    expect(unseenIdentities([3, 1, 2], [])).toEqual([1, 2, 3]);
  });
});

// ---- widening rule ----

describe('widenRestrictedPool', () => {
  // 12 Frozen Amethyst + 8 Frozen Ruby franchise identities
  const franchiseCards = [
    ...Array.from({ length: 12 }, (_, i) =>
      mkCard(200 + i, ['Amethyst'], 'Frozen'),
    ),
    ...Array.from({ length: 8 }, (_, i) => mkCard(300 + i, ['Ruby'], 'Frozen')),
  ];
  const otherCards = [
    ...Array.from({ length: 50 }, (_, i) =>
      mkCard(400 + i, ['Amethyst'], 'Other'),
    ),
    ...Array.from({ length: 50 }, (_, i) => mkCard(500 + i, ['Ruby'], 'Other')),
  ];
  const allCards = [...franchiseCards, ...otherCards];
  const fullPool: LegalPool = poolOf(allCards);
  const frozenSpec = {
    condition: 'franchise:Frozen',
    slug: 'franchise-frozen',
    kind: 'franchise' as const,
    franchise: 'Frozen',
  };

  it('widens a thin franchise pool with its 2 most-represented inks', () => {
    const widened = widenRestrictedPool({
      spec: frozenSpec,
      fullPool,
      cards: allCards,
    });
    expect(widened.originalSize).toBe(20);
    expect(widened.inkPair).toEqual(['Amethyst', 'Ruby']);
    // franchise 20 ∪ ink-pair (50 Amethyst + 50 Ruby) = 120
    expect(widened.widenedSize).toBe(120);
    expect(widened.fellBackToFullPool).toBe(false);
    for (const card of franchiseCards) {
      expect(widened.pool.has(card.id)).toBe(true);
    }
    // non-franchise members of the widened pool are ink-pair coherent
    for (const [id, entry] of widened.pool) {
      if (franchiseCards.some((card) => card.id === id)) continue;
      expect(entry.inks.every((ink) => widened.inkPair!.includes(ink))).toBe(
        true,
      );
    }
  });

  it('falls back to the full pool when the widening stays below the floor', () => {
    const widened = widenRestrictedPool({
      spec: frozenSpec,
      fullPool,
      cards: allCards,
      minIdentities: 151,
    });
    expect(widened.originalSize).toBe(20);
    expect(widened.fellBackToFullPool).toBe(true);
    expect(widened.widenedSize).toBe(fullPool.size);
    expect(widened.pool).toBe(fullPool);
  });

  it('records original and widened sizes on both paths', () => {
    const above = widenRestrictedPool({
      spec: frozenSpec,
      fullPool,
      cards: allCards,
    });
    expect(above.originalSize).toBeLessThan(above.widenedSize);
    const below = widenRestrictedPool({
      spec: frozenSpec,
      fullPool,
      cards: allCards,
      minIdentities: 200,
    });
    expect(below.originalSize).toBe(20);
    expect(below.widenedSize).toBe(fullPool.size);
  });

  it('ranks ink pairs by franchise-card count, ties by ink name', () => {
    const cards = [
      mkCard(1, ['Sapphire'], 'F'),
      mkCard(2, ['Sapphire'], 'F'),
      mkCard(3, ['Amber'], 'F'),
      mkCard(4, ['Ruby'], 'F'),
      mkCard(5, ['Ruby'], 'F'),
    ];
    expect(
      topFranchiseInks(
        new Map(
          cards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
        ),
        'F',
        new Map(cards.map((card) => [card.id, card])),
      ),
    ).toEqual(['Ruby', 'Sapphire']);
  });
});

// ---- histogram math ----

describe('coverageHistogram', () => {
  it('computes share-at-≥1 and share-at-≥3 over the pool', () => {
    const occurrences = new Map([
      ['1', 5],
      ['2', 3],
      ['3', 1],
      ['4', 2],
    ]);
    const histogram = coverageHistogram(occurrences, [1, 2, 3, 4, 5, 6]);
    expect(histogram.poolSize).toBe(6);
    expect(histogram.seen).toBe(4);
    expect(histogram.shareSeen).toBeCloseTo(4 / 6);
    expect(histogram.atLeast3).toBe(2); // ids 1 (5×) and 2 (3×)
    expect(histogram.shareAtLeast3).toBeCloseTo(2 / 6);
    expect(histogram.meanOccurrences).toBeCloseTo(11 / 4);
    expect(histogram.maxOccurrences).toBe(5);
    expect(histogram.unseen).toEqual([5, 6]);
    expect(histogram.counts).toEqual({ 1: 1, 2: 1, 3: 1, 5: 1 });
  });

  it('treats an empty pool as fully covered', () => {
    const histogram = coverageHistogram(new Map(), []);
    expect(histogram.shareSeen).toBe(1);
    expect(histogram.shareAtLeast3).toBe(1);
  });
});

// ---- coverage-stratum tagging + weight ----

describe('coverage stratum in buildCorpus', () => {
  const built = buildCorpus({
    archives: [fixtureArchive],
    league: fixtureLeague,
    corpusSeed: 7,
    samplesPerDeck: 2,
    // deliberately weak fitness: the stratum has NO threshold
    coverageDecks: [
      { deckId: 'sweep-0', deck: fixtureDeck(41), fitness: 0.1 },
      { deckId: 'sweep-1', deck: fixtureDeck(51), fitness: 0.9 },
    ],
  });
  const coverage = built.corpus.pairs.filter(
    (pair): pair is CoveragePair => pair.stratum === 'coverage',
  );

  it('tags sweep pairs with stratum coverage, weight and fitness', () => {
    expect(coverage.length).toBeGreaterThan(0);
    for (const pair of coverage) {
      expect(pair.trainWeight).toBe(COVERAGE_TRAIN_WEIGHT);
      expect(pair.deckId.startsWith('coverage:')).toBe(true);
      expect([0.1, 0.9]).toContain(pair.fitness);
    }
    // no fitness threshold: the 0.1-fitness deck still entered
    expect(coverage.some((pair) => pair.deckId === 'coverage:sweep-0')).toBe(
      true,
    );
  });

  it('records the stratum fitness distribution separately', () => {
    // nearest-rank lower median of [0.1, 0.9]
    expect(built.stats.coverageFitness).toEqual({
      min: 0.1,
      median: 0.1,
      mean: 0.5,
      max: 0.9,
    });
    expect(built.stats.strata.coverage.pairs).toBe(coverage.length);
    expect(built.stats.strata.coverage.decks).toBe(2);
  });

  it('keeps coverage holdout deck-exact and disjoint from other strata', () => {
    const keys = new Set(coverage.map((pair) => pair.cellKey));
    // the shared holdout rule: every 5th key per stratum (sorted) is holdout
    const sorted = [...keys].sort();
    const expectedHoldout = sorted.filter((_, index) => index % 5 === 0);
    expect(built.corpus.holdoutCellKeys).toEqual(
      expect.arrayContaining(expectedHoldout),
    );
    expect(expectedHoldout.length).toBeGreaterThan(0);
    for (const pair of built.corpus.pairs) {
      const isHoldout = built.corpus.holdoutCellKeys.includes(pair.cellKey);
      if (pair.stratum === 'coverage') {
        expect(isHoldout).toBe(expectedHoldout.includes(pair.cellKey));
      } else {
        // no coverage key ever carries another stratum's pairs
        expect(keys.has(pair.cellKey)).toBe(false);
      }
    }
  });
});

// ---- sweep deck planning ----

describe('planSweepDecks', () => {
  it('forces every unseen identity into a legal deck, ink-coherently', () => {
    const unseen = [
      ...Array.from({ length: 25 }, (_, i) => 600 + i), // Amber
      ...Array.from({ length: 18 }, (_, i) => 700 + i), // Ruby
    ];
    const plan = planSweepDecks({
      unseen,
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 20261130,
    });
    expect(plan.truncated).toEqual([]);
    expect(plan.unplaced).toEqual([]);
    expect(plan.decks.length).toBe(3); // 25 + 18 unseen at 20/deck
    const forcedIds = plan.decks.flatMap((deck) => deck.forced);
    expect(forcedIds.sort((a, b) => a - b)).toEqual(
      [...unseen].sort((a, b) => a - b),
    );
    for (const deck of plan.decks) {
      const total = Object.values(deck.deck).reduce((a, b) => a + b, 0);
      expect(total).toBe(60);
      for (const id of deck.forced) {
        expect(deck.deck[String(id)]).toBe(1);
      }
    }
  });

  it('produces decks that clear elitesDeckProblems', () => {
    const unseen = Array.from({ length: 20 }, (_, i) => 600 + i);
    const plan = planSweepDecks({
      unseen,
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 20261130,
    });
    expect(plan.decks.length).toBe(1);
    expect(
      elitesDeckProblems(plan.decks[0]!.deck, sweepPool, poolCards),
    ).toEqual([]);
  });

  it('is deterministic for the same seed and inputs', () => {
    const unseen = Array.from({ length: 24 }, (_, i) => 700 + i);
    const a = planSweepDecks({
      unseen,
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 7,
    });
    const b = planSweepDecks({
      unseen,
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 7,
    });
    expect(a).toEqual(b);
    const c = planSweepDecks({
      unseen,
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 8,
    });
    expect(c).not.toEqual(a);
  });

  it('honors the deck cap and reports the truncation', () => {
    const unseen = Array.from({ length: 45 }, (_, i) => 600 + i);
    const plan = planSweepDecks({
      unseen,
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 20261130,
      maxDecks: 2,
    });
    expect(plan.decks.length).toBe(2);
    const covered = new Set(plan.decks.flatMap((deck) => deck.forced));
    const truncated = unseen.filter((id) => !covered.has(id));
    expect(plan.truncated.sort((a, b) => a - b)).toEqual(truncated);
  });

  it('carries cross-print group conflicts into the next deck', () => {
    // two prints (ids 900, 901) share one groupKey with maxCopies 1 — both
    // unseen, but only one can sit in a deck
    const printA = mkCard(900, ['Amber'], 'F', {
      groupKey: 'shared',
      maxCopies: 1,
    });
    const printB = mkCard(901, ['Amber'], 'F', {
      groupKey: 'shared',
      maxCopies: 1,
    });
    const cards = [...poolCards, printA, printB];
    const poolWithPrints: LegalPool = new Map([
      ...sweepPool,
      [900, { maxCopies: 1, inks: ['Amber'] }],
      [901, { maxCopies: 1, inks: ['Amber'] }],
    ]);
    const plan = planSweepDecks({
      unseen: [900, 901],
      pool: poolWithPrints,
      cards,
      masterSeed: 20261130,
    });
    expect(plan.decks.length).toBe(2);
    expect(plan.decks[0]!.forced).toContain(900);
    expect(plan.decks[0]!.forced).not.toContain(901);
    expect(plan.decks[1]!.forced).toContain(901);
    expect(plan.unplaced).toEqual([]);
    for (const deck of plan.decks) {
      expect(elitesDeckProblems(deck.deck, poolWithPrints, cards)).toEqual([]);
    }
  });
});

// ---- seed derivation + delta reconstruction ----

describe('coverageSeedFor', () => {
  it('is stable per (master seed, deck index) and differs across decks', () => {
    expect(coverageSeedFor(20261130, 0)).toBe(coverageSeedFor(20261130, 0));
    expect(coverageSeedFor(20261130, 0)).not.toBe(coverageSeedFor(20261130, 1));
    expect(coverageSeedFor(20261130, 0)).not.toBe(coverageSeedFor(20261131, 0));
  });
});

describe('deltasFromReport', () => {
  it('reconstructs the context as deck − one cardOut', () => {
    const decksById = new Map([
      ['archive:20261122:cell-a', { deck: fixtureDeck(1) }],
    ]);
    const inputs = deltasFromReport(
      {
        stratum: 'substitution-delta',
        engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
        pairs: [
          {
            deckId: 'archive:20261122:cell-a',
            cardOut: '1',
            cardIn: '999',
            delta: 0.05,
          },
        ],
      },
      decksById,
    );
    expect(inputs).toEqual([
      {
        deckId: 'archive:20261122:cell-a',
        context: { 1: 9, 2: 10, 3: 10 },
        cardOut: '1',
        cardIn: '999',
        delta: 0.05,
      },
    ]);
  });

  it('throws when the delta references an unknown deck', () => {
    expect(() =>
      deltasFromReport(
        {
          stratum: 'substitution-delta',
          engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
          pairs: [
            {
              deckId: 'archive:20261122:missing',
              cardOut: '1',
              cardIn: '999',
              delta: 0,
            },
          ],
        },
        new Map(),
      ),
    ).toThrow(/unknown corpus deck/);
  });
});

// ---- occurrence counting ----

describe('identityOccurrences', () => {
  it('counts each pair that mentions an identity once', () => {
    const pairs = fixtureCorpus.pairs;
    const occurrences = identityOccurrences(pairs);
    for (const [id, count] of occurrences) {
      expect(count).toBe(
        pairs.filter((pair) => pairMentionedIdentities(pair).includes(id))
          .length,
      );
    }
  });
});

// ---- planned deck shape sanity ----

describe('PlannedSweepDeck', () => {
  it('keeps forced copies at 1 and inks sorted', () => {
    const plan = planSweepDecks({
      unseen: [600],
      pool: sweepPool,
      cards: poolCards,
      masterSeed: 1,
    });
    const deck: PlannedSweepDeck = plan.decks[0]!;
    expect(deck.forced).toEqual([600]);
    expect(deck.inks).toEqual(['Amber']);
    expect(deck.deck[600]).toBe(1);
  });
});
