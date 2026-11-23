/**
 * Pure-TS DeepSets completion model (learned-deck-generator, tasks 3.1;
 * design D2; spec learned-deck-completion "Quantized model artifact").
 *
 * Architecture (≤ ~4k params, 2001 total):
 *
 *   encoder  per-card MLP 24 → 32 → 16, tanh on both layers
 *   pool     masked mean over the seed deck's card vectors, weighted by
 *            copy count (counts are weights)
 *   scorer   MLP over [candidate features (24) ⊕ pooled context (16)]
 *            → 16 → 1 scalar, tanh hidden layer
 *
 * Training follows the M4 ranker precedent (arena/ranker.ts): seeded
 * full-batch gradient descent, no Math.random anywhere. Each imitation pair
 * contributes one softmax cross-entropy row over its candidate set — target
 * identities are the positives, sampled pool negatives (seeded, excluded
 * seed/target ids, canAddCard-checked against the seed so the training view
 * matches inference masking, D4) are the negatives; the loss is averaged over
 * pairs. Early stopping keeps the best-holdout-loss weights.
 *
 * Inference shares the exact forward path with training (`scoreCandidates`
 * and the gradient pass both run `forwardPair`), so there is no train/test
 * skew. The same function dequantizes to run the shipped artifact.
 *
 * Module boundaries (root-tsconfig rule, corpus.ts precedent): no imports
 * from scripts/training/arena — the root program excludes that directory and
 * an import would drag the vendored engine back in.
 */

import type { Card, DeckState, Format, Ink } from '../../../src/data/types';
import { INKS } from '../../../src/data/types';
import { canAddCard } from '../../../src/rules/engine';
import { mulberry32 } from '../prng';
import type { Corpus, CorpusStratum } from './corpus';
import {
  type MaskedElitesPair,
  type RestrictedPair,
  STRATUM_ORDER,
  stableDeckKey,
} from './corpus';
import { FEATURE_DIM } from './features';

// ---- architecture ----

/** per-card encoder hidden width (D2: hidden widths ≤ 32) */
export const ENCODER_HIDDEN = 32;
/** pooled context width = encoder output width */
export const POOL_DIM = 16;
/** scorer hidden width */
export const SCORER_HIDDEN = 16;
/** scorer input: candidate features ⊕ pooled context */
export const SCORER_INPUT_DIM = FEATURE_DIM + POOL_DIM;
/** sampled pool negatives per pair (task 3.1: ~16) */
export const DEFAULT_NEGATIVES_PER_PAIR = 16;
/** master training seed (the change's pre-committed seed) */
export const DEFAULT_TRAIN_SEED = 20261123;

/** total trainable parameters; asserted ≤ ~4k by test (D3 tiny-model budget) */
export const PARAM_COUNT =
  ENCODER_HIDDEN * FEATURE_DIM +
  ENCODER_HIDDEN +
  POOL_DIM * ENCODER_HIDDEN +
  POOL_DIM +
  SCORER_HIDDEN * SCORER_INPUT_DIM +
  SCORER_HIDDEN +
  SCORER_HIDDEN +
  1;

export interface DeepSetsModel {
  /** encoder layer 1: [ENCODER_HIDDEN, FEATURE_DIM], row-major */
  encW1: Float64Array;
  encB1: Float64Array;
  /** encoder layer 2: [POOL_DIM, ENCODER_HIDDEN], row-major */
  encW2: Float64Array;
  encB2: Float64Array;
  /** scorer layer 1: [SCORER_HIDDEN, SCORER_INPUT_DIM], row-major */
  scorerW1: Float64Array;
  scorerB1: Float64Array;
  scorerW2: Float64Array;
  scorerB2: number;
}

/** one seed-deck card: feature vector + copy count (the pool weight) */
export interface SeedCard {
  features: Float64Array;
  count: number;
}

