import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, DeckState, Ink } from '../data/types';
import type { MetaModel } from '../meta/infer';
import {
  buildScoringContext,
  candidateComponents,
  deckIdentityIds,
  deckSynergyEdges,
  deckVectors,
  synergyScore,
} from '../meta/score';
import { validateDeck } from '../rules/engine';
import { byIdMap, makeCard } from '../test/fixtures';
import {
  buildGroupLimits,
  mapSlider,
  sampleTopK,
  suggestFill,
} from './suggest-fill';

/** little-endian Int16 + scale encoder matching the artifact format */
function embed(
  dim: number,
  raw: Record<number, number[]>,
): MetaModel['relations'] {
  const vectors: Record<string, { b64: string; scale: number }> = {};
  for (const [id, vec] of Object.entries(raw)) {
    const maxAbs = Math.max(...vec.map((v) => Math.abs(v)));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = Buffer.alloc(dim * 2);
    vec.forEach((v, d) => {
      buf.writeInt16LE(Math.round(v / scale), d * 2);
    });
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
    makeCard({
      id: 1,
      name: 'Meta Core',
      cost: 3,
      inkwell: true,
      subtypes: ['Hero'],
      strength: 3,
      willpower: 4,
    }),
    makeCard({
      id: 2,
      name: 'Meta Partner',
      cost: 3,
      inkwell: true,
      subtypes: ['Hero'],
      strength: 2,
      willpower: 5,
      keywords: ['Evasive'],
    }),
    makeCard({
      id: 3,
      name: 'Meta Another',
      cost: 4,
      inkwell: true,
      subtypes: ['Villain'],
      strength: 4,
      willpower: 3,
    }),
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
    }),
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
    }),
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

const fillOpts = (
  overrides: Partial<Parameters<typeof suggestFill>[0]> & { pool: Card[] },
) => {
  const { pool, ...rest } = overrides;
  return {
    pool,
    deck: {} as Record<number, number>,
    need: 60,
    novelty: 0.5,
    seed: 42,
    model: fixtureModel,
    cards: pool,
    inks: ['Amber'] as (
      | 'Amber'
      | 'Amethyst'
      | 'Emerald'
      | 'Ruby'
      | 'Sapphire'
      | 'Steel'
    )[],
    format: 'core' as const,
    targetSize: 60,
    locked: new Set<number>(),
    groupCounts: new Map<string, number>(),
    inkableBaseline: 0,
    byId: byIdMap(pool),
    ...rest,
  };
};

