import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTION_NAMES,
  FEATURE_DIM as TRAINING_FEATURE_DIM,
  FEATURE_SCHEMA_VERSION as TRAINING_FEATURE_SCHEMA_VERSION,
  seedInteractionAggregate as trainingAggregate,
  cardFeatures as trainingCardFeatures,
  fnv1a32 as trainingFnv1a32,
  interactionDims as trainingInteractionDims,
  cardInteractionProfile as trainingProfile,
} from '../../scripts/training/generator/features';
import type { QuantizedWeights } from '../../scripts/training/generator/model';
import {
  createModel,
  type DeepSetsModel,
  dequantizeModel,
  quantizeModel,
  scoreCandidates,
  type TrainingCandidate,
} from '../../scripts/training/generator/model';
import type { Card, Ink } from '../data/types';
import { canAddCard, validateDeck } from '../rules/engine';
import { byIdMap, fillPool, makeCard } from '../test/fixtures';
import { type GenerateOptions, generateDeck } from './generator';
import {
  CANDIDATE_DIM,
  cardFeatures,
  cardInteractionProfile,
  createLearnedFillSource,
  FEATURE_DIM,
  FEATURE_SCHEMA_VERSION,
  featureVocabularies,
  fnv1a32,
  type GeneratorModelArtifact,
  INTERACTION_DIM,
  interactionDims,
  loadGeneratorModel,
  loadLearnedModelForSite,
  parseGeneratorModel,
  SCORER_INPUT_DIM,
  seedInteractionAggregate,
} from './learned-fill';
import { suggestFill } from './suggest-fill';

const AMBER: Card[] = fillPool(['Amber'], 30, 10, 100);
const RUBY: Card[] = fillPool(['Ruby'], 30, 10, 200);
const duals: Card[] = Array.from({ length: 8 }, (_, i) =>
  makeCard({
    id: 900 + i,
    name: `Dual ${i}`,
    inks: ['Amber', 'Ruby'],
    cost: (i % 4) + 2,
    inkwell: true,
  }),
);
const catalog = [...AMBER, ...RUBY, ...duals];

/** real card snapshot for the cross-implementation parity checks */
const snapshotCards = (
  JSON.parse(readFileSync('public/data/cards.min.json', 'utf8')) as {
    cards: Card[];
  }
).cards;
const shippedArtifact = JSON.parse(
  readFileSync('public/data/generator-model.json', 'utf8'),
) as Record<string, unknown>;

// ---- synthetic artifact fixtures ----

const zeros = (n: number): Float64Array => new Float64Array(n);

/** a model whose score is monotone in the candidate's cost (feature 0) */
const costLinearModel = (): DeepSetsModel => {
  const scorerW1 = zeros(16 * SCORER_INPUT_DIM);
  scorerW1[0] = 8; // score ≈ tanh(0.8 · cost)
  const scorerW2 = zeros(16);
  scorerW2[0] = 1;
  return {
    encW1: zeros(32 * FEATURE_DIM),
    encB1: zeros(32),
    encW2: zeros(16 * 32),
    encB2: zeros(16),
    scorerW1,
    scorerB1: zeros(16),
    scorerW2,
    scorerB2: 0,
  };
};

const artifactJson = (
  model: DeepSetsModel,
  passed: boolean,
): Record<string, unknown> => ({
  format: 'generator-model',
  featureSchemaVersion: 2,
  seed: 1,
  gate: {
    passed,
    verdict: passed ? 'PASS' : 'PENDING',
    ciLow: passed ? 0.1 : null,
  },
  arch: {
    description: 'test fixture',
    encoderHidden: 32,
    inputDim: 699,
    params: 34_529,
    poolDim: 16,
    scorerHidden: 16,
    scorerInputDim: 723,
  },
  weights: quantizeModel(model),
});

const gatedArtifact = (): GeneratorModelArtifact =>
  parseGeneratorModel(artifactJson(costLinearModel(), true))!;

/** a structurally valid artifact whose gate has NOT passed (not the shipped one) */
const unGatedFixtureArtifact = (): GeneratorModelArtifact =>
  parseGeneratorModel(artifactJson(createModel(9), false))!;