/** seeded uniform init in ±0.3, ranker trainMlp precedent; biases start at 0 */
export function createModel(seed: number = DEFAULT_TRAIN_SEED): DeepSetsModel {
  const rng = mulberry32(seed);
  const fill = (n: number): Float64Array => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * 0.3;
    return out;
  };
  return {
    encW1: fill(ENCODER_HIDDEN * FEATURE_DIM),
    encB1: new Float64Array(ENCODER_HIDDEN),
    encW2: fill(POOL_DIM * ENCODER_HIDDEN),
    encB2: new Float64Array(POOL_DIM),
    scorerW1: fill(SCORER_HIDDEN * SCORER_INPUT_DIM),
    scorerB1: new Float64Array(SCORER_HIDDEN),
    scorerW2: fill(SCORER_HIDDEN),
    scorerB2: 0,
  };
}

// ---- forward ----

/** per-pair activations kept between forward and backward */
interface PairActivations {
  g: Float64Array; // S × ENCODER_HIDDEN, tanh(W1e f + b1e)
  h: Float64Array; // S × POOL_DIM, tanh(W2e g + b2e)
  pool: Float64Array; // POOL_DIM
  u: Float64Array; // C × SCORER_INPUT_DIM ([candidate ⊕ pool])
  v: Float64Array; // C × SCORER_HIDDEN
  scores: Float64Array; // C
  /** Σ copy counts of the seed deck (the pool's normalizer) */
  total: number;
}

function forwardPair(
  model: DeepSetsModel,
  seed: readonly SeedCard[],
  candidates: readonly Float64Array[],
  act: PairActivations,
): void {
  const S = seed.length;
  const C = candidates.length;
  const { g, h, pool, u, v, scores } = act;
  // local alias: under vitest's module runner, imported bindings turn into
  // proxy property reads — fatal in a hot loop
  const dim = FEATURE_DIM;

  // encoder + masked mean pool (copy counts as weights); an empty seed deck
  // pools to the zero vector — the caller picks legal candidates, so this
  // only arises for degenerate inputs
  let total = 0;
  for (const card of seed) total += card.count;
  act.total = total;
  pool.fill(0);
  for (let k = 0; k < S; k++) {
    const f = seed[k]!.features;
    const gBase = k * ENCODER_HIDDEN;
    for (let un = 0; un < ENCODER_HIDDEN; un++) {
      let a = model.encB1[un]!;
      for (let i = 0; i < dim; i++) {
        a += model.encW1[un * dim + i]! * f[i]!;
      }
      g[gBase + un] = Math.tanh(a);
    }
    const hBase = k * POOL_DIM;
    const weight = seed[k]!.count / total;
    for (let p = 0; p < POOL_DIM; p++) {
      let a = model.encB2[p]!;
      for (let un = 0; un < ENCODER_HIDDEN; un++) {
        a += model.encW2[p * ENCODER_HIDDEN + un]! * g[gBase + un]!;
      }
      const hv = Math.tanh(a);
      h[hBase + p] = hv;
      pool[p]! += weight * hv;
    }
  }

  // scorer over [candidate features ⊕ pooled context]
  for (let j = 0; j < C; j++) {
    const row = j * SCORER_INPUT_DIM;
    const x = candidates[j]!;
    for (let i = 0; i < dim; i++) u[row + i] = x[i]!;
    for (let p = 0; p < POOL_DIM; p++) {
      u[row + dim + p] = pool[p]!;
    }
    let s = model.scorerB2;
    for (let o = 0; o < SCORER_HIDDEN; o++) {
      let z = model.scorerB1[o]!;
      for (let d = 0; d < SCORER_INPUT_DIM; d++) {
        z += model.scorerW1[o * SCORER_INPUT_DIM + d]! * u[row + d]!;
      }
      const vv = Math.tanh(z);
      v[j * SCORER_HIDDEN + o] = vv;
      s += model.scorerW2[o]! * vv;
    }
    scores[j] = s;
  }
}

/** scratch activations sized for a batch of pairs */
function allocActivations(
  maxSeed: number,
  maxCandidates: number,
): PairActivations {
  return {
    g: new Float64Array(maxSeed * ENCODER_HIDDEN),
    h: new Float64Array(maxSeed * POOL_DIM),
    pool: new Float64Array(POOL_DIM),
    u: new Float64Array(maxCandidates * SCORER_INPUT_DIM),
    v: new Float64Array(maxCandidates * SCORER_HIDDEN),
    scores: new Float64Array(maxCandidates),
    total: 0,
  };
}

