import { describe, expect, it } from 'vitest';
import type { Card, Ink } from '../../../src/data/types';
import { INKS } from '../../../src/data/types';
import { canAddCard } from '../../../src/rules/engine';
import { mulberry32 } from '../prng';
import type { Corpus, MaskedElitesPair } from './corpus';
import { cardFeatures, FEATURE_DIM } from './features';
import {
  buildDeltaExample,
  buildImitationExample,
  createModel,
  DEFAULT_NEGATIVES_PER_PAIR,
  dequantizeModel,
  ENCODER_HIDDEN,
  type ExampleContext,
  examplesFromCorpus,
  PARAM_COUNT,
  pairLoss,
  pairLossAndGradients,
  quantizeModel,
  type SeedCard,
  sampleNegatives,
  scoreCandidates,
  seedInkState,
  TENSOR_SHAPES,
  type TrainingPair,
  trainModel,
} from './model';

/** minimal fixture card (features.test.ts pattern) */
function makeCard(overrides: Partial<Card> & Pick<Card, 'id' | 'name'>): Card {
  return {
    fullName: overrides.name,
    groupKey: overrides.name.toLowerCase(),
    inks: ['ruby'],
    isDualInk: false,
    cost: 1,
    inkwell: true,
    type: 'Character',
    subtypes: [],
    isSong: false,
    franchise: 'fixture',
    setCode: 'TST',
    setName: 'Fixture Set',
    setNumber: 1,
    setType: 'expansion',
    rarity: 'common',
    maxCopies: 4,
    text: '',
    keywords: [],
    tags: [],
    deckRuleEffects: [],
    payoffs: [],
    images: {},
    formats: { core: true, infinity: true },
    ...overrides,
  } as Card;
}

/** a small deterministic catalog spanning two inks */
function fixtureCatalog(): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < 12; i++) {
    cards.push(
      makeCard({
        id: 100 + i,
        name: `Ruby Fixture ${i}`,
        inks: ['Ruby'],
        cost: (i % 6) + 1,
      }),
    );
  }
  for (let i = 0; i < 6; i++) {
    cards.push(
      makeCard({
        id: 200 + i,
        name: `Sapphire Fixture ${i}`,
        inks: ['Sapphire'],
        cost: (i % 4) + 1,
      }),
    );
  }
  return cards;
}

function fixtureContext(cards: Card[]): ExampleContext {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const featuresById = new Map(
    cards.map((card) => [card.id, cardFeatures(card)]),
  );
  return {
    byId,
    featuresById,
    poolIds: cards.map((card) => card.id).sort((a, b) => a - b),
    format: 'core',
    negativesPerPair: DEFAULT_NEGATIVES_PER_PAIR,
  };
}

/** random feature vector with a controlled value at `dim` */
function noisyFeatures(
  dim: number,
  value: number,
  rng: () => number,
): Float64Array {
  const f = new Float64Array(FEATURE_DIM);
  for (let i = 0; i < FEATURE_DIM; i++) f[i] = rng();
  f[dim] = value;
  return f;
}

describe('architecture budget (D3)', () => {
  it('stays within the ~4k parameter budget', () => {
    expect(ENCODER_HIDDEN).toBeLessThanOrEqual(32);
    // encoder 24→32→16 + scorer [24⊕16]→16→1
    expect(PARAM_COUNT).toBe(2001);
    expect(PARAM_COUNT).toBeLessThanOrEqual(4000);
  });

  it('declares a quantized tensor shape for every parameter', () => {
    const total = Object.values(TENSOR_SHAPES)
      .map((shape) => shape.reduce((a, b) => a * b, 1))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(PARAM_COUNT);
    expect(Object.keys(TENSOR_SHAPES)).toHaveLength(8);
  });
});