describe('cardFeatures (pinned to FEATURE_SCHEMA_VERSION 2, D2b hashed)', () => {
  it('matches the training implementation version and width', () => {
    expect(FEATURE_SCHEMA_VERSION).toBe(2);
    expect(TRAINING_FEATURE_SCHEMA_VERSION).toBe(2);
    expect(FEATURE_DIM).toBe(699);
    expect(CANDIDATE_DIM).toBe(707);
    expect(SCORER_INPUT_DIM).toBe(723);
    expect(FEATURE_DIM).toBe(TRAINING_FEATURE_DIM);
    expect(INTERACTION_DIM).toBe(8);
  });

  it('hashes identically to the training implementation (pinned constants)', () => {
    expect(fnv1a32('gaston')).toBe(4118703771);
    expect(fnv1a32('gaston')).toBe(trainingFnv1a32('gaston'));
    expect(fnv1a32('Hunny')).toBe(trainingFnv1a32('hunny'));
  });

  it('computes the pinned vector for a character fixture', () => {
    const vocab = featureVocabularies(catalog);
    const card = makeCard({
      id: 1,
      name: 'Feature Fixture',
      cost: 12,
      inkwell: true,
      type: 'Character',
      strength: 3,
      willpower: 4,
      lore: 2,
      text: 'Rush 2. When you play this character, banish it during your turns.',
    });
    // cost(1) inkable(1) character(1 0 0 0) rush(1 0 0 0 0 0 0 0 0 0)
    // willpower .4 strength .3 lore .4 bucket 1/3 numeric 1/5 when 1 on 0 during 1
    const expected = [
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0.4,
      0.3,
      0.4,
      1 / 3,
      0.2,
      1,
      0,
      1,
    ];
    const features = cardFeatures(card, vocab);
    expect([...features.slice(0, 24)]).toEqual(expected);
    // the fixture name hashes into exactly one name bucket (signed)
    const nameHash = fnv1a32('Feature Fixture');
    const nameBucket = 186 + (nameHash % 512);
    let nameBucketsSet = 0;
    for (let i = 186; i < 698; i++) {
      if (features[i] !== 0) nameBucketsSet++;
    }
    expect(nameBucketsSet).toBe(1);
    expect(features[nameBucket]).toBe((nameHash >>> 8) & 1 ? 1 : -1);
    expect(features[698]).toBe(1); // uniqueName
  });

  it('computes type one-hots for action, item and location fixtures', () => {
    const vocab = featureVocabularies(catalog);
    const action = cardFeatures(
      makeCard({ id: 2, type: 'Action', text: 'Sing together.' }),
      vocab,
    );
    expect([...action.slice(1, 6)]).toEqual([0, 0, 1, 0, 0]);
    const item = cardFeatures(
      makeCard({ id: 3, type: 'Item', text: '' }),
      vocab,
    );
    expect([...item.slice(1, 6)]).toEqual([1, 0, 0, 1, 0]); // makeCard: items default inkable
    const location = cardFeatures(
      makeCard({
        id: 4,
        type: 'Location',
        text: 'Evasive singers gather here.',
      }),
      vocab,
    );
    expect([...location.slice(1, 6)]).toEqual([1, 0, 0, 0, 1]);
    // 'singers' does not match \bsinger\b — word-boundary semantics are part
    // of the pinned schema
    expect([...location.slice(6, 16)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('matches the training implementation on every real snapshot card', () => {
    expect(snapshotCards.length).toBeGreaterThan(1000);
    const vocab = featureVocabularies(snapshotCards);
    for (const card of snapshotCards) {
      const runtime = cardFeatures(card, vocab);
      const training = trainingCardFeatures(card);
      for (let i = 0; i < 699; i++) {
        if (runtime[i] !== training[i]) {
          throw new Error(`dim ${i} drifts for ${card.fullName}`);
        }
      }
    }
  });

  it('matches the training interaction dims on synthetic real-card decks', () => {
    const vocab = featureVocabularies(snapshotCards);
    const byName = (fullName: string): Card => {
      const card = snapshotCards.find((c) => c.fullName === fullName);
      if (!card) throw new Error(`fixture missing: ${fullName}`);
      return card;
    };
    // a synthetic deck whose seed hits every interaction family
    const seedCards = [
      byName('Gaston - Arrogant Hunter'),
      byName('Grand Duke - Advisor to the King'),
      byName('Winnie the Pooh & Piglet - Hunny Mages'),
      byName('Be Our Guest'),
    ];
    const candidates = [
      byName('LeFou - Bumbler'), // refNameMatch (Gaston in seed)
      byName('Gaston - Intellectual Powerhouse'), // shift + overlap
      byName('Winnie the Pooh - Hunny Pirate'), // trait target (Staff absent → 0, name overlap)
      byName('Starlight Vial'), // typeRefMatch (Action in seed via Be Our Guest)
      byName('Magical Hunny Staff'), // traitEngineMatch (Hunny in seed)
    ];
    const runtimeAggregate = seedInteractionAggregate(
      seedCards.map((card) => cardInteractionProfile(card, vocab)),
    );
    const trainingAggregate_ = trainingAggregate(
      seedCards.map((card) => trainingProfile(card)),
    );
    for (const card of candidates) {
      const runtime = interactionDims(
        cardInteractionProfile(card, vocab),
        runtimeAggregate,
      );
      const training = trainingInteractionDims(
        trainingProfile(card),
        trainingAggregate_,
      );
      expect([...runtime]).toEqual([...training]);
    }
    // and the fixture really does fire the dims under test
    const staffDims = interactionDims(
      cardInteractionProfile(candidates[4]!, vocab),
      runtimeAggregate,
    );
    expect(staffDims[INTERACTION_NAMES.indexOf('traitEngineMatch')]).toBe(1);
    const lefouDims = interactionDims(
      cardInteractionProfile(candidates[0]!, vocab),
      runtimeAggregate,
    );
    expect(lefouDims[INTERACTION_NAMES.indexOf('refNameMatch')]).toBe(1);
  });
});

describe('parseGeneratorModel', () => {
  const valid = artifactJson(createModel(7), false) as {
    format: string;
    featureSchemaVersion: number;
    gate: Record<string, unknown>;
    arch: Record<string, unknown>;
    weights: {
      quantization: string;
      tensors: Record<string, { shape: number[]; scale: number; b64: string }>;
    };
  };
  const tensors = valid.weights.tensors;
  const reweighted = (tensors: Record<string, unknown>): unknown => ({
    ...valid,
    weights: { quantization: 'int16-le', tensors },
  });

  it('parses a structurally valid artifact and keeps the gate verdict', () => {
    const parsed = parseGeneratorModel(valid);
    expect(parsed).not.toBeNull();
    expect(parsed!.featureSchemaVersion).toBe(2);
    expect(parsed!.gate).toEqual({
      passed: false,
      verdict: 'PENDING',
      ciLow: null,
    });
    expect(parsed!.model.encW1).toHaveLength(32 * 699);
    expect(parsed!.model.scorerB2).toBeTypeOf('number');
  });

  it('rejects wrong shapes, payloads and schemas by degrading to null', () => {
    const cases: Array<[string, unknown]> = [
      ['not an object', 'nope'],
      ['null', null],
      ['wrong format', { ...valid, format: 'meta-model' }],
      ['missing format', { ...valid, format: undefined }],
      ['schema version drift', { ...valid, featureSchemaVersion: 1 }],
      ['missing schema version', { ...valid, featureSchemaVersion: undefined }],
      ['missing gate', { ...valid, gate: undefined }],
      ['non-boolean gate', { ...valid, gate: { passed: 'yes' } }],
      ['missing arch', { ...valid, arch: undefined }],
      [
        'arch mismatch',
        { ...valid, arch: { ...valid.arch, encoderHidden: 8 } },
      ],
      [
        'wrong quantization',
        { ...valid, weights: { quantization: 'fp32', tensors } },
      ],
      ['missing tensors', { ...valid, weights: { quantization: 'int16-le' } }],
      ['missing tensor', reweighted({ ...tensors, scorerW2: undefined })],
      [
        'wrong tensor shape',
        reweighted({
          ...tensors,
          scorerW2: { ...tensors.scorerW2, shape: [8] },
        }),
      ],
      [
        'payload size mismatch',
        reweighted({
          ...tensors,
          scorerW2: { shape: [1], scale: 1, b64: 'AAAA' },
        }),
      ],
      [
        'non-finite scale',
        reweighted({
          ...tensors,
          scorerW2: {
            shape: [1],
            scale: Number.NaN,
            b64: tensors.scorerW2!.b64,
          },
        }),
      ],
      [
        'invalid base64',
        reweighted({
          ...tensors,
          scorerW2: { shape: [1], scale: 1, b64: 'not base64!' },
        }),
      ],
    ];
    for (const [name, artifact] of cases) {
      expect(parseGeneratorModel(artifact), name).toBeNull();
    }
  });

  it('a stale-schema artifact degrades to null (schema mismatch)', () => {
    // task 6.4 deploys code + artifact together: an artifact whose
    // featureSchemaVersion doesn't match the runtime cannot drive it —
    // honest degradation to the shipped fill. Pinned to a synthetic
    // stale fixture, not the live deployed file (which advances with
    // the schema).
    const stale = {
      ...shippedArtifact,
      featureSchemaVersion: 1,
    } as typeof shippedArtifact;
    const parsed = parseGeneratorModel(stale);
    expect(parsed).toBeNull();
  });
});

describe('loadGeneratorModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const validArtifact = artifactJson(createModel(3), false);

  it('returns null when the artifact is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    expect(await loadGeneratorModel()).toBeNull();
  });

  it('parses a valid artifact from the static asset path', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => validArtifact,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const parsed = await loadGeneratorModel();
    expect(parsed?.featureSchemaVersion).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith('/data/generator-model.json', {
      cache: 'no-cache',
    });
  });

  it('degrades to null on network errors, corrupt JSON and schema mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadGeneratorModel()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('corrupt');
        },
      })),
    );
    expect(await loadGeneratorModel()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...validArtifact, featureSchemaVersion: 1 }),
      })),
    );
    expect(await loadGeneratorModel()).toBeNull();
  });
});