/**
 * Inference API: score each candidate given the seed deck. The candidate set
 * must already be legality-masked by the caller (D4: legality is never
 * learned). Deterministic; the exact forward path training uses.
 */
export function scoreCandidates(
  model: DeepSetsModel,
  seedDeck: readonly SeedCard[],
  candidateFeatures: readonly Float64Array[],
): Float64Array {
  const scores = new Float64Array(candidateFeatures.length);
  if (candidateFeatures.length === 0) return scores;
  const act = allocActivations(
    Math.max(1, seedDeck.length),
    candidateFeatures.length,
  );
  forwardPair(model, seedDeck, candidateFeatures, act);
  scores.set(act.scores.subarray(0, candidateFeatures.length));
  return scores;
}

// ---- training ----

/** one softmax cross-entropy row: candidate set + positive indices */
export interface TrainingPair {
  seed: SeedCard[];
  candidateFeatures: Float64Array[];
  /** indices into candidateFeatures of the positives (uniform target) */
  positiveIndices: number[];
}

export interface TrainOptions {
  seed?: number;
  lr?: number;
  l2?: number;
  maxEpochs?: number;
  /** holdout evaluation cadence (epochs) */
  evalEvery?: number;
  /** early stop after this many evaluations without holdout improvement */
  patience?: number;
}

export interface TrainEvidence {
  epochsRun: number;
  bestEpoch: number;
  trainLoss: number;
  trainAccuracy: number;
  holdoutLoss: number;
  holdoutAccuracy: number;
  hyper: {
    lr: number;
    l2: number;
    maxEpochs: number;
    evalEvery: number;
    patience: number;
    seed: number;
  };
}

export interface TrainResult {
  model: DeepSetsModel;
  evidence: TrainEvidence;
}

export interface ModelGradients {
  encW1: Float64Array;
  encB1: Float64Array;
  encW2: Float64Array;
  encB2: Float64Array;
  scorerW1: Float64Array;
  scorerB1: Float64Array;
  scorerW2: Float64Array;
  scorerB2: number;
}

function zeroGradients(): ModelGradients {
  return {
    encW1: new Float64Array(ENCODER_HIDDEN * FEATURE_DIM),
    encB1: new Float64Array(ENCODER_HIDDEN),
    encW2: new Float64Array(POOL_DIM * ENCODER_HIDDEN),
    encB2: new Float64Array(POOL_DIM),
    scorerW1: new Float64Array(SCORER_HIDDEN * SCORER_INPUT_DIM),
    scorerB1: new Float64Array(SCORER_HIDDEN),
    scorerW2: new Float64Array(SCORER_HIDDEN),
    scorerB2: 0,
  };
}

function snapshotModel(model: DeepSetsModel): DeepSetsModel {
  return {
    encW1: Float64Array.from(model.encW1),
    encB1: Float64Array.from(model.encB1),
    encW2: Float64Array.from(model.encW2),
    encB2: Float64Array.from(model.encB2),
    scorerW1: Float64Array.from(model.scorerW1),
    scorerB1: Float64Array.from(model.scorerB1),
    scorerW2: Float64Array.from(model.scorerW2),
    scorerB2: model.scorerB2,
  };
}

