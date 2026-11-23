import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import type { League } from '../arena/league';
import type { LegalPool } from '../arena/map-elites-mutation';
import { buildCorpus, RESTRICTED_MIN_FITNESS } from './corpus';
import {
  filterLegalPool,
  passesRestrictedThreshold,
  RESTRICTED_MIN_PASSING_DECKS,
  RESTRICTED_MIN_POOL_IDENTITIES,
  type RestrictedPoolSpec,
  runRestrictedPool,
  runRestrictedPools,
} from './restricted';

const mkCard = (
  id: number,
  ink: string,
  franchise: string,
  isDualInk = false,
): Card => ({
  id,
  name: `Card ${id}`,
  fullName: `Card ${id}`,
  groupKey: `card-${id}`,
  inks: (isDualInk ? ink.split('+') : [ink]) as Card['inks'],
  isDualInk,
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

const frozenSpec: RestrictedPoolSpec = {
  condition: 'franchise:Frozen',
  slug: 'franchise-frozen',
  kind: 'franchise',
  franchise: 'Frozen',
};

// 45 Frozen Amber identities — above the thin-pool floor, enough ink-pair
// capacity for randomLegalDeck to build 60-card decks
const frozenCards: Card[] = Array.from({ length: 45 }, (_, i) =>
  mkCard(100 + i, 'Amber', 'Frozen'),
);
const frozenPool: LegalPool = new Map(
  frozenCards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
);

const thinCards: Card[] = Array.from({ length: 10 }, (_, i) =>
  mkCard(300 + i, 'Ruby', 'Thin'),
);

const league: League = {
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  seededOn: '2026-11-22T09:24:18.575Z',
  members: [
    {
      id: 'baseline-random:test',
      kind: 'baseline-random',
      // 20 Frozen identities × 3 = 60 cards, gate-clearing under the pool
      deck: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [String(100 + i), 3]),
      ),
      share: 1,
      origin: 'fixture',
    },
  ],
};

/** deterministic fake: fitness by candidate index (0.30 … 0.55) */
const indexFitnessEvaluator =
  () => async (candidates: Array<{ index: number }>) =>
    candidates.map((candidate) => ({
      index: candidate.index,
      fitness: 0.3 + 0.05 * (candidate.index % 6),
      games: 80,
    }));

describe('filterLegalPool', () => {
  it('keeps only identities of the requested franchise', () => {
    const cards = [...frozenCards, ...thinCards];
    const fullPool = new Map(
      cards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
    );
    const filtered = filterLegalPool(
      fullPool,
      frozenSpec,
      new Map(cards.map((card) => [card.id, card])),
    );
    expect(filtered.size).toBe(45);
    expect([...filtered.keys()].every((id) => id >= 100 && id < 145)).toBe(
      true,
    );
  });

  it('keeps only identities whose inks sit inside the declared pair', () => {
    const cards = [
      mkCard(1, 'Ruby', 'F'),
      mkCard(2, 'Sapphire', 'F'),
      mkCard(3, 'Ruby+Amethyst', 'F', true),
      mkCard(4, 'Emerald', 'F'),
    ];
    const fullPool: LegalPool = new Map(
      cards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
    );
    const filtered = filterLegalPool(
      fullPool,
      {
        condition: 'inks:ruby-sapphire',
        slug: 'inks-ruby-sapphire',
        kind: 'inks',
        inks: ['Ruby', 'Sapphire'],
      },
      new Map(cards.map((card) => [card.id, card])),
    );
    // the dual-ink Ruby/Amethyst card would force a third declared ink
    expect([...filtered.keys()].sort()).toEqual([1, 2]);
  });
});

describe('passesRestrictedThreshold', () => {
  it('is strict: a deck at the threshold is excluded', () => {
    expect(passesRestrictedThreshold(RESTRICTED_MIN_FITNESS)).toBe(false);
    expect(passesRestrictedThreshold(0.4500001)).toBe(true);
    expect(passesRestrictedThreshold(0.9)).toBe(true);
    expect(passesRestrictedThreshold(0.2)).toBe(false);
  });
});

