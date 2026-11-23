import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import type { LegalPool } from '../arena/map-elites-mutation';
import { mulberry32 } from '../prng';
import { buildCorpus, stableStringify } from './corpus';
import {
  buildSubstitution,
  type DeltaArchive,
  type DeltaPair,
  deltaSeedFor,
  deltaTotals,
  drawReplacementCandidates,
  eligibleReplacementIds,
  evaluateDeltaPairs,
  type PairEvaluation,
  planDeltaWork,
  selectTopElites,
  toDeltaInputs,
} from './deltas';

const mkCard = (id: number, ink: string, franchise = 'test'): Card => ({
  id,
  name: `Card ${id}`,
  fullName: `Card ${id}`,
  groupKey: `card-${id}`,
  inks: [ink] as Card['inks'],
  isDualInk: false,
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
});

// 30 Amber identities; the fixture deck uses 100–119, so 120–129 stay free
const cards: Card[] = Array.from({ length: 30 }, (_, i) =>
  mkCard(100 + i, 'Amber'),
);
const pool: LegalPool = new Map(
  cards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
);
// only the identities the fixture deck can draw from
const deckCards: Card[] = cards.slice(0, 20);
const deckPool: LegalPool = new Map(
  deckCards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
);

const deck = (
  start: number,
  ids: number,
  copies: number,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (let i = 0; i < ids; i++) out[String(start + i)] = copies;
  return out;
};

// 20 identities × 3 = 60 cards, declared ink Amber
const fixtureElite = {
  deckId: 'archive:20261122:cell-a',
  cellKey: 'cell-a',
  fitness: 0.6,
  deck: deck(100, 20, 3),
};

const archiveOf = (
  seed: number,
  cells: Array<[string, Record<string, number>, number]>,
): DeltaArchive => ({
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  seed,
  cells: Object.fromEntries(
    cells.map(([cellKey, deck, fitness]) => [
      cellKey,
      { cellKey, deck, fitness },
    ]),
  ),
});

const fixtureLeague = {
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  members: [],
};

const planFixture = (candidatesPerElite = 6, seed = 20261123) =>
  planDeltaWork({
    elites: [fixtureElite],
    pool,
    cards,
    masterSeed: seed,
    candidatesPerElite,
  });

describe('selectTopElites', () => {
  it('ranks by fitness across archives and keeps the corpus deck-id shape', () => {
    const archives = [
      archiveOf(20261122, [['cell-a', deck(100, 20, 3), 0.6]]),
      archiveOf(20261123, [
        ['cell-b', deck(200, 20, 3), 0.7],
        ['cell-c', deck(300, 20, 3), 0.65],
      ]),
    ];
    const elites = selectTopElites(archives, 2);
    expect(elites.map((elite) => elite.deckId)).toEqual([
      'archive:20261123:cell-b',
      'archive:20261123:cell-c',
    ]);
    expect(elites[0]!.fitness).toBe(0.7);
  });

  it('dedupes identical compositions first-wins in corpus walk order', () => {
    // cell-d (archive B) holds the same deck as cell-a (archive A); the
    // corpus's collectDeckSources keeps the FIRST archive's id, so the
    // duplicate must drop even when its fitness ranks higher
    const same = deck(100, 20, 3);
    const archives = [
      archiveOf(20261122, [['cell-a', same, 0.6]]),
      archiveOf(20261123, [
        ['cell-d', same, 0.9],
        ['cell-e', deck(300, 20, 3), 0.7],
      ]),
    ];
    const elites = selectTopElites(archives, 2);
    expect(elites.map((elite) => elite.deckId)).toEqual([
      'archive:20261123:cell-e',
      'archive:20261122:cell-a',
    ]);
  });

  it('clamps to the available elite count', () => {
    expect(
      selectTopElites(
        [archiveOf(20261122, [['cell-a', deck(100, 20, 3), 0.6]])],
        8,
      ),
    ).toHaveLength(1);
  });
});