function restoreModel(model: DeepSetsModel, snap: DeepSetsModel): void {
  model.encW1.set(snap.encW1);
  model.encB1.set(snap.encB1);
  model.encW2.set(snap.encW2);
  model.encB2.set(snap.encB2);
  model.scorerW1.set(snap.scorerW1);
  model.scorerB1.set(snap.scorerB1);
  model.scorerW2.set(snap.scorerW2);
  model.scorerB2 = snap.scorerB2;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

interface PairScratch {
  exp: Float64Array;
  dV: Float64Array;
  dU: Float64Array;
  dPool: Float64Array;
}

function allocScratch(maxCandidates: number): PairScratch {
  return {
    exp: new Float64Array(maxCandidates),
    dV: new Float64Array(maxCandidates * SCORER_HIDDEN),
    dU: new Float64Array(maxCandidates * SCORER_INPUT_DIM),
    dPool: new Float64Array(POOL_DIM),
  };
}

function allocFor(pairs: readonly TrainingPair[]): {
  act: PairActivations;
  scratch: PairScratch;
} {
  let maxSeed = 1;
  let maxCandidates = 1;
  for (const pair of pairs) {
    maxSeed = Math.max(maxSeed, pair.seed.length);
    maxCandidates = Math.max(maxCandidates, pair.candidateFeatures.length);
  }
  return {
    act: allocActivations(maxSeed, maxCandidates),
    scratch: allocScratch(maxCandidates),
  };
}

/**
 * One pair: forward, softmax cross-entropy with a uniform target over the
 * positives, and — when `grads` is given — backward accumulation. Returns the
 * pair's CE loss (0 for degenerate pairs) and whether the argmax pick is a
 * positive. The exact code path training, evaluation and `pairLoss` share.
 */
function runPair(
  model: DeepSetsModel,
  pair: TrainingPair,
  act: PairActivations,
  scratch: PairScratch,
  grads: ModelGradients | null,
): { loss: number; hit: boolean } {
  const C = pair.candidateFeatures.length;
  if (C === 0 || pair.positiveIndices.length === 0) {
    return { loss: 0, hit: false };
  }
  // hot-loop alias: imported bindings are proxy reads under vitest's module
  // runner — keep them out of the inner loops
  const dim = FEATURE_DIM;
  const encH = ENCODER_HIDDEN;
  const poolDim = POOL_DIM;
  const scorerH = SCORER_HIDDEN;
  const scorerIn = SCORER_INPUT_DIM;
  forwardPair(model, pair.seed, pair.candidateFeatures, act);

  // softmax (max-subtracted); multi-positive CE: dL/ds_j = p_j − t_j with
  // t_j = 1/K on positives (uniform target distribution)
  let max = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < C; j++) max = Math.max(max, act.scores[j]!);
  let sumExp = 0;
  for (let j = 0; j < C; j++) {
    const e = Math.exp(act.scores[j]! - max);
    scratch.exp[j] = e;
    sumExp += e;
  }
  const positives = new Set(pair.positiveIndices);
  const invK = 1 / positives.size;
  let loss = 0;
  for (let j = 0; j < C; j++) {
    const p = scratch.exp[j]! / sumExp;
    act.scores[j] = p; // scores now hold probabilities
    if (positives.has(j)) loss -= Math.log(Math.max(p, 1e-12));
  }
  loss *= invK;
  const hit = positives.has(argmax(act.scores, C));
  if (!grads) return { loss, hit };

  // scorer backward: W1 grad accumulates against act.u, dU collects the
  // input gradient for the pool path
  const dV = scratch.dV;
  const dU = scratch.dU;
  dU.fill(0, 0, C * scorerIn);
  let gb2 = 0;
  for (let j = 0; j < C; j++) {
    const row = j * scorerIn;
    const dS = act.scores[j]! - (positives.has(j) ? invK : 0);
    gb2 += dS;
    for (let o = 0; o < scorerH; o++) {
      const vj = act.v[j * scorerH + o]!;
      const dv = dS * model.scorerW2[o]! * (1 - vj * vj);
      dV[j * scorerH + o] = dv;
      grads.scorerW2[o]! += dS * vj;
      for (let d = 0; d < scorerIn; d++) {
        grads.scorerW1[o * scorerIn + d]! += dv * act.u[row + d]!;
        dU[row + d]! += model.scorerW1[o * scorerIn + d]! * dv;
      }
      grads.scorerB1[o]! += dv;
    }
  }
  grads.scorerB2 += gb2;

  // pool + encoder backward
  const dPool = scratch.dPool;
  dPool.fill(0);
  for (let j = 0; j < C; j++) {
    const row = j * scorerIn + dim;
    for (let p = 0; p < poolDim; p++) {
      dPool[p]! += dU[row + p]!;
    }
  }
  const seed = pair.seed;
  for (let k = 0; k < seed.length; k++) {
    const weight = seed[k]!.count / act.total;
    const gBase = k * encH;
    const hBase = k * poolDim;
    const f = seed[k]!.features;
    for (let p = 0; p < poolDim; p++) {
      const h = act.h[hBase + p]!;
      const db2 = weight * dPool[p]! * (1 - h * h);
      grads.encB2[p]! += db2;
      for (let un = 0; un < encH; un++) {
        const g = act.g[gBase + un]!;
        grads.encW2[p * encH + un]! += db2 * g;
        // the layer-1 gradient contribution of pool output p (the total
        // layer-1 gradient sums this across p)
        const da = model.encW2[p * encH + un]! * db2 * (1 - g * g);
        grads.encB1[un]! += da;
        for (let i = 0; i < dim; i++) {
          grads.encW1[un * dim + i]! += da * f[i]!;
        }
      }
    }
  }
  return { loss, hit };
}