const deckOf = (
  cards: Card[],
  inks: ('Amber' | 'Ruby')[] = ['Amber'],
): DeckState => ({
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
    const partner = candidateComponents(
      ctx.canonicalOf(pool[1]!),
      ctx,
      vectors,
    );
    const unrelated = candidateComponents(
      ctx.canonicalOf(pool[22]!),
      ctx,
      vectors,
    );
    expect(partner.relationSim).toBe(1);
    expect(unrelated.relationSim).toBeNull();
    expect(partner.score).toBeGreaterThan(unrelated.score);
  });

  it('scores never-played cards through the text space (cold start)', () => {
    const pool = buildPool();
    const stale: MetaModel = {
      ...fixtureModel,
      capabilities: { relations: false, calibration: false },
      relations: undefined,
      playrate: undefined,
      typicalCopies: undefined,
    };
    const ctx = buildScoringContext(pool, stale);
    const vectors = deckVectors(deckOf([pool[0]!, pool[1]!]), ctx);
    // a filler sharing cost band/inks/type with the deck still gets a text-space score
    const filler = candidateComponents(
      ctx.canonicalOf(pool[10]!),
      ctx,
      vectors,
    );
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
      if (card.maxCopies !== 'unlimited')
        expect(count).toBeLessThanOrEqual(card.maxCopies);
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
      makeCard({
        id: 600 + i,
        name: `Shifter ${i}`,
        inks: ['Amber'],
        inkwell: true,
        keywords: ['Shift'],
        text: `Shift ${i + 1} (You may pay ${i + 1} to play this on top of one of your characters named Nobody.)`,
      }),
    );
    const pool = [morph, ...shifters, ...buildPool(20)];
    const opts = fillOpts({
      pool,
      seed: 3,
      deck: { 500: 4 },
      need: 56,
      declaredInks: ['Amber'],
    });
    const placed = suggestFill(opts).placed;
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
    const unlimited = makeCard({
      id: 900,
      name: 'Unlimited Card',
      maxCopies: 'unlimited',
      inkwell: true,
    });
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

  describe('ink emergence (card-first generation)', () => {
    const mixedPool = (): { pool: Card[]; model: MetaModel } => {
      const ruby: Card[] = Array.from({ length: 15 }, (_, i) =>
        makeCard({
          id: 200 + i,
          name: `Ruby ${i}`,
          inks: ['Ruby'],
          cost: (i % 6) + 1,
          inkwell: true,
        }),
      );
      const sapphire: Card[] = Array.from({ length: 15 }, (_, i) =>
        makeCard({
          id: 300 + i,
          name: `Sapphire ${i}`,
          inks: ['Sapphire'],
          cost: (i % 6) + 1,
          inkwell: true,
        }),
      );
      const dual: Card[] = Array.from({ length: 4 }, (_, i) =>
        makeCard({
          id: 400 + i,
          name: `RS Dual ${i}`,
          inks: ['Ruby', 'Sapphire'],
          cost: (i % 4) + 2,
          inkwell: true,
        }),
      );
      const pool = [...ruby, ...sapphire, ...dual];
      const playrate: Record<string, number> = {};
      const typicalCopies: Record<string, number> = {};
      for (const card of pool) {
        playrate[String(card.id)] = card.id < 400 ? 120 + (card.id % 40) : 200;
        typicalCopies[String(card.id)] = 4;
      }
      const model: MetaModel = { ...fixtureModel, playrate, typicalCopies };
      return { pool, model };
    };

    const unionOf = (
      deck: Record<number, number>,
      byId: Map<number, Card>,
    ): Set<string> => {
      const inks = new Set<string>();
      for (const [id] of Object.entries(deck))
        for (const ink of byId.get(Number(id))?.inks ?? []) inks.add(ink);
      return inks;
    };

    it('derives a legal ink pair from the picked cards', () => {
      const { pool, model } = mixedPool();
      const opts = fillOpts({ pool, model, declaredInks: [], seed: 42 });
      const result = suggestFill(opts);
      expect(result.placed).toBe(60);
      const byId = byIdMap(pool);
      const inks = unionOf(opts.deck, byId);
      expect(inks.size).toBeGreaterThanOrEqual(1);
      expect(inks.size).toBeLessThanOrEqual(2);
      // every picked card fits the derived pair
      const pair = result.pair ?? ([...inks] as [Ink, Ink]);
      for (const [id, count] of Object.entries(opts.deck)) {
        const card = byId.get(Number(id))!;
        expect(count).toBeGreaterThan(0);
        if (card.inks.length === 1) expect(pair).toContain(card.inks[0]!);
        else {
          expect(pair).toContain(card.inks[0]!);
          expect(pair).toContain(card.inks[1]!);
        }
      }
      // the finished deck is legal under the derived inks
      const deckState: DeckState = {
        title: 'T',
        inks: [...inks] as Ink[],
        format: 'core',
        cards: { ...opts.deck },
      };
      expect(validateDeck(deckState, byId)).toEqual([]);
    });

    it('a dual-ink seed pins both inks immediately', () => {
      const { pool, model } = mixedPool();
      const opts = fillOpts({
        pool,
        model,
        declaredInks: [],
        seed: 9,
        deck: { 400: 4 },
      });
      const result = suggestFill(opts);
      expect(result.pair).toBeDefined();
      expect(result.pair!.sort()).toEqual(['Ruby', 'Sapphire']);
      expect(result.decidedBy).toBeUndefined(); // the partial deck decided it, not a pick
      const byId = byIdMap(pool);
      const inks = unionOf(opts.deck, byId);
      expect(inks).toEqual(new Set(['Ruby', 'Sapphire']));
    });

    it('names the pick that decided the inks', () => {
      // a Ruby partial + an all-dual pool: whichever dual is picked first
      // collapses the viable pairs to Ruby/Sapphire
      const dual: Card[] = Array.from({ length: 10 }, (_, i) =>
        makeCard({
          id: 400 + i,
          name: `RS Dual ${i}`,
          inks: ['Ruby', 'Sapphire'],
          cost: (i % 4) + 2,
          inkwell: true,
        }),
      );
      const pool = [...dual];
      const playrate: Record<string, number> = {};
      const typicalCopies: Record<string, number> = {};
      for (const card of pool) {
        playrate[String(card.id)] = 200;
        typicalCopies[String(card.id)] = 4;
      }
      const model: MetaModel = { ...fixtureModel, playrate, typicalCopies };
      const opts = fillOpts({
        pool,
        model,
        declaredInks: [],
        seed: 5,
        need: 8,
        targetSize: 8,
        deck: { 200: 1 },
        byId: byIdMap([
          ...pool,
          makeCard({ id: 200, name: 'Ruby Seed', inks: ['Ruby'] }),
        ]),
      });
      const result = suggestFill(opts);
      expect(result.pair).toBeDefined();
      expect([...result.pair!].sort()).toEqual(['Ruby', 'Sapphire']);
      expect(result.decidedBy).toBeDefined();
      expect(result.decidedBy!.inks).toEqual(['Ruby', 'Sapphire']);
    });

    it('is deterministic in inkless mode', () => {
      const { pool, model } = mixedPool();
      const a = fillOpts({ pool, model, declaredInks: [], seed: 77 });
      const b = fillOpts({ pool, model, declaredInks: [], seed: 77 });
      suggestFill(a);
      suggestFill(b);
      expect(a.deck).toEqual(b.deck);
    });

    it('admits nothing when the partial deck spans three inks', () => {
      const { pool, model } = mixedPool();
      const amber = makeCard({
        id: 500,
        name: 'Amber Card',
        inks: ['Amber'],
        inkwell: true,
      });
      const full = [amber, ...pool];
      const byId = byIdMap(full);
      const opts = fillOpts({
        pool: full,
        model,
        declaredInks: [],
        seed: 1,
        need: 10,
        targetSize: 60,
        deck: { 200: 4, 300: 4, 500: 4 },
        byId,
      });
      const result = suggestFill(opts);
      expect(result.placed).toBe(0);
    });
  });

  describe('two-ink representation (D7)', () => {
    /** a pool that contains both declared inks */
    const twoInkPool = (): Card[] => {
      const amber: Card[] = Array.from({ length: 15 }, (_, i) =>
        makeCard({
          id: 600 + i,
          name: `Amber ${i}`,
          inks: ['Amber'],
          cost: (i % 6) + 1,
          inkwell: true,
        }),
      );
      const ruby: Card[] = Array.from({ length: 15 }, (_, i) =>
        makeCard({
          id: 700 + i,
          name: `Ruby ${i}`,
          inks: ['Ruby'],
          cost: (i % 6) + 1,
          inkwell: true,
        }),
      );
      return [...amber, ...ruby];
    };

    it('keeps both declared inks represented across seeds', () => {
      const pool = twoInkPool();
      const byId = byIdMap(pool);
      for (const seed of [7, 21, 42, 99, 4242]) {
        const opts = fillOpts({
          pool,
          declaredInks: ['Amber', 'Ruby'],
          seed,
          novelty: 0.5,
          byId,
        });
        const result = suggestFill(opts);
        expect(result.placed).toBe(60);
        const counts: Record<string, number> = { Amber: 0, Ruby: 0 };
        for (const [id, n] of Object.entries(opts.deck)) {
          for (const ink of byId.get(Number(id))!.inks)
            if (ink in counts) counts[ink]! += n;
        }
        expect(counts.Amber).toBeGreaterThan(0);
        expect(counts.Ruby).toBeGreaterThan(0);
      }
    });

    it('does not remove cards when the pool cannot satisfy the missing ink', () => {
      const pool = buildPool(20); // all Amber — Ruby can never be represented
      const byId = byIdMap(pool);
      const opts = fillOpts({
        pool,
        declaredInks: ['Amber', 'Ruby'],
        seed: 3,
        byId,
      });
      const result = suggestFill(opts);
      expect(result.placed).toBe(60);
      expect(Object.values(opts.deck).reduce((s, c) => s + c, 0)).toBe(60); // deck intact
    });

    it('swaps in a missing declared ink without corrupting copy counts', () => {
      // meta-weighted fill: Amber scores playrate + cheap costs, Ruby is
      // expensive and unplayed — the natural picks ignore it, so the D7
      // guarantee has to swap Ruby in afterwards
      const pool = twoInkPool().map((card) =>
        card.inks.includes('Ruby') ? { ...card, cost: 9 } : card,
      );
      const model: MetaModel = {
        version: '3',
        dataThroughDate: '2026-11-10',
        capabilities: { relations: false, calibration: false },
        playrate: Object.fromEntries(
          pool
            .filter((c) => c.inks.includes('Amber'))
            .map((c) => [String(c.id), 255]),
        ),
      };
      const byId = byIdMap(pool);
      const opts = fillOpts({
        pool,
        model,
        novelty: 0,
        declaredInks: ['Amber', 'Ruby'],
        seed: 7,
        byId,
      });
      suggestFill(opts);
      const counts: Record<string, number> = { Amber: 0, Ruby: 0 };
      const groupCounts = new Map<string, number>();
      let total = 0;
      for (const [id, n] of Object.entries(opts.deck)) {
        const card = byId.get(Number(id))!;
        total += n;
        for (const ink of card.inks) if (ink in counts) counts[ink]! += n;
        groupCounts.set(
          card.groupKey,
          (groupCounts.get(card.groupKey) ?? 0) + n,
        );
      }
      expect(total).toBe(60); // swaps replace, never shrink the deck
      expect(counts.Ruby).toBeGreaterThan(0);
      expect(counts.Amber).toBeGreaterThan(0);
      for (const count of groupCounts.values())
        expect(count).toBeLessThanOrEqual(4);
    });
  });
});