describe('replacement candidate drawing', () => {
  it('is deterministic for a seed and respects ink + copy limits', () => {
    const d = deck(100, 20, 2); // every identity one copy below the limit
    const a = drawReplacementCandidates(d, deckPool, mulberry32(7), 6);
    const b = drawReplacementCandidates(d, deckPool, mulberry32(7), 6);
    expect(a).toEqual(b);
    expect(a).toHaveLength(6);
    for (const id of a) {
      expect(id).toBeGreaterThanOrEqual(100);
      expect(id).toBeLessThan(120);
      expect(d[String(id)]! + 1).toBeLessThanOrEqual(3);
    }
  });

  it('never draws beyond the eligible set', () => {
    const d = deck(100, 20, 3); // every draw-able identity at its copy limit
    expect(eligibleReplacementIds(d, deckPool)).toEqual([]);
    expect(drawReplacementCandidates(d, deckPool, mulberry32(7), 6)).toEqual(
      [],
    );
  });

  it('keeps out-of-ink identities ineligible', () => {
    const rubyPool: LegalPool = new Map([
      [200, { maxCopies: 3, inks: ['Ruby'] }],
    ]);
    expect(eligibleReplacementIds(deck(100, 20, 2), rubyPool)).toEqual([]);
  });

  it('returns distinct candidates', () => {
    const drawn = drawReplacementCandidates(
      deck(100, 20, 2),
      deckPool,
      mulberry32(9),
      6,
    );
    expect(new Set(drawn).size).toBe(drawn.length);
  });
});

describe('buildSubstitution legality gate', () => {
  it('builds context = deck − one cardOut and candidate = context + cardIn', () => {
    const built = buildSubstitution(fixtureElite, '100', '120', pool, cards);
    expect(built.reason).toBeUndefined();
    const work = built.work!;
    // the deck held three copies of the card-out; one moves out, two remain
    expect(work.context).toEqual({ ...deck(100, 20, 3), 100: 2 });
    expect(work.candidate).toEqual({ ...deck(100, 20, 3), 100: 2, 120: 1 });
  });

  it('rejects a card-out that is not in the deck', () => {
    expect(
      buildSubstitution(fixtureElite, '999', '120', pool, cards).reason,
    ).toMatch(/not-in-deck/);
  });

  it('rejects the degenerate card-in = card-out pair', () => {
    expect(
      buildSubstitution(fixtureElite, '100', '100', pool, cards).reason,
    ).toBe('card-in-equals-card-out');
  });

  it('rejects candidates the gate finds illegal (copy limit)', () => {
    // 105 already sits at its 3-copy limit; adding a fourth fails even though
    // the draw filter would never have picked it
    const built = buildSubstitution(fixtureElite, '100', '105', pool, cards);
    expect(built.reason).toMatch(/illegal:copy-limit-105/);
  });

  it('rejects candidates outside the pool', () => {
    const built = buildSubstitution(fixtureElite, '100', '500', pool, cards);
    expect(built.reason).toMatch(/illegal:not-in-pool-500/);
  });

  it('rejects candidates that would declare a third ink', () => {
    // a single off-ink card-in would only make a legal 2-ink deck — the
    // genuine gate rejection is the third declared ink
    const twoInkElite = {
      ...fixtureElite,
      deck: { ...deck(101, 19, 3), 200: 3 },
    };
    const emerald = mkCard(300, 'Emerald');
    const widePool: LegalPool = new Map([
      ...pool,
      [200, { maxCopies: 3, inks: ['Ruby'] }],
      [300, { maxCopies: 3, inks: ['Emerald'] }],
    ]);
    const built = buildSubstitution(twoInkElite, '101', '300', widePool, [
      ...cards,
      emerald,
    ]);
    expect(built.reason).toMatch(/illegal:inks-3/);
  });
});

describe('planDeltaWork', () => {
  it('plans one work item per candidate with card-in ≠ card-out', () => {
    const { work, skipped } = planFixture();
    expect(skipped).toEqual([]);
    expect(work).toHaveLength(6);
    for (const item of work) {
      expect(item.cardOut).not.toBe(item.cardIn);
      expect(item.elite.deckId).toBe('archive:20261122:cell-a');
      const contextTotal = Object.values(item.context).reduce(
        (a, b) => a + b,
        0,
      );
      const candidateTotal = Object.values(item.candidate).reduce(
        (a, b) => a + b,
        0,
      );
      expect(contextTotal).toBe(59);
      expect(candidateTotal).toBe(60);
    }
  });

  it('is deterministic given the same seed', () => {
    expect(stableStringify(planFixture(6, 5))).toBe(
      stableStringify(planFixture(6, 5)),
    );
    expect(stableStringify(planFixture(6, 5))).not.toBe(
      stableStringify(planFixture(6, 6)),
    );
  });

  it('records an honest skip when the pool offers no eligible candidate', () => {
    const saturated = planDeltaWork({
      elites: [{ ...fixtureElite, deckId: 'd', cellKey: 'd', fitness: 0.5 }],
      pool: deckPool,
      cards: deckCards,
      masterSeed: 1,
      candidatesPerElite: 6,
    });
    expect(saturated.work).toHaveLength(0);
    expect(saturated.skipped[0]).toMatchObject({
      deckId: 'd',
      reason: 'no-eligible-candidates',
    });
  });
});