/** single-pair cross-entropy loss (diagnostics, finite-difference checks) */
export function pairLoss(model: DeepSetsModel, pair: TrainingPair): number {
  const { act, scratch } = allocFor([pair]);
  return runPair(model, pair, act, scratch, null).loss;
}

/** single-pair loss + analytic gradients (finite-difference checks) */
export function pairLossAndGradients(
  model: DeepSetsModel,
  pair: TrainingPair,
): { loss: number; grads: ModelGradients } {
  const { act, scratch } = allocFor([pair]);
  const grads = zeroGradients();
  const { loss } = runPair(model, pair, act, scratch, grads);
  return { loss, grads };
}

/**
 * Full-batch gradient descent with early stopping on holdout loss (ranker
 * trainMlp pattern, generalized to softmax CE over per-pair candidate sets).
 * Deterministic: seeded init, fixed iteration order, no Math.random.
 */
export function trainModel(
  trainPairs: readonly TrainingPair[],
  holdoutPairs: readonly TrainingPair[],
  opts: TrainOptions = {},
): TrainResult {
  const lr = opts.lr ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;
  const maxEpochs = opts.maxEpochs ?? 400;
  const evalEvery = Math.max(1, opts.evalEvery ?? 5);
  const patience = opts.patience ?? 8;
  const seed = opts.seed ?? DEFAULT_TRAIN_SEED;
  const model = createModel(seed);

  const { act, scratch } = allocFor([...trainPairs, ...holdoutPairs]);
  const grads = zeroGradients();

  /** summed loss / hit rate over a pair set, optionally accumulating grads */
  const pass = (
    pairs: readonly TrainingPair[],
    accumulate: boolean,
  ): { loss: number; hits: number } => {
    let loss = 0;
    let hits = 0;
    if (accumulate) {
      grads.encW1.fill(0);
      grads.encB1.fill(0);
      grads.encW2.fill(0);
      grads.encB2.fill(0);
      grads.scorerW1.fill(0);
      grads.scorerB1.fill(0);
      grads.scorerW2.fill(0);
      grads.scorerB2 = 0;
    }
    for (const pair of pairs) {
      const result = runPair(
        model,
        pair,
        act,
        scratch,
        accumulate ? grads : null,
      );
      loss += result.loss;
      hits += result.hit ? 1 : 0;
    }
    return {
      loss: loss / Math.max(1, pairs.length),
      hits: hits / Math.max(1, pairs.length),
    };
  };

  let best = {
    holdoutLoss: Number.POSITIVE_INFINITY,
    model: snapshotModel(model),
    epoch: 0,
    trainLoss: Number.NaN,
    trainAccuracy: Number.NaN,
    holdoutAccuracy: Number.NaN,
  };
  let evalsSinceBest = 0;
  let epochsRun = 0;
  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    epochsRun = epoch + 1;
    const { loss: trainLoss, hits: trainAccuracy } = pass(trainPairs, true);
    const scale = lr / Math.max(1, trainPairs.length);
    applyGradients(model, grads, scale, l2);
    const isEval = (epoch + 1) % evalEvery === 0 || epoch === maxEpochs - 1;
    if (!isEval) continue;
    const { loss: holdoutLoss, hits: holdoutAccuracy } = pass(
      holdoutPairs,
      false,
    );
    if (holdoutLoss < best.holdoutLoss) {
      best = {
        holdoutLoss,
        model: snapshotModel(model),
        epoch: epochsRun,
        trainLoss,
        trainAccuracy,
        holdoutAccuracy,
      };
      evalsSinceBest = 0;
    } else {
      evalsSinceBest++;
      if (evalsSinceBest >= patience) break;
    }
  }

  restoreModel(model, best.model);
  return {
    model,
    evidence: {
      epochsRun,
      bestEpoch: best.epoch,
      trainLoss: round4(best.trainLoss),
      trainAccuracy: round4(best.trainAccuracy),
      holdoutLoss: round4(best.holdoutLoss),
      holdoutAccuracy: round4(best.holdoutAccuracy),
      hyper: { lr, l2, maxEpochs, evalEvery, patience, seed },
    },
  };
}