describe('loadLearnedModelForSite (live-trial loader)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const validArtifact = artifactJson(createModel(5), false);

  it('always loads and forces the gate flag on a valid artifact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => validArtifact })),
    );
    const model = await loadLearnedModelForSite();
    expect(model).not.toBeNull();
    expect(model?.gate.passed).toBe(true);
    expect(model?.featureSchemaVersion).toBe(2);
  });

  it('returns null for a missing artifact (shipped-fill fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    expect(await loadLearnedModelForSite()).toBeNull();
  });
});

describe('createLearnedFillSource', () => {
  const byId = byIdMap(catalog);

  it('does not exist for an artifact whose gate has not passed', () => {
    const unGated = parseGeneratorModel(artifactJson(createModel(1), false))!;
    expect(createLearnedFillSource(unGated, byId)).toBeNull();
  });

  it('exists for a gate-passed artifact', () => {
    const gated = parseGeneratorModel(artifactJson(createModel(1), true))!;
    expect(createLearnedFillSource(gated, byId)).not.toBeNull();
  });

  it('scores deterministically for the same deck state', () => {
    const source = createLearnedFillSource(gatedArtifact(), byId)!;
    const deck: Record<number, number> = { 100: 2, 101: 4, 601: 1 };
    const candidates = [AMBER[3]!, AMBER[7]!, RUBY[2]!];
    const a = source.score(deck, candidates);
    const b = source.score({ ...deck }, candidates);
    expect([...a]).toEqual([...b]);
  });

  it('scores identically to the training implementation on real cards (v2 end-to-end)', () => {
    // full parity probe on a synthetic v2 artifact: feature hashing +
    // interaction dims + dequantization + forward pass, over real snapshot
    // decks whose seeds fire the interaction families
    const byName = (fullName: string): Card => {
      const card = snapshotCards.find((c) => c.fullName === fullName);
      if (!card) throw new Error(`fixture missing: ${fullName}`);
      return card;
    };
    const byIdReal = byIdMap(snapshotCards);
    // the seed hits name/subtype/type relations: Gaston, the Grand Duke, a
    // Hunny character and a Song (Action type)
    const seedPart = [
      byName('Gaston - Arrogant Hunter'),
      byName('Grand Duke - Advisor to the King'),
      byName('Winnie the Pooh - Hunny Pirate'),
      byName('Be Our Guest'),
    ];
    const deck: Record<number, number> = {};
    for (const card of seedPart) deck[card.id] = 2;
    for (const card of snapshotCards
      .filter((c) => c.inks.includes('Amber'))
      .slice(0, 8)) {
      deck[card.id] = (card.id % 3) + 1;
    }
    // candidates include the relation partners so the dims actually fire
    const candidates = [
      byName('LeFou - Bumbler'),
      byName('Gaston - Intellectual Powerhouse'),
      byName('Magical Hunny Staff'),
      byName('Starlight Vial'),
      ...snapshotCards
        .filter((c) => c.formats.core && c.inks.includes('Amber'))
        .slice(0, 35),
    ];
    const trainedModel = createModel(20261123);
    const rawArtifact = artifactJson(trainedModel, true);
    const artifact = parseGeneratorModel(rawArtifact) as GeneratorModelArtifact;
    const source = createLearnedFillSource(artifact, byIdReal)!;
    const actual = source.score(deck, candidates);
    // training-side reference: same seed deck, same candidates, same weights
    const trainingSeed = Object.keys(deck)
      .map(Number)
      .sort((a, b) => a - b)
      .map((id) => ({
        features: trainingCardFeatures(byIdReal.get(id)!),
        count: deck[id]!,
      }));
    const aggregate = trainingAggregate(
      Object.keys(deck)
        .map(Number)
        .sort((a, b) => a - b)
        .map((id) => trainingProfile(byIdReal.get(id)!)),
    );
    const trainingCandidates: TrainingCandidate[] = candidates.map((card) => ({
      features: trainingCardFeatures(card),
      interactions: trainingInteractionDims(trainingProfile(card), aggregate),
    }));
    const expected = scoreCandidates(
      dequantizeModel(rawArtifact.weights as QuantizedWeights),
      trainingSeed,
      trainingCandidates,
    );
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]).toBe(expected[i]);
    }
    // the probe is not vacuous: at least one interaction dim fires
    const fired = trainingCandidates.some((candidate) =>
      candidate.interactions.some((value) => value !== 0),
    );
    expect(fired).toBe(true);
  });
});