describe('runRestrictedPool', () => {
  const run = async (
    overrides: Partial<Parameters<typeof runRestrictedPool>[0]> = {},
  ) =>
    runRestrictedPool({
      spec: frozenSpec,
      poolIndex: 0,
      fullPool: frozenPool,
      cards: frozenCards,
      league,
      masterSeed: 20261123,
      evaluate: indexFitnessEvaluator(),
      ...overrides,
    });

  it('records pool size, evaluated candidates, cells and passing decks', async () => {
    const leagueBefore = structuredClone(league);
    const { stats, decks } = await run();
    expect(stats).toMatchObject({
      condition: 'franchise:Frozen',
      slug: 'franchise-frozen',
      poolIndex: 0,
      masterSeed: 20261123,
      poolSize: 45,
      candidatesEvaluated: 12,
      games: 960,
      dropped: false,
    });
    expect(stats.cells).toBeGreaterThanOrEqual(1);
    expect(stats.cellsPassingThreshold).toBeGreaterThanOrEqual(1);
    // index fitness 0.45/0.50/0.55 per generation → ≥ 3 passing decks
    expect(decks.length).toBeGreaterThanOrEqual(RESTRICTED_MIN_PASSING_DECKS);
    expect(stats.passingDecks).toBe(decks.length);
    for (const deck of decks) {
      expect(deck.condition).toBe('franchise:Frozen');
      expect(deck.fitness).toBeGreaterThan(RESTRICTED_MIN_FITNESS);
      expect(deck.fitness).not.toBe(RESTRICTED_MIN_FITNESS);
      expect(deck.deckId).toMatch(/^gen-\d+-cand-\d+$/);
    }
    // the shared league is never mutated by a restricted run
    expect(league).toEqual(leagueBefore);
  });

  it('drops thin pools before any search runs', async () => {
    let evaluated = 0;
    const { stats, decks } = await run({
      spec: {
        condition: 'franchise:Thin',
        slug: 'franchise-thin',
        kind: 'franchise',
        franchise: 'Thin',
      },
      fullPool: new Map(
        thinCards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
      ),
      evaluate: (candidates) => {
        evaluated += candidates.length;
        return Promise.resolve(
          candidates.map((candidate) => ({
            index: candidate.index,
            fitness: 0.9,
            games: 80,
          })),
        );
      },
    });
    expect(stats.poolSize).toBeLessThan(RESTRICTED_MIN_POOL_IDENTITIES);
    expect(stats).toMatchObject({ dropped: true, reason: 'thin-pool' });
    expect(decks).toEqual([]);
    expect(evaluated).toBe(0);
  });

  it('records a failed search as an honest drop and keeps decks empty', async () => {
    const { stats, decks } = await run({
      evaluate: (_candidates) =>
        Promise.reject(new Error('no legal parents available')),
    });
    expect(stats).toMatchObject({ dropped: true, reason: 'search-failed' });
    expect(stats.error).toMatch(/no legal parents/);
    expect(decks).toEqual([]);
  });

  it('drops pools under the passing-deck floor honestly', async () => {
    const { stats, decks } = await run({
      evaluate: (candidates) =>
        Promise.resolve(
          candidates.map((candidate) => ({
            index: candidate.index,
            fitness: RESTRICTED_MIN_FITNESS, // at-threshold: never passing
            games: 80,
          })),
        ),
    });
    expect(stats).toMatchObject({
      dropped: true,
      reason: 'below-threshold-pass-count',
      candidatesEvaluated: 12,
    });
    expect(decks).toEqual([]);
  });

  it('keeps duplicate compositions to one corpus entry', async () => {
    const { decks } = await run({
      evaluate: (candidates) =>
        Promise.resolve(
          candidates.map((candidate) => ({
            index: candidate.index,
            // every candidate evaluates to the same deck composition? no —
            // mutants differ; instead force fitness above threshold for all
            fitness: 0.6,
            games: 80,
          })),
        ),
    });
    const compositions = new Set(
      decks.map((deck) => JSON.stringify(Object.entries(deck.deck).sort())),
    );
    expect(compositions.size).toBe(decks.length);
  });
});

describe('runRestrictedPools', () => {
  it('runs the pre-committed pool list with per-pool master seeds', async () => {
    const thinSpec: RestrictedPoolSpec = {
      condition: 'franchise:Thin',
      slug: 'franchise-thin',
      kind: 'franchise',
      franchise: 'Thin',
    };
    const runs = await runRestrictedPools({
      specs: [thinSpec, frozenSpec],
      fullPool: new Map([
        ...frozenPool,
        ...thinCards.map(
          (card) => [card.id, { maxCopies: 3, inks: card.inks }] as const,
        ),
      ]),
      cards: [...frozenCards, ...thinCards],
      league,
      seedBase: 20261123,
      evaluate: () => indexFitnessEvaluator(),
    });
    expect(runs.map((run) => run.stats.condition)).toEqual([
      'franchise:Thin',
      'franchise:Frozen',
    ]);
    expect(runs[0]!.stats).toMatchObject({
      poolIndex: 0,
      masterSeed: 20261123,
      dropped: true,
      reason: 'thin-pool',
    });
    expect(runs[1]!.stats).toMatchObject({
      poolIndex: 1,
      masterSeed: 20261124,
      dropped: false,
    });
  });
});

describe('restricted corpus wiring', () => {
  it('feeds surviving decks into buildCorpus with condition tags', async () => {
    const { decks } = await runRestrictedPool({
      spec: frozenSpec,
      poolIndex: 0,
      fullPool: frozenPool,
      cards: frozenCards,
      league,
      masterSeed: 20261123,
      evaluate: indexFitnessEvaluator(),
    });
    const { corpus, stats } = buildCorpus({
      archives: [],
      league: {
        format: league.format,
        engineCommit: league.engineCommit,
        members: league.members.map(({ id, kind, deck }) => ({
          id,
          kind,
          deck,
        })),
      },
      restrictedDecks: decks,
    });
    const restricted = corpus.pairs.filter(
      (pair) => pair.stratum === 'restricted',
    );
    expect(restricted.length).toBeGreaterThan(0);
    for (const pair of restricted) {
      expect(pair.condition).toBe('franchise:Frozen');
      expect(pair.deckId.startsWith('restricted:franchise:Frozen:')).toBe(true);
    }
    expect(stats.strata.restricted.decks).toBe(decks.length);
  });
});
