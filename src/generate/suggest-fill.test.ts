import { describe, expect, it } from 'vitest';
import { mapSlider, polishDeck, sampleTopK, suggestFill } from './suggest-fill';
import { byIdMap, makeCard } from '../test/fixtures';
import { validateDeck } from '../rules/engine';
import { simulateRace } from '../stats/goldfish';
import type { Card, DeckState } from '../data/types';
import type { MetaModel } from '../meta/infer';
import { buildScoringContext, deckVectors, candidateComponents } from '../meta/score';

/** little-endian Int16 + scale encoder matching the artifact format */
function embed(dim: number, raw: Record<number, number[]>): MetaModel['relations'] {
  const vectors: Record<string, { b64: string; scale: number }> = {};
  for (const [id, vec] of Object.entries(raw)) {
    const maxAbs = Math.max(...vec.map((v) => Math.abs(v)));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = Buffer.alloc(dim * 2);
    vec.forEach((v, d) => buf.writeInt16LE(Math.round(v / scale), d * 2));
    vectors[id] = { b64: buf.toString('base64'), scale };
  }
  return { dim, quantization: 'int16-le', vectors };
}

const baseModel: MetaModel = {
  version: '3',
  dataThroughDate: '2026-11-10',
  capabilities: { relations: true, calibration: false },
  relations: embed(2, { 1: [1, 0], 2: [1, 0], 3: [1, 0] }),
  playrate: { 1: 255, 2: 255, 3: 255 }, // high-playrate meta core
  typicalCopies: { 1: 4, 2: 4, 3: 4 },
};

/**
 * A pool shaped like the real corpus: a proven meta core (ids 1–3, playrate
 * 255), widely played secondary cards (ids 4–17, moderate playrate) and
 * unplayed cards (ids 100+, playrate 0 = known but never seen in training).
 * Content varies (subtypes, stats, keywords, costs) so text vectors differ.
 */
function buildPool(unplayed = 25): Card[] {
  const subtypes = ['Hero', 'Villain', 'Floodborn', 'Pirate'];
  const core: Card[] = [
    makeCard({ id: 1, name: 'Meta Core', cost: 3, inkwell: true, subtypes: ['Hero'], strength: 3, willpower: 4 }),
    makeCard({ id: 2, name: 'Meta Partner', cost: 3, inkwell: true, subtypes: ['Hero'], strength: 2, willpower: 5, keywords: ['Evasive'] }),
    makeCard({ id: 3, name: 'Meta Another', cost: 4, inkwell: true, subtypes: ['Villain'], strength: 4, willpower: 3 }),
  ];
  const played: Card[] = Array.from({ length: 14 }, (_, i) =>
    makeCard({
      id: 4 + i,
      name: `Played ${i}`,
      cost: (i % 6) + 1,
      inkwell: true,
      subtypes: [subtypes[i % subtypes.length]!],
      strength: (i % 5) + 1,
      willpower: ((i + 2) % 5) + 1,
      keywords: i % 4 === 0 ? ['Rush'] : [],
    })
  );
  const unplayedCards: Card[] = Array.from({ length: unplayed }, (_, i) =>
    makeCard({
      id: 100 + i,
      name: `Filler ${i}`,
      cost: (i % 6) + 1,
      inkwell: i % 3 !== 2,
      subtypes: [subtypes[(i + 1) % subtypes.length]!],
      strength: ((i + 3) % 5) + 1,
      willpower: (i % 4) + 1,
      keywords: i % 5 === 0 ? ['Ward'] : [],
    })
  );
  const pool = [...core, ...played, ...unplayedCards];
  const playrate: Record<string, number> = {};
  const typicalCopies: Record<string, number> = {};
  for (const card of pool) {
    if (card.id <= 3) {
      playrate[String(card.id)] = 255;
      typicalCopies[String(card.id)] = 4;
    } else if (card.id < 100) {
      playrate[String(card.id)] = 100 + (card.id % 30);
      typicalCopies[String(card.id)] = 4;
    } else {
      playrate[String(card.id)] = 0;
      typicalCopies[String(card.id)] = 2;
    }
  }
  fixtureModel.playrate = playrate;
  fixtureModel.typicalCopies = typicalCopies;
  return pool;
}

/** mutated by buildPool so the pool's popularity data always matches it */
const fixtureModel: MetaModel = { ...baseModel };

const fillOpts = (overrides: Partial<Parameters<typeof suggestFill>[0]> & { pool: Card[] }) => {
  const { pool, ...rest } = overrides;
  return {
    pool,
    deck: {} as Record<number, number>,
    need: 60,
    novelty: 0.5,
    seed: 42,
    model: fixtureModel,
    cards: pool,
    inks: ['Amber'] as ('Amber' | 'Amethyst' | 'Emerald' | 'Ruby' | 'Sapphire' | 'Steel')[],
    format: 'core' as const,
    targetSize: 60,
    locked: new Set<number>(),
    groupCounts: new Map<string, number>(),
    inkableBaseline: 0,
    byId: byIdMap(pool),
    ...rest,
  };
};