describe('suggest-fill learned path', () => {
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
      model: null,
      cards: pool,
      inks: ['Amber'] as Ink[],
      format: 'core' as const,
      targetSize: 60,
      locked: new Set<number>(),
      groupCounts: new Map<string, number>(),
      inkableBaseline: 0,
      byId: byIdMap(pool),
      ...rest,
    };
  };

  it('masks candidates through canAddCard before the model ranks (D4)', () => {
    const ruby = fillPool(['Ruby'], 5, 0, 800);
    const pool = [...AMBER, ...ruby];
    const byId = byIdMap(pool);
    const inks: Ink[] = ['Amber'];
    const seen: Array<{ deck: Record<number, number>; ids: number[] }> = [];
    const spy = {
      score(deck: Record<number, number>, candidates: readonly Card[]) {
        seen.push({ deck: { ...deck }, ids: candidates.map((c) => c.id) });
        return new Float64Array(candidates.length);
      },
    };
    const opts = fillOpts({
      pool,
      byId,
      inks,
      declaredInks: inks,
      learned: spy,
    });
    const result = suggestFill(opts);
    expect(result.placed).toBe(60);
    expect(seen.length).toBeGreaterThan(0);
    for (const { deck, ids } of seen) {
      const deckState = {
        title: '',
        inks,
        format: 'core' as const,
        cards: deck,
      };
      for (const id of ids) {
        expect(canAddCard(deckState, byId.get(id)!, byId).ok).toBe(true);
      }
      // the Ruby cards are pool members the loop's own rules would admit —
      // only the canAddCard mask removes them
      for (const card of ruby) expect(ids).not.toContain(card.id);
    }
  });

  it('is deterministic with the learned source and varies across seeds', () => {
    const pool = AMBER;
    const a = fillOpts({
      pool,
      seed: 99,
      learned: createLearnedFillSource(gatedArtifact(), byIdMap(pool)),
    });
    const b = fillOpts({
      pool,
      seed: 99,
      learned: createLearnedFillSource(gatedArtifact(), byIdMap(pool)),
    });
    suggestFill(a);
    suggestFill(b);
    expect(a.deck).toEqual(b.deck);
    const other = fillOpts({
      pool,
      seed: 100,
      learned: createLearnedFillSource(gatedArtifact(), byIdMap(pool)),
    });
    suggestFill(other);
    expect(other.deck).not.toEqual(a.deck);
  });

  it('produces a legal deck driven by the learned scores', () => {
    const pool = [...AMBER, ...RUBY];
    const learned = fillOpts({
      pool,
      seed: 42,
      learned: createLearnedFillSource(gatedArtifact(), byIdMap(pool)),
    });
    const shipped = fillOpts({ pool, seed: 42 });
    suggestFill(learned);
    suggestFill(shipped);
    const deckState = (deck: Record<number, number>) => ({
      title: 'T',
      inks: ['Amber'] as Ink[],
      format: 'core' as const,
      cards: deck,
    });
    expect(validateDeck(deckState(learned.deck), byIdMap(pool))).toEqual([]);
    expect(learned.deck).not.toEqual(shipped.deck);
    // the fixture model is monotone in cost: its picks skew expensive
    const meanCost = (deck: Record<number, number>): number => {
      let total = 0;
      let count = 0;
      for (const [id, n] of Object.entries(deck)) {
        total += byIdMap(pool).get(Number(id))!.cost * n;
        count += n;
      }
      return total / count;
    };
    expect(meanCost(learned.deck)).toBeGreaterThan(meanCost(shipped.deck));
  });

  it('a null learned source is equivalent to no source', () => {
    const pool = AMBER;
    const a = fillOpts({ pool, seed: 5 });
    const b = fillOpts({ pool, seed: 5, learned: null });
    suggestFill(a);
    suggestFill(b);
    expect(a.deck).toEqual(b.deck);
  });
});