describe('scoreCandidates (inference forward path)', () => {
  const model = createModel(7);
  const cards = fixtureCatalog();
  const ctx = fixtureContext(cards);

  it('returns one finite score per candidate, deterministically', () => {
    const seed: SeedCard[] = cards
      .slice(0, 5)
      .map((card) => ({ features: ctx.featuresById.get(card.id)!, count: 2 }));
    const candidates = cards
      .slice(5, 12)
      .map((card) => ctx.featuresById.get(card.id)!);
    const first = scoreCandidates(model, seed, candidates);
    const second = scoreCandidates(model, seed, candidates);
    expect(first).toHaveLength(candidates.length);
    expect([...first]).toEqual([...second]);
    for (const score of first) expect(Number.isFinite(score)).toBe(true);
  });

  it('is invariant to seed-card order up to float rounding', () => {
    const a: SeedCard[] = cards
      .slice(0, 3)
      .map((card) => ({ features: ctx.featuresById.get(card.id)!, count: 1 }));
    const candidates = cards
      .slice(8, 10)
      .map((card) => ctx.featuresById.get(card.id)!);
    const ordered = scoreCandidates(model, a, candidates);
    const reversed = scoreCandidates(model, [...a].reverse(), candidates);
    // masked-mean summation order shifts the last ulp only
    for (let i = 0; i < ordered.length; i++) {
      expect(ordered[i]).toBeCloseTo(reversed[i]!, 10);
    }
  });

  it('handles degenerate inputs without NaN', () => {
    const candidates = [ctx.featuresById.get(cards[0]!.id)!];
    expect(scoreCandidates(model, [], candidates)).toHaveLength(1);
    const seed: SeedCard[] = [
      { features: ctx.featuresById.get(cards[0]!.id)!, count: 1 },
    ];
    expect(scoreCandidates(model, seed, [])).toHaveLength(0);
  });
});

describe('training gradients', () => {
  it('matches finite differences across every weight group', () => {
    const rng = mulberry32(11);
    const model = createModel(3);
    const pair: TrainingPair = {
      seed: Array.from({ length: 6 }, () => ({
        features: noisyFeatures(0, rng(), rng),
        count: 1 + Math.floor(rng() * 3),
      })),
      candidateFeatures: Array.from({ length: 5 }, (_, j) =>
        noisyFeatures(1, j === 0 ? 1 : 0, rng),
      ),
      positiveIndices: [0],
    };
    const { grads } = pairLossAndGradients(model, pair);
    const coordinates: Array<{
      key:
        | 'encW1'
        | 'encB1'
        | 'encW2'
        | 'encB2'
        | 'scorerW1'
        | 'scorerB1'
        | 'scorerW2';
      index: number;
    }> = [
      { key: 'encW1', index: 0 },
      { key: 'encW1', index: model.encW1.length - 1 },
      { key: 'encB1', index: 0 },
      { key: 'encW2', index: 0 },
      { key: 'encW2', index: model.encW2.length - 1 },
      { key: 'encB2', index: 0 },
      { key: 'scorerW1', index: 0 },
      { key: 'scorerW1', index: model.scorerW1.length - 1 },
      { key: 'scorerB1', index: 0 },
      { key: 'scorerW2', index: 0 },
    ];
    const epsilon = 1e-6;
    for (const { key, index } of coordinates) {
      const flat = grads[key];
      const original = model[key][index]!;
      model[key][index] = original + epsilon;
      const up = pairLoss(model, pair);
      model[key][index] = original - epsilon;
      const down = pairLoss(model, pair);
      model[key][index] = original;
      const numerical = (up - down) / (2 * epsilon);
      const analytic = flat[index]!;
      // tolerance absorbs float cancellation in the central difference
      expect(Math.abs(numerical - analytic)).toBeLessThan(
        1e-3 + 0.02 * Math.abs(analytic),
      );
    }
    // scalar output bias
    const original = model.scorerB2;
    model.scorerB2 = original + epsilon;
    const up = pairLoss(model, pair);
    model.scorerB2 = original - epsilon;
    const down = pairLoss(model, pair);
    model.scorerB2 = original;
    expect(Math.abs((up - down) / (2 * epsilon) - grads.scorerB2)).toBeLessThan(
      1e-3,
    );
  });

  it('gives zero loss and zero gradient to a single-candidate pair', () => {
    const model = createModel(5);
    const pair: TrainingPair = {
      seed: [{ features: new Float64Array(FEATURE_DIM), count: 1 }],
      candidateFeatures: [new Float64Array(FEATURE_DIM)],
      positiveIndices: [0],
    };
    const { loss, grads } = pairLossAndGradients(model, pair);
    expect(loss).toBe(0);
    expect(grads.scorerW1.every((v) => v === 0)).toBe(true);
    expect(grads.encW1.every((v) => v === 0)).toBe(true);
  });
});