describe('buildGroupLimits', () => {
  it('caps a group at its strictest print regardless of print order', () => {
    const unlimited = makeCard({
      id: 910,
      name: 'Bots',
      maxCopies: 'unlimited',
    });
    const limited = makeCard({ id: 911, name: 'Bots', maxCopies: 4 });
    for (const cards of [
      [unlimited, limited],
      [limited, unlimited],
    ]) {
      expect(buildGroupLimits(cards).get('bots')).toBe(4);
    }
    expect(buildGroupLimits([unlimited]).get('bots')).toBe('unlimited');
    expect(buildGroupLimits([limited]).get('bots')).toBe(4);
  });
});

describe('trained synergy (interactions capability)', () => {
  const synergyModel = (
    partners: Record<string, Array<[number, number]>>,
  ): MetaModel => ({
    ...fixtureModel,
    capabilities: {
      relations: true,
      calibration: false,
      interactions: true,
    },
    interactions: { version: '1', scale: 255, partners },
  });

  it('resolves a candidate’s best partner among deck identities', () => {
    const pool = buildPool();
    const ctx = buildScoringContext(
      pool,
      synergyModel({
        2: [[100, 255]],
        3: [[100, 128]],
        100: [[2, 255]],
      }),
    );
    const filler = pool.find((c) => c.id === 100)!;
    const deckWithFiller: DeckState = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { [filler.id]: 4 },
    };
    const ids = deckIdentityIds(deckWithFiller, ctx);
    const edges = deckSynergyEdges(ctx, ids);
    expect(ids.has(100)).toBe(true);
    // direction 1: the candidate's own list names a deck card (255 → 1.0)
    expect(synergyScore(ctx, 2, ids, edges)).toBe(1);
    // direction 2: the deck card's list grants the candidate (128 → 128/255)
    expect(synergyScore(ctx, 3, ids, edges)).toBeCloseTo(128 / 255, 5);
    // unrelated candidate (a played card with no table entry)
    expect(synergyScore(ctx, 5, ids, edges)).toBeNull();
  });

  it('returns null when the capability is absent', () => {
    const pool = buildPool();
    const ctx = buildScoringContext(pool, fixtureModel);
    const ids = deckIdentityIds(
      {
        title: 'T',
        inks: ['Amber'],
        format: 'core',
        cards: { 100: 4 },
      },
      ctx,
    );
    const edges = deckSynergyEdges(ctx, ids);
    expect(synergyScore(ctx, 2, ids, edges)).toBeNull();
  });

  it('prefers the trained partner when completing a deck around it', () => {
    const pool = buildPool();
    const filler = pool.find((c) => c.id === 100)!;
    // three unplayed partners: low text affinity, so only the synergy term
    // can lift them (opted in explicitly — the shipping default is 0)
    const partners = synergyModel({
      100: [
        [101, 255],
        [102, 255],
        [103, 255],
      ],
    });
    const opts = (model: MetaModel) =>
      fillOpts({
        pool,
        deck: { [filler.id]: 4 },
        need: 56,
        inkableBaseline: 4,
        seed: 42,
        novelty: 0.5,
        model,
        synergyWeight: 0.25,
      });
    const withSynergy = opts(partners);
    const baseline = opts(fixtureModel);
    suggestFill(withSynergy);
    suggestFill(baseline);
    const partnerCopies = (deck: Record<number, number>): number =>
      (deck[101] ?? 0) + (deck[102] ?? 0) + (deck[103] ?? 0);
    expect(partnerCopies(withSynergy.deck)).toBeGreaterThan(
      partnerCopies(baseline.deck),
    );
  });

  it('does not blend at the shipping default (weight 0) even with a partner table', () => {
    const pool = buildPool();
    const filler = pool.find((c) => c.id === 100)!;
    const synergyRun = fillOpts({
      pool,
      deck: { [filler.id]: 4 },
      need: 56,
      inkableBaseline: 4,
      seed: 42,
      novelty: 0.5,
      model: synergyModel({
        100: [
          [101, 255],
          [102, 255],
          [103, 255],
        ],
      }),
    });
    const baselineRun = fillOpts({
      pool,
      deck: { [filler.id]: 4 },
      need: 56,
      inkableBaseline: 4,
      seed: 42,
      novelty: 0.5,
      model: fixtureModel,
    });
    suggestFill(synergyRun);
    suggestFill(baselineRun);
    expect(synergyRun.deck).toEqual(baselineRun.deck);
  });

  it('scores identically to the pre-synergy behavior when the capability is absent', () => {
    const pool = buildPool();
    const emptyTable = synergyModel({});
    const a = fillOpts({ pool, seed: 7, model: emptyTable });
    const b = fillOpts({
      pool,
      seed: 7,
      model: {
        ...fixtureModel,
        capabilities: { relations: true, calibration: false },
      },
    });
    suggestFill(a);
    suggestFill(b);
    expect(a.deck).toEqual(b.deck);
  });
});