function applyGradients(
  model: DeepSetsModel,
  grads: ModelGradients,
  scale: number,
  l2: number,
): void {
  for (let i = 0; i < model.encW1.length; i++) {
    model.encW1[i]! -= scale * (grads.encW1[i]! + l2 * model.encW1[i]!);
  }
  for (let i = 0; i < model.encB1.length; i++) {
    model.encB1[i]! -= scale * grads.encB1[i]!;
  }
  for (let i = 0; i < model.encW2.length; i++) {
    model.encW2[i]! -= scale * (grads.encW2[i]! + l2 * model.encW2[i]!);
  }
  for (let i = 0; i < model.encB2.length; i++) {
    model.encB2[i]! -= scale * grads.encB2[i]!;
  }
  for (let i = 0; i < model.scorerW1.length; i++) {
    model.scorerW1[i]! -=
      scale * (grads.scorerW1[i]! + l2 * model.scorerW1[i]!);
  }
  for (let i = 0; i < model.scorerB1.length; i++) {
    model.scorerB1[i]! -= scale * grads.scorerB1[i]!;
  }
  for (let i = 0; i < model.scorerW2.length; i++) {
    model.scorerW2[i]! -=
      scale * (grads.scorerW2[i]! + l2 * model.scorerW2[i]!);
  }
  model.scorerB2 -= scale * grads.scorerB2;
}

function argmax(values: Float64Array, length: number): number {
  let best = 0;
  for (let i = 1; i < length; i++) {
    if (values[i]! > values[best]!) best = i;
  }
  return best;
}

// ---- candidate construction (corpus pair → training row) ----

export interface ExampleContext {
  byId: Map<number, Card>;
  /** feature vector per card id (computed once via features.cardFeatures) */
  featuresById: Map<number, Float64Array>;
  /** the negative-sampling universe: every committed card id, sorted */
  poolIds: number[];
  format: Format;
  negativesPerPair: number;
}

/**
 * Per-pair RNG seed: FNV-1a over the pair's stable identity (deck + seed +
 * target composition), so negative draws survive corpus re-emission and pair
 * reordering. Same hashing scheme as corpus.sampleSeedFor.
 */