describe('trainModel (synthetic corpora)', () => {
  /**
   * Absolute rule: the positive's dim-0 feature is 1, negatives are 0.
   * Holdout pairs draw fresh cards, so above-chance accuracy can only come
   * from generalizing the scorer path (chance = 1/5).
   */
  function absoluteProblem(rng: () => number, groups: number): TrainingPair[] {
    return Array.from({ length: groups }, () => ({
      seed: Array.from({ length: 6 }, () => ({
        features: noisyFeatures(0, rng(), rng),
        count: 1 + Math.floor(rng() * 3),
      })),
      candidateFeatures: [
        noisyFeatures(0, 1, rng),
        ...Array.from({ length: 4 }, () => noisyFeatures(0, 0, rng)),
      ],
      positiveIndices: [0],
    }));
  }

  it('learns a single-feature rule to above-chance holdout accuracy', () => {
    const rng = mulberry32(42);
    const all = absoluteProblem(rng, 40);
    const holdout = all.slice(0, 8);
    const train = all.slice(8);
    const { model, evidence } = trainModel(train, holdout, {
      seed: 20261123,
      maxEpochs: 120,
      evalEvery: 5,
      patience: 6,
      lr: 0.5,
    });
    expect(evidence.holdoutAccuracy).toBeGreaterThan(0.8);
    expect(evidence.holdoutLoss).toBeLessThan(0.5);
    expect(evidence.epochsRun).toBeLessThanOrEqual(120);
    // the trained model ranks the held-out positive first
    const probe = holdout[0]!;
    const scores = scoreCandidates(model, probe.seed, probe.candidateFeatures);
    expect(probe.positiveIndices).toContain(
      scores.indexOf(Math.max(...scores)),
    );
  }, 10_000);

  /**
   * Context rule: the seed carries a binary mode t in dim 1 (the pool's only
   * signal) and t gates which candidate dimension is discriminative — t=1
   * makes dim 0 the signal, t=0 makes dim 1. A pool-only contribution cancels
   * in the per-pair softmax, so the rule is learnable only if pooled context
   * interacts with candidate features through the encoder. Holdout pairs draw
   * fresh cards (chance = 1/5). Noise dims sit at a reduced scale so the
   * 2-dim signal is not drowned at init; the rule trains to 1.0 holdout
   * accuracy across seeds.
   */
  function gatedProblem(rng: () => number, groups: number): TrainingPair[] {
    const noisy = (values: Record<number, number>): Float64Array => {
      const f = new Float64Array(FEATURE_DIM);
      for (let i = 0; i < FEATURE_DIM; i++) f[i] = rng() * 0.5;
      for (const [d, v] of Object.entries(values)) f[Number(d)] = v;
      return f;
    };
    return Array.from({ length: groups }, () => {
      const t = rng() < 0.5 ? 0 : 1;
      return {
        seed: Array.from({ length: 6 }, () => ({
          features: noisy({ 1: t }),
          count: 1 + Math.floor(rng() * 3),
        })),
        candidateFeatures: [
          t === 1 ? noisy({ 0: 1 }) : noisy({ 1: 1 }),
          t === 1 ? noisy({ 0: 0 }) : noisy({ 1: 0 }),
          noisy({}),
          noisy({}),
          noisy({}),
        ],
        positiveIndices: [0],
      };
    });
  }

  it('learns a context-gated rule through the encoder pool path', () => {
    const rng = mulberry32(77);
    const all = gatedProblem(rng, 120);
    const holdout = all.slice(0, 24);
    const train = all.slice(24);
    const { evidence } = trainModel(train, holdout, {
      seed: 20261123,
      maxEpochs: 400,
      evalEvery: 5,
      patience: 12,
      lr: 1.0,
    });
    expect(evidence.holdoutAccuracy).toBeGreaterThan(0.8); // chance = 0.2
    expect(evidence.trainAccuracy).toBeGreaterThan(0.95);
    // coverage-instrumented training: ~74 s on 2-core CI runners vs ~4 s bare
  }, 180_000);

  it('is deterministic for a fixed seed and diverges across seeds', () => {
    const rng = mulberry32(9);
    const all = absoluteProblem(rng, 16);
    const a = trainModel(all.slice(4), all.slice(0, 4), {
      seed: 1,
      maxEpochs: 20,
    });
    const b = trainModel(all.slice(4), all.slice(0, 4), {
      seed: 1,
      maxEpochs: 20,
    });
    const c = trainModel(all.slice(4), all.slice(0, 4), {
      seed: 2,
      maxEpochs: 20,
    });
    expect(a.model.encW1).toEqual(b.model.encW1);
    expect(a.model.scorerW1).toEqual(b.model.scorerW1);
    expect(a.evidence).toEqual(b.evidence);
    expect([...a.model.encW1]).not.toEqual([...c.model.encW1]);
  });

  it('early-stops on a flat holdout instead of running every epoch', () => {
    const flat: TrainingPair[] = Array.from({ length: 6 }, () => ({
      seed: [{ features: new Float64Array(FEATURE_DIM), count: 1 }],
      candidateFeatures: [
        new Float64Array(FEATURE_DIM),
        new Float64Array(FEATURE_DIM),
        new Float64Array(FEATURE_DIM),
      ],
      positiveIndices: [0],
    }));
    const { evidence } = trainModel(flat.slice(2), flat.slice(0, 2), {
      seed: 3,
      maxEpochs: 400,
      evalEvery: 5,
      patience: 3,
    });
    expect(evidence.epochsRun).toBeLessThan(400);
    expect(evidence.bestEpoch).toBeLessThanOrEqual(evidence.epochsRun);
    expect(Number.isFinite(evidence.holdoutLoss)).toBe(true);
  });
});