describe('deltaSeedFor', () => {
  it('is stable and distinct per (deck, stream)', () => {
    expect(deltaSeedFor(7, 'd', 0)).toBe(deltaSeedFor(7, 'd', 0));
    expect(deltaSeedFor(7, 'd', 0)).not.toBe(deltaSeedFor(7, 'd', 1));
    expect(deltaSeedFor(7, 'd', 0)).not.toBe(deltaSeedFor(7, 'e', 0));
  });
});

describe('evaluateDeltaPairs + totals', () => {
  it('signs deltas in − out and preserves work order', async () => {
    const { work } = planFixture();
    const results: PairEvaluation[] = work.map((_, index) => ({
      delta: index % 2 === 0 ? 0.1 : -0.05,
      games: 80,
      candidateFitness: 0.5,
      contextFitness: 0.4,
    }));
    const pairs = await evaluateDeltaPairs(work, async () => results);
    expect(pairs.map((pair) => pair.delta)).toEqual(
      results.map((result) => result.delta),
    );
    expect(pairs.every((pair) => pair.games === 80)).toBe(true);
    const totals = deltaTotals(pairs);
    expect(totals).toMatchObject({
      pairs: 6,
      games: 480,
      positive: 3,
      negative: 3,
      zero: 0,
    });
    expect(totals.meanDelta).toBeCloseTo((0.1 * 3 - 0.05 * 3) / 6, 6);
  });

  it('throws when the evaluator result count disagrees', async () => {
    const { work } = planFixture(1);
    await expect(evaluateDeltaPairs(work, async () => [])).rejects.toThrow(
      /results for/,
    );
  });

  it('keeps zero deltas as zero in the distribution', () => {
    const pair = (delta: number): DeltaPair => ({
      elite: fixtureElite,
      cardOut: '100',
      cardIn: '120',
      context: {},
      candidate: {},
      delta,
      games: 80,
      candidateFitness: 0.5,
      contextFitness: 0.5 - delta,
    });
    expect(deltaTotals([pair(0), pair(0.02), pair(-0.02)])).toMatchObject({
      positive: 1,
      negative: 1,
      zero: 1,
      medianDelta: 0,
    });
  });
});

describe('corpus wiring', () => {
  it('feeds buildCorpus as substitution-delta pairs on the parent elite', async () => {
    const { work } = planFixture(3);
    const pairs = await evaluateDeltaPairs(work, async (items) =>
      items.map((_, index) => ({
        delta: index === 0 ? 0.12 : -0.03,
        games: 80,
        candidateFitness: 0.52,
        contextFitness: 0.4,
      })),
    );
    const { corpus, stats } = buildCorpus({
      archives: [archiveOf(20261122, [['cell-a', deck(100, 20, 3), 0.6]])],
      league: fixtureLeague,
      substitutionDeltas: toDeltaInputs(pairs),
    });
    const deltas = corpus.pairs.filter(
      (pair) => pair.stratum === 'substitution-delta',
    );
    expect(deltas).toHaveLength(3);
    expect(stats.strata['substitution-delta']).toMatchObject({
      decks: 1,
      pairs: 3,
    });
    for (const pair of deltas) {
      expect(pair).toMatchObject({
        deckId: 'archive:20261122:cell-a',
        cellKey: 'cell-a',
      });
    }
    // the delta inherits the elite deck's holdout side (cell-a is holdout here)
    expect(corpus.holdoutCellKeys).toContain('cell-a');
  });

  it('propagates the corpus builder validation for unknown parent decks', () => {
    expect(() =>
      buildCorpus({
        archives: [archiveOf(20261122, [['cell-a', deck(100, 20, 3), 0.6]])],
        league: fixtureLeague,
        substitutionDeltas: [
          {
            deckId: 'archive:20261122:missing',
            context: deck(100, 20, 3),
            cardOut: '100',
            cardIn: '120',
            delta: 0.1,
          },
        ],
      }),
    ).toThrow(/unknown deck/);
  });
});