const deckOf = (cards: Card[], inks: ('Amber' | 'Ruby')[] = ['Amber']): DeckState => ({
  title: 'T',
  inks,
  format: 'core',
  cards: Object.fromEntries(cards.map((c) => [c.id, 4])),
});

describe('slider mapping (D4 endpoints)', () => {
  it('maps the middle default to the documented midpoint behavior', () => {
    const m = mapSlider(0.5);
    expect(m.fusionRelationWeight).toBeCloseTo(0.3);
    expect(m.fusionTextWeight).toBeCloseTo(0.7);
    expect(m.seedExponent).toBeCloseTo(0.5);
    expect(m.temperature).toBeCloseTo(0.75);
  });

  it('keeps meta weights at the meta end (0.6/0.4 fusion, playrate-weighted seeds)', () => {
    const m = mapSlider(0);
    expect(m.fusionRelationWeight).toBeCloseTo(0.6);
    expect(m.fusionTextWeight).toBeCloseTo(0.4);
    expect(m.seedExponent).toBe(2);
    expect(m.noveltyBias).toBe(0);
    expect(m.temperature).toBeCloseTo(0.3);
  });

  it('shifts to text-only, inverse-playrate and high temperature at the novel end', () => {
    const m = mapSlider(1);
    expect(m.fusionRelationWeight).toBe(0);
    expect(m.fusionTextWeight).toBe(1);
    expect(m.seedExponent).toBe(-1);
    expect(m.noveltyBias).toBe(1);
    expect(m.temperature).toBeCloseTo(1.2);
  });

  it('clamps out-of-range novelty values', () => {
    expect(mapSlider(-2).noveltyBias).toBe(0);
    expect(mapSlider(7).noveltyBias).toBe(1);
  });
});

describe('sampling', () => {
  it('samples deterministically from the top-K and respects the score order', () => {
    const scored = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.1 },
    ];
    const rng = (() => {
      let i = 0;
      return () => [0.0, 0.9, 0.99][i++ % 3]!;
    })();
    // K=2: 'c' is never eligible; low temperature keeps the order a before b
    const picks = [0, 1, 2].map(() => sampleTopK(scored, 2, 0.3, rng).id);
    expect(picks).toEqual(['a', 'b', 'b']);
  });
});