describe('candidate construction', () => {
  const cards = fixtureCatalog();
  const ctx = fixtureContext(cards);

  it('derives canonical ink state from the seed and throws past two inks', () => {
    expect(seedInkState([100, 105], ctx.byId)).toEqual(['Ruby']);
    expect(seedInkState([100, 200], ctx.byId)).toEqual(
      INKS.filter((ink) => ink === 'Ruby' || ink === 'Sapphire'),
    );
    const amethyst = makeCard({
      id: 400,
      name: 'Amethyst Fixture',
      inks: ['Amethyst'],
    });
    const wide = new Map<number, Card>([...ctx.byId, [400, amethyst]]);
    expect(() => seedInkState([100, 200, 400], wide)).toThrow(/inks/);
    expect(() => seedInkState([99999], ctx.byId)).toThrow(/unknown card/);
  });

  it('samples seeded negatives that exclude seed/target and pass legality', () => {
    // 301 shares groupKey with the saturated id 300: the copy limit (not the
    // seed/target exclusion) is what keeps it out of the negatives
    const catalog = [
      ...cards,
      makeCard({ id: 300, name: 'Saturated Fixture', maxCopies: 3 }),
      makeCard({ id: 301, name: 'Saturated Fixture' }),
    ];
    const wide = fixtureContext(catalog);
    const seedCounts: Record<number, number> = { 300: 3, 100: 2 };
    const seedIds = new Set([300, 100]);
    const targetIds = new Set([105]);
    const draw = (seed: number): number[] =>
      sampleNegatives({
        seedCounts,
        seedIds,
        targetIds,
        ctx: wide,
        count: 8,
        rng: mulberry32(seed),
      });
    const first = draw(20261123);
    expect(draw(20261123)).toEqual(first); // seeded, deterministic
    expect(first.length).toBeLessThanOrEqual(8);
    const deck = {
      title: 'training-view',
      format: 'core' as const,
      inks: ['Ruby'] as Ink[],
      cards: seedCounts,
    };
    for (const id of first) {
      expect(seedIds.has(id)).toBe(false);
      expect(targetIds.has(id)).toBe(false);
      expect(canAddCard(deck, wide.byId.get(id)!, wide.byId).ok).toBe(true);
      expect(wide.byId.get(id)!.inks).toEqual(['Ruby']); // never off-ink
    }
    expect(first).not.toContain(301); // copy limit via the shared group
  });

  it('returns fewer negatives when the legal pool is exhausted', () => {
    const tiny = fixtureContext(cards.slice(0, 3));
    const picked = sampleNegatives({
      seedCounts: { 100: 2 },
      seedIds: new Set([100]),
      targetIds: new Set([101]),
      ctx: tiny,
      count: 16,
      rng: mulberry32(1),
    });
    expect(picked).toEqual([102]);
  });

  it('builds imitation rows: positives first, then legality-checked negatives', () => {
    const pair: MaskedElitesPair = {
      stratum: 'masked-elites',
      deckId: 'archive:1:cell-a',
      cellKey: 'cell-a',
      seed: { 100: 2, 101: 1 },
      target: { 105: 2, 103: 1 },
    };
    const example = buildImitationExample(
      pair,
      { ...ctx, negativesPerPair: 4 },
      mulberry32(5),
    );
    const positives = Object.keys(pair.target)
      .map(Number)
      .sort((a, b) => a - b);
    expect(example.positiveIndices).toEqual(positives.map((_, i) => i));
    expect(example.candidateFeatures.slice(0, positives.length)).toEqual(
      positives.map((id) => ctx.featuresById.get(id)!),
    );
    expect(example.candidateFeatures).toHaveLength(positives.length + 4);
    // seed cards are ordered by id with their copy counts
    expect(example.seed.map((card) => card.count)).toEqual([2, 1]);
    expect(example.seed[0]!.features).toBe(ctx.featuresById.get(100)!);
  });

  it('splits a corpus deck-exact and counts skipped substitution deltas', () => {
    const corpus: Corpus = {
      format: 'core',
      featureSchemaVersion: 1,
      pairs: [
        {
          stratum: 'masked-elites',
          deckId: 'archive:20261122:cell-a',
          cellKey: 'cell-a',
          seed: { 100: 3, 101: 3 },
          target: { 102: 3, 103: 3 },
        },
        {
          stratum: 'masked-elites',
          deckId: 'archive:20261122:cell-b',
          cellKey: 'cell-b',
          seed: { 108: 3, 109: 3 },
          target: { 110: 3, 111: 3 },
        },
        {
          stratum: 'substitution-delta',
          deckId: 'archive:20261122:cell-a',
          cellKey: 'cell-a',
          context: { 100: 3, 101: 2 },
          cardOut: '101',
          cardIn: '104',
          delta: 0.05,
        },
        {
          stratum: 'substitution-delta',
          deckId: 'archive:20261122:cell-a',
          cellKey: 'cell-a',
          context: { 100: 3, 101: 2 },
          cardOut: '101',
          cardIn: '105',
          delta: 0.001, // below the D2a noise floor → skipped
        },
      ],
      holdoutCellKeys: ['cell-b'],
    };
    const split = examplesFromCorpus(corpus, ctx, 20261123);
    expect(split.totalPairs).toBe(4);
    expect(split.train).toHaveLength(2);
    expect(split.holdout).toHaveLength(1);
    expect(split.strata['masked-elites']).toEqual({
      pairs: 2,
      trained: 1,
      holdout: 1,
      skipped: 0,
    });
    // D2a: |Δ| ≥ 0.02 trains with weight |Δ|, |Δ| < 0.02 is skipped
    expect(split.strata['substitution-delta']).toEqual({
      pairs: 2,
      trained: 1,
      holdout: 0,
      skipped: 1,
    });
    expect(split.holdout[0]!.candidateFeatures.length).toBeGreaterThan(0);
    const deltaExample = split.train.find(
      (example) => example.weight !== undefined && example.weight !== 0.3,
    );
    expect(deltaExample?.weight).toBe(0.05);
    // Δ > 0: cardIn (104) is the positive; cardOut (101) is a candidate to beat
    const deltaPositives = deltaExample!.positiveIndices;
    expect(deltaPositives).toEqual([0]);
    expect(deltaExample!.candidateFeatures[1]).toBe(ctx.featuresById.get(101)!);
  });

  it('builds delta rows: negative delta makes cardOut the positive', () => {
    const pair = {
      stratum: 'substitution-delta' as const,
      deckId: 'archive:20261122:cell-a',
      cellKey: 'cell-a',
      context: { 100: 3, 101: 2 },
      cardOut: '101',
      cardIn: '104',
      delta: -0.05,
    };
    const example = buildDeltaExample(pair, ctx, mulberry32(5));
    expect(example.weight).toBe(0.05);
    expect(example.positiveIndices).toEqual([0]);
    expect(example.candidateFeatures[0]).toBe(ctx.featuresById.get(101)!);
    expect(example.candidateFeatures[1]).toBe(ctx.featuresById.get(104)!);
  });

  it('trains coverage pairs at the pre-committed reduced weight', () => {
    const corpus: Corpus = {
      format: 'core',
      featureSchemaVersion: 1,
      pairs: [
        {
          stratum: 'masked-elites',
          deckId: 'd1',
          cellKey: 'd1',
          seed: { 100: 3, 101: 3 },
          target: { 102: 3, 103: 3 },
        },
        {
          stratum: 'coverage',
          deckId: 'coverage:sweep-0',
          cellKey: 'coverage:sweep-0',
          seed: { 108: 3, 109: 3 },
          target: { 110: 3, 111: 3 },
          trainWeight: 0.3,
          fitness: 0.5,
        },
      ],
      holdoutCellKeys: [],
    };
    const split = examplesFromCorpus(corpus, ctx, 20261123);
    const coverage = split.train.find(
      (example) => example.weight !== undefined,
    );
    expect(coverage?.weight).toBe(0.3);
    expect(split.strata.coverage).toEqual({
      pairs: 1,
      trained: 1,
      holdout: 0,
      skipped: 0,
    });
  });
});