describe('generator integration (smart mode, D5)', () => {
  const run = (
    opts: Partial<GenerateOptions>,
  ): ReturnType<typeof generateDeck> =>
    generateDeck({ cards: catalog, format: 'core', ...opts });

  // golden decks produced by the pre-learned-fill shipped code (regenerate
  // with the same fixtures + seeds when the shipped fill intentionally
  // changes; any unexplained drift here is a behavior regression)
  const GOLDENS: Record<string, Record<number, number>> = {
    'amber-seed-42': {
      100: 1,
      101: 3,
      102: 4,
      103: 4,
      104: 2,
      106: 2,
      107: 1,
      108: 4,
      109: 4,
      114: 4,
      115: 3,
      120: 4,
      121: 4,
      126: 1,
      127: 4,
      600: 1,
      601: 2,
      602: 2,
      604: 2,
      606: 4,
      607: 1,
      609: 3,
    },
    'twoink-seed-21': {
      100: 1,
      102: 4,
      103: 4,
      108: 4,
      109: 1,
      114: 4,
      115: 4,
      120: 4,
      121: 1,
      126: 4,
      127: 3,
      203: 2,
      600: 2,
      602: 3,
      603: 1,
      609: 4,
      703: 3,
      709: 2,
      901: 1,
      902: 4,
      905: 3,
      906: 1,
    },
    'partial-seed-11': {
      100: 3,
      101: 3,
      102: 3,
      103: 3,
      104: 3,
      105: 3,
      106: 3,
      107: 3,
      108: 1,
      109: 4,
      112: 1,
      114: 4,
      115: 3,
      120: 4,
      121: 2,
      126: 2,
      600: 2,
      601: 1,
      602: 4,
      603: 3,
      604: 1,
      606: 2,
      609: 2,
    },
  };
  const partial = Object.fromEntries(AMBER.slice(0, 8).map((c) => [c.id, 3]));

  it('without an artifact, smart mode produces the shipped decks on fixed seeds', () => {
    expect(run({ inks: ['Amber'], seed: 42 }).deck!.cards).toEqual(
      GOLDENS['amber-seed-42'],
    );
    expect(run({ inks: ['Amber', 'Ruby'], seed: 21 }).deck!.cards).toEqual(
      GOLDENS['twoink-seed-21'],
    );
    expect(run({ inks: ['Amber'], seed: 11, partial }).deck!.cards).toEqual(
      GOLDENS['partial-seed-11'],
    );
  });

  it('an unavailable artifact degrades byte-identically and reports the fallback', () => {
    const result = run({ inks: ['Amber'], seed: 42, learnedModel: null });
    expect(result.deck!.cards).toEqual(GOLDENS['amber-seed-42']);
    expect(result.notes.notes).toContain(
      'Fill source: suggest-fill (learned model artifact unavailable).',
    );
  });

  it('an un-gated artifact stays on the shipped fill', () => {
    const result = run({
      inks: ['Amber'],
      seed: 42,
      learnedModel: unGatedFixtureArtifact(),
    });
    expect(result.deck!.cards).toEqual(GOLDENS['amber-seed-42']);
    expect(result.notes.notes).toContain(
      'Fill source: suggest-fill (learned model not gate-passed).',
    );
  });

  it('the novel end (former chaos path) is untouched by the learned wiring', () => {
    const novelGolden = {
      100: 4,
      101: 4,
      102: 1,
      103: 4,
      106: 3,
      107: 4,
      108: 2,
      109: 2,
      112: 4,
      113: 4,
      118: 3,
      119: 4,
      124: 2,
      125: 4,
      601: 3,
      602: 1,
      603: 2,
      606: 3,
      607: 4,
      608: 2,
    };
    expect(run({ inks: ['Amber'], seed: 7, novelty: 1 }).deck!.cards).toEqual(
      novelGolden,
    );
    expect(
      run({
        inks: ['Amber'],
        seed: 7,
        novelty: 1,
        learnedModel: unGatedFixtureArtifact(),
      }).deck!.cards,
    ).toEqual(novelGolden);
  });

  it('learned fill with two declared inks keeps the D7 representation guarantee', () => {
    const result = run({
      inks: ['Amber', 'Ruby'],
      seed: 21,
      learnedModel: gatedArtifact(),
    });
    expect(result.deck).not.toBeNull();
    expect(validateDeck(result.deck!, byIdMap(catalog))).toEqual([]);
    const byId = byIdMap(catalog);
    const counts: Record<string, number> = { Amber: 0, Ruby: 0 };
    for (const [id, n] of Object.entries(result.deck!.cards)) {
      for (const ink of byId.get(Number(id))!.inks) {
        if (ink in counts) counts[ink]! += n;
      }
    }
    expect(counts.Amber).toBeGreaterThan(0);
    expect(counts.Ruby).toBeGreaterThan(0);
  });

  it('uses the learned source when the artifact is valid and gate-passed', () => {
    const result = run({
      inks: ['Amber'],
      seed: 42,
      learnedModel: gatedArtifact(),
    });
    expect(result.deck).not.toBeNull();
    expect(result.notes.notes).toContain(
      'Fill source: learned generator model (A/B gate passed).',
    );
    expect(validateDeck(result.deck!, byIdMap(catalog))).toEqual([]);
    // the gate-passed path is live: the cost-linear fixture model shifts the
    // picks away from the shipped deck toward expensive cards
    expect(result.deck!.cards).not.toEqual(GOLDENS['amber-seed-42']);
    const meanCost = (deck: Record<number, number>): number => {
      let total = 0;
      let count = 0;
      for (const [id, n] of Object.entries(deck)) {
        total += byIdMap(catalog).get(Number(id))!.cost * n;
        count += n;
      }
      return total / count;
    };
    expect(meanCost(result.deck!.cards)).toBeGreaterThan(
      meanCost(GOLDENS['amber-seed-42']!),
    );
  });
});