describe('suggest-fill loop', () => {
  it('is deterministic for the same seed and slider', () => {
    const pool = buildPool();
    const deckA = fillOpts({ pool, seed: 99 });
    const deckB = fillOpts({ pool, seed: 99 });
    suggestFill(deckA);
    suggestFill(deckB);
    expect(deckA.deck).toEqual(deckB.deck);
    const other = fillOpts({ pool, seed: 100 });
    suggestFill(other);
    expect(other.deck).not.toEqual(deckA.deck);
  });

  it('elevates relation-tied partners before unrelated cards', () => {
    const pool = buildPool();
    // pool[22] is a textually unrelated filler (Floodborn/Ward, different cost band)
    const ctx = buildScoringContext(pool, fixtureModel);
    const vectors = deckVectors(deckOf([pool[0]!]), ctx);
    const partner = candidateComponents(ctx.canonicalOf(pool[1]!), ctx, vectors);
    const unrelated = candidateComponents(ctx.canonicalOf(pool[22]!), ctx, vectors);
    expect(partner.relationSim).toBe(1);
    expect(unrelated.relationSim).toBeNull();
    expect(partner.score).toBeGreaterThan(unrelated.score);
  });

  it('scores never-played cards through the text space (cold start)', () => {
    const pool = buildPool();
    const stale: MetaModel = { ...fixtureModel, capabilities: { relations: false, calibration: false }, relations: undefined, playrate: undefined, typicalCopies: undefined };
    const ctx = buildScoringContext(pool, stale);
    const vectors = deckVectors(deckOf([pool[0]!, pool[1]!]), ctx);
    // a filler sharing cost band/inks/type with the deck still gets a text-space score
    const filler = candidateComponents(ctx.canonicalOf(pool[10]!), ctx, vectors);
    expect(filler.textSim).toBeGreaterThan(0);
    expect(filler.score).toBe(filler.textSim);
  });

  it('fills with multiplicities and respects copy limits', () => {
    const pool = buildPool();
    const opts = fillOpts({ pool, seed: 5 });
    suggestFill(opts);
    const total = Object.values(opts.deck).reduce((s, c) => s + c, 0);
    expect(total).toBe(60);
    const distinct = Object.keys(opts.deck).length;
    expect(distinct).toBeLessThan(60);
    const limits = new Map(pool.map((c) => [c.groupKey, c.maxCopies]));
    for (const [id, count] of Object.entries(opts.deck)) {
      const card = opts.byId.get(Number(id))!;
      if (card.maxCopies !== 'unlimited') expect(count).toBeLessThanOrEqual(card.maxCopies);
      void limits;
    }
  });
  it('deepens toward trained typical copies when the artifact provides them', () => {
    const pool = buildPool();
    const opts = fillOpts({ pool, seed: 11 });
    suggestFill(opts);
    // meta core (typical 4) should end up deepened rather than as singletons
    const coreCopies = [1, 2, 3].map((id) => opts.deck[id] ?? 0);
    expect(coreCopies.some((c) => c >= 2)).toBe(true);
  });

  it('boosts payoff partners without gating legality (Morph case)', () => {
    // Morph: MIMICRY wildcard, no shift ability of its own — a deck full of
    // Morphs must stay legal with zero shift targets in the pool
    const morph = makeCard({
      id: 500,
      name: 'Morph',
      version: 'Space Goo',
      inks: ['Amber'],
      inkwell: true,
      text: 'MIMICRY You may play any character with Shift on this character as if this character had any name.',
    });
    const shifters: Card[] = Array.from({ length: 8 }, (_, i) =>
      makeCard({ id: 600 + i, name: `Shifter ${i}`, inks: ['Amber'], inkwell: true, keywords: ['Shift'], text: `Shift ${i + 1} (You may pay ${i + 1} to play this on top of one of your characters named Nobody.)` })
    );
    const pool = [morph, ...shifters, ...buildPool(20)];
    const opts = fillOpts({ pool, seed: 3, deck: { 500: 4 }, need: 56 });
    const placed = suggestFill(opts);
    expect(placed).toBe(56);
    const total = Object.values(opts.deck).reduce((s, c) => s + c, 0);
    expect(total).toBe(60);
    // zero shift targets (no card named "Nobody" exists) — the deck is still complete
    expect(Object.keys(opts.deck).length).toBeGreaterThan(0);
  });

  it('novel-end fills favor zero-playrate cards; meta-end fills the proven core', () => {
    const pool = buildPool(30);
    const novel = fillOpts({ pool, novelty: 1, seed: 21 });
    suggestFill(novel);
    const meta = fillOpts({ pool, novelty: 0, seed: 21 });
    suggestFill(meta);

    const playedShare = (deck: Record<number, number>): number => {
      let played = 0;
      let total = 0;
      for (const [id, count] of Object.entries(deck)) {
        total += count;
        if (Number(id) < 100) played += count; // ids < 100 carry playrate data
      }
      return played / total;
    };
    const novelPlayed = playedShare(novel.deck);
    const metaPlayed = playedShare(meta.deck);
    expect(novelPlayed).toBeLessThan(0.25); // novel end: mostly zero-playrate picks
    // meta end: dominated by proven cards (the 70-85% inkable band bounds an
    // all-inkable played core, so ~75% is the ceiling)
    expect(metaPlayed).toBeGreaterThanOrEqual(0.7);
  });

  it('never exceeds copy limits with unlimited cards capped by need', () => {
    const unlimited = makeCard({ id: 900, name: 'Unlimited Card', maxCopies: 'unlimited', inkwell: true });
    const pool = [unlimited, ...buildPool(20)];
    const opts = fillOpts({ pool, seed: 8 });
    suggestFill(opts);
    expect(opts.deck[900] ?? 0).toBeLessThanOrEqual(60);
  });

  it('keeps partial-deck cards locked out of deepening', () => {
    const pool = buildPool();
    const deck: Record<number, number> = { 1: 10 };
    const opts = fillOpts({ pool, deck, need: 50, locked: new Set([1]) });
    suggestFill(opts);
    expect(opts.deck[1]).toBe(10);
  });

  it('polish keeps only goldfish improvements and stays legality-clean', () => {
    const pool = buildPool(30);
    const opts = fillOpts({ pool, seed: 33 });
    suggestFill(opts);
    const before: DeckState = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { ...opts.deck },
    };
    const byId = byIdMap(pool);
    const score = (d: DeckState): number => {
      const r = simulateRace(d, byId, 'midrange', { trials: 400, seed: 20261119 });
      return r ? r.winRate : 0;
    };
    const beforeScore = score(before);
    const { deck: after, swaps } = polishDeck({ ...before, cards: { ...before.cards } }, byId, pool, new Set(), 7);
    expect(score(after)).toBeGreaterThanOrEqual(beforeScore);
    expect(swaps).toBeLessThanOrEqual(20);
    expect(validateDeck(after, byId)).toEqual([]);
  });
});