describe('int16 quantization (D3)', () => {
  it('round-trips scores within tolerance', () => {
    const model = createModel(2026);
    const cards = fixtureCatalog();
    const ctx = fixtureContext(cards);
    const seed: SeedCard[] = cards
      .slice(0, 7)
      .map((card) => ({ features: ctx.featuresById.get(card.id)!, count: 2 }));
    const candidates = cards
      .slice(7, 15)
      .map((card) => ctx.featuresById.get(card.id)!);
    const exact = scoreCandidates(model, seed, candidates);
    const quantized = quantizeModel(model);
    expect(quantized.quantization).toBe('int16-le');
    const decoded = scoreCandidates(
      dequantizeModel(quantized),
      seed,
      candidates,
    );
    for (let i = 0; i < exact.length; i++) {
      expect(Math.abs(exact[i]! - decoded[i]!)).toBeLessThan(0.02);
    }
    for (const [key, tensor] of Object.entries(quantized.tensors)) {
      expect(tensor.scale).toBeGreaterThan(0);
      const size = TENSOR_SHAPES[key]!.reduce((a, b) => a * b, 1);
      expect(Buffer.from(tensor.b64, 'base64').length).toBe(size * 2);
    }
  });

  it('rejects corrupt weights blocks', () => {
    const quantized = quantizeModel(createModel(1));
    expect(() =>
      dequantizeModel({ ...quantized, quantization: 'float32' as never }),
    ).toThrow(/quantization/);
    const reshaped = structuredClone(quantized);
    reshaped.tensors.encW1!.shape = [1, 1];
    expect(() => dequantizeModel(reshaped)).toThrow(/shape/);
    const truncated = structuredClone(quantized);
    truncated.tensors.encW1!.b64 = Buffer.from([0, 0]).toString('base64');
    expect(() => dequantizeModel(truncated)).toThrow(/payload/);
  });
});