export function pairTrainingSeed(
  corpusSeed: number,
  pair: MaskedElitesPair | RestrictedPair,
): number {
  let hash = (corpusSeed ^ 2166136261) >>> 0;
  const text = `${pair.deckId}#${stableDeckKey(pair.seed)}#${stableDeckKey(pair.target)}`;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The seed deck's current ink state: the distinct inks of its cards in
 * canonical INKS order (card-first creation declares inks as cards are
 * added). Legal decks never span more than two inks; a corpus pair that does
 * is malformed and fails loudly.
 */
export function seedInkState(
  seedIds: readonly number[],
  byId: Map<number, Card>,
): Ink[] {
  const present = new Set<Ink>();
  for (const id of seedIds) {
    const card = byId.get(id);
    if (!card) throw new Error(`unknown card id in seed: ${id}`);
    for (const ink of card.inks) present.add(ink);
  }
  const ordered = INKS.filter((ink) => present.has(ink));
  if (ordered.length > 2) {
    throw new Error(`seed spans ${ordered.length} inks — malformed deck`);
  }
  return ordered;
}

/**
 * Sampled pool negatives for one pair: seeded, excluding seed/target ids,
 * canAddCard-checked against the seed (ink state + copy limits + format) so
 * the training view matches the inference-time candidate mask (D4).
 */
export function sampleNegatives(opts: {
  seedCounts: Record<number, number>;
  seedIds: Set<number>;
  targetIds: Set<number>;
  ctx: ExampleContext;
  count: number;
  rng: () => number;
}): number[] {
  const deck: DeckState = {
    title: 'training-view',
    format: opts.ctx.format,
    inks: seedInkState([...opts.seedIds], opts.ctx.byId),
    cards: opts.seedCounts,
  };
  const picked: number[] = [];
  // seeded Fisher–Yates over the pool, take the first `count` that pass —
  // deterministic for the pair's rng
  const order = [...opts.ctx.poolIds];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(opts.rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const id of order) {
    if (picked.length >= opts.count) break;
    if (opts.seedIds.has(id) || opts.targetIds.has(id)) continue;
    const card = opts.ctx.byId.get(id);
    if (!card || !canAddCard(deck, card, opts.ctx.byId).ok) continue;
    picked.push(id);
  }
  return picked;
}

/** corpus imitation pair → training row (positives first, then negatives) */
export function buildImitationExample(
  pair: MaskedElitesPair | RestrictedPair,
  ctx: ExampleContext,
  rng: () => number,
): TrainingPair {
  const positiveIds = Object.keys(pair.target)
    .map(Number)
    .sort((a, b) => a - b);
  const seedIds = new Set(Object.keys(pair.seed).map(Number));
  const targetIds = new Set(positiveIds);
  const seedCounts: Record<number, number> = {};
  for (const [id, count] of Object.entries(pair.seed)) {
    seedCounts[Number(id)] = count;
  }
  const negativeIds = sampleNegatives({
    seedCounts,
    seedIds,
    targetIds,
    ctx,
    count: ctx.negativesPerPair,
    rng,
  });
  const seed: SeedCard[] = Object.keys(pair.seed)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => ({
      features: requireFeatures(id, ctx),
      count: pair.seed[String(id)]!,
    }));
  const candidateFeatures = [...positiveIds, ...negativeIds].map((id) =>
    requireFeatures(id, ctx),
  );
  return {
    seed,
    candidateFeatures,
    positiveIndices: positiveIds.map((_, index) => index),
  };
}

function requireFeatures(id: number, ctx: ExampleContext): Float64Array {
  const features = ctx.featuresById.get(id);
  if (!features) throw new Error(`unknown card id in corpus pair: ${id}`);
  return features;
}

export interface CorpusExamples {
  train: TrainingPair[];
  holdout: TrainingPair[];
  /** per-stratum pair counts; trained + holdout + skipped = pairs */
  strata: Record<
    CorpusStratum,
    { pairs: number; trained: number; holdout: number; skipped: number }
  >;
  totalPairs: number;
}

/**
 * Split a corpus into training rows. Imitation strata (masked-elites,
 * restricted) share the (seed → target) shape and both train;
 * substitution-delta pairs carry an arena-measured Δ that would need
 * advantage weighting the gate has not pre-committed — they are counted as
 * skipped so the artifact's evidence stays honest until that lands.
 */
export function examplesFromCorpus(
  corpus: Corpus,
  ctx: ExampleContext,
  corpusSeed: number = DEFAULT_TRAIN_SEED,
): CorpusExamples {
  const holdoutKeys = new Set(corpus.holdoutCellKeys);
  const strata = Object.fromEntries(
    STRATUM_ORDER.map((stratum) => [
      stratum,
      { pairs: 0, trained: 0, holdout: 0, skipped: 0 },
    ]),
  ) as Record<
    CorpusStratum,
    { pairs: number; trained: number; holdout: number; skipped: number }
  >;
  const train: TrainingPair[] = [];
  const holdout: TrainingPair[] = [];
  for (const pair of corpus.pairs) {
    const bucket = holdoutKeys.has(pair.cellKey) ? holdout : train;
    const stats = strata[pair.stratum];
    stats.pairs++;
    if (pair.stratum === 'masked-elites' || pair.stratum === 'restricted') {
      const rng = mulberry32(pairTrainingSeed(corpusSeed, pair));
      bucket.push(buildImitationExample(pair, ctx, rng));
      if (bucket === holdout) stats.holdout++;
      else stats.trained++;
    } else {
      stats.skipped++;
    }
  }
  return { train, holdout, strata, totalPairs: corpus.pairs.length };
}