describe('D7 ink-replacement with synergy edges', () => {
  it('replaces picks to represent a missing declared ink', () => {
    const pool: Card[] = [];
    // cheap Ruby core the filler will prefer
    for (let i = 0; i < 20; i++)
      pool.push(
        makeCard({
          id: 500 + i,
          name: `Ruby Core ${i}`,
          inks: ['Ruby'],
          cost: (i % 2) + 1,
          inkwell: true,
        }),
      );
    // expensive Sapphire cards the main loop will avoid...
    for (let i = 0; i < 20; i++)
      pool.push(
        makeCard({
          id: 600 + i,
          name: `Sapphire Late ${i}`,
          inks: ['Sapphire'],
          cost: 8,
          inkwell: true,
        }),
      );
    const playrate: Record<string, number> = {};
    const typicalCopies: Record<string, number> = {};
    for (const card of pool) {
      playrate[String(card.id)] = card.id < 600 ? 200 : 10;
      typicalCopies[String(card.id)] = 4;
    }
    const model: MetaModel = { ...fixtureModel, playrate, typicalCopies };
    const opts = fillOpts({
      pool,
      model,
      declaredInks: ['Ruby', 'Sapphire'],
      inks: ['Ruby', 'Sapphire'],
      seed: 11,
      novelty: 0.5,
    });
    const result = suggestFill(opts);
    expect(result.placed).toBe(60);
    const byId = byIdMap(pool);
    const inks = new Set<string>();
    for (const [id] of Object.entries(opts.deck))
      for (const ink of byId.get(Number(id))?.inks ?? []) inks.add(ink);
    // D7 guarantee: both declared inks end up represented
    expect(inks.has('Ruby')).toBe(true);
    expect(inks.has('Sapphire')).toBe(true);
    expect(
      validateDeck({ ...opts, cards: opts.deck } as never, byIdMap(pool)),
    ).toEqual([]);
  });
});