// ---- int16 quantization (meta-model artifact precedent, D3) ----

export const QUANTIZATION = 'int16-le' as const;

export interface QuantizedTensor {
  shape: number[];
  /** little-endian int16 payload, base64 */
  b64: string;
  /** decoded = int16 × scale */
  scale: number;
}

export interface QuantizedWeights {
  quantization: typeof QUANTIZATION;
  tensors: Record<string, QuantizedTensor>;
}

/** tensor shapes of the artifact's weights block, keyed by model field */
export const TENSOR_SHAPES: Record<string, number[]> = {
  encW1: [ENCODER_HIDDEN, FEATURE_DIM],
  encB1: [ENCODER_HIDDEN],
  encW2: [POOL_DIM, ENCODER_HIDDEN],
  encB2: [POOL_DIM],
  scorerW1: [SCORER_HIDDEN, SCORER_INPUT_DIM],
  scorerB1: [SCORER_HIDDEN],
  scorerW2: [SCORER_HIDDEN],
  scorerB2: [1],
};

const MODEL_KEYS = Object.keys(TENSOR_SHAPES) as Array<keyof DeepSetsModel>;

function quantizeTensor(
  values: Float64Array | number,
  shape: number[],
): QuantizedTensor {
  const flat =
    typeof values === 'number'
      ? Float64Array.of(values)
      : Float64Array.from(values);
  let maxAbs = 0;
  for (const v of flat) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
  const buf = new ArrayBuffer(flat.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < flat.length; i++) {
    view.setInt16(
      i * 2,
      Math.max(-32768, Math.min(32767, Math.round(flat[i]! / scale))),
      true,
    );
  }
  return { shape, b64: Buffer.from(buf).toString('base64'), scale };
}

/** per-tensor int16 quantization with scale (relations-capability precedent) */
export function quantizeModel(model: DeepSetsModel): QuantizedWeights {
  const tensors: Record<string, QuantizedTensor> = {};
  for (const key of MODEL_KEYS) {
    tensors[key] = quantizeTensor(
      model[key] as Float64Array | number,
      TENSOR_SHAPES[key]!,
    );
  }
  return { quantization: QUANTIZATION, tensors };
}

/** dequantize an artifact weights block back into a runnable model */
export function dequantizeModel(weights: QuantizedWeights): DeepSetsModel {
  if (weights.quantization !== QUANTIZATION) {
    throw new Error(
      `unsupported quantization: ${String(weights.quantization)}`,
    );
  }
  const tensors = weights.tensors ?? {};
  const decode = (key: string): Float64Array => {
    const tensor = tensors[key];
    if (!tensor) throw new Error(`missing quantized tensor: ${key}`);
    const expected = TENSOR_SHAPES[key]!;
    if (
      !Array.isArray(tensor.shape) ||
      tensor.shape.length !== expected.length ||
      tensor.shape.some((d, i) => d !== expected[i])
    ) {
      throw new Error(`tensor ${key} shape mismatch`);
    }
    const buf = Buffer.from(tensor.b64, 'base64');
    if (buf.length !== expected.reduce((a, b) => a * b, 1) * 2) {
      throw new Error(`tensor ${key} payload size mismatch`);
    }
    const out = new Float64Array(buf.length / 2);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < out.length; i++) {
      out[i] = view.getInt16(i * 2, true) * tensor.scale;
    }
    return out;
  };
  return {
    encW1: decode('encW1'),
    encB1: decode('encB1'),
    encW2: decode('encW2'),
    encB2: decode('encB2'),
    scorerW1: decode('scorerW1'),
    scorerB1: decode('scorerB1'),
    scorerW2: decode('scorerW2'),
    scorerB2: decode('scorerB2')[0]!,
  };
}