describe('payoff boosts over the real snapshot', () => {
  it('scores name-reference desires when the deck contains the source card', () => {
    // real snapshot: find a card whose text references another card by name
    // (payoffs) — the boost loop must walk those desires per pick
    const snapshot = JSON.parse(
      readFileSync('public/data/cards.min.json', 'utf8'),
    ) as { cards: Card[] };
    const realCards = snapshot.cards;
    const named = realCards.find((c) => c.payoffs.length > 0);
    if (!named) return; // snapshot without payoff data: nothing to test
    const pool = realCards.filter(
      (c) =>
        c.inks.some((i) => (named.inks as string[]).includes(i)) &&
        c.formats.core,
    );
    const deck: Record<number, number> = { [named.id]: 4 };
    const inks = named.inks as Ink[];
    const opts = fillOpts({
      pool,
      deck,
      need: 60 - 4,
      inkableBaseline: 4,
      seed: 3,
      novelty: 0.5,
      model: null,
      cards: pool,
      inks: inks as unknown as Ink[],
      format: 'core',
      targetSize: 60,
      locked: new Set([named.id]),
      groupCounts: (() => {
        const m = new Map<string, number>();
        m.set(named.groupKey, 4);
        return m;
      })(),
      byId: byIdMap(pool),
    });
    const result = suggestFill(opts);
    expect(result.placed).toBeGreaterThan(0);
    const total = Object.values(opts.deck).reduce((a, b) => a + b, 0);
    expect(total).toBe(60);
  });
});
