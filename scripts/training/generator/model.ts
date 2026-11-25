/**
 * Pure-TS DeepSets completion model (learned-deck-generator, tasks 3.1/6.2;
 * design D2/D2b; spec learned-deck-completion "Quantized model artifact").
 *
 * Architecture (D2b sizing, amended to signed feature hashing — 34,529 params):
 *
 *   encoder  per-card MLP 699 → 32 → 16, tanh on both layers
 *   pool     masked mean over the seed deck's card vectors, weighted by
 *            copy count (counts are weights)
 *   scorer   MLP over [candidate features (699) ⊕ candidate↔seed
 *            interactions (8) ⊕ pooled context (16)] → 16 → 1 scalar,
 *            tanh hidden layer
 *
 * Candidates carry their interaction dims (D2b: nameOverlap, shiftMatch,
 * refNameMatch, nameTargetMatch, traitEngineMatch, traitTargetMatch,
 * selfRefTrait, typeRefMatch — computed from card data by features.ts,
 * per-identity profiles + a per-pair seed aggregate). The base feature
 * vectors stay shared per identity; only the 8-dim interaction block is
 * pair-specific, so corpus rows stay lean (≈100 bytes of pair-specific data
 * instead of a 707-dim copy per candidate).
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
import {
  allocActivations,
  type DeepSetsModel,
  forwardPair,
  type PairActivations,
  type SeedCard,
  scoreCandidates,
  TENSOR_SHAPES,
  type TrainingCandidate,
} from '../../../src/shared/deepsets';
import { mulberry32 } from '../prng';
import type { Corpus, CorpusStratum } from './corpus';
import {
  COVERAGE_TRAIN_WEIGHT,
  type ImitationPair,
  STRATUM_ORDER,
  type SubstitutionDeltaPair,
  stableDeckKey,
} from './corpus';
import {
  CANDIDATE_DIM,
  type CardInteractionProfile,
  ENCODER_HIDDEN,
  FEATURE_DIM,
  interactionDims,
  POOL_DIM,
  SCORER_HIDDEN,
  SCORER_INPUT_DIM,
  type SeedInteractionAggregate,
  seedInteractionAggregate,
} from './features';

/**
 * D2a pre-committed noise floor: substitution pairs whose measured |Δ| falls
 * below this contribute nothing (skipped), per design D2a.
 */
export const DELTA_NOISE_FLOOR = 0.02;

// ---- architecture ----

// re-exported from the shared feature layer so the runtime and trainer agree
// The forward pass and tensor metadata live in src/shared so the runtime and
// trainer share a single implementation.
export {
  allocActivations,
  CANDIDATE_DIM,
  type DeepSetsModel,
  ENCODER_HIDDEN,
  forwardPair,
  type PairActivations,
  POOL_DIM,
  SCORER_HIDDEN,
  SCORER_INPUT_DIM,
  type SeedCard,
  scoreCandidates,
  TENSOR_SHAPES,
  type TrainingCandidate,
};

/** sampled pool negatives per pair (task 3.1: ~16) */
export const DEFAULT_NEGATIVES_PER_PAIR = 16;
/** master training seed (the change's pre-committed seed) */
export const DEFAULT_TRAIN_SEED = 20261123;

/** total trainable parameters; asserted by test (D2b: ~33k, ≤ 100 KB quantized) */
export const PARAM_COUNT =
  ENCODER_HIDDEN * FEATURE_DIM +
  ENCODER_HIDDEN +
  POOL_DIM * ENCODER_HIDDEN +
  POOL_DIM +
  SCORER_HIDDEN * SCORER_INPUT_DIM +
  SCORER_HIDDEN +
  SCORER_HIDDEN +
  1;

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

// ---- training ----

/**
 * One softmax cross-entropy row: candidate set + positive indices. `weight`
 * scales the pair's contribution to loss and gradients (D2a/D1b): 1 for
 * gated imitation pairs, COVERAGE_TRAIN_WEIGHT for sweep pairs, |Δ| for
 * substitution pairs. Undefined means weight 1.
 */
export interface TrainingPair {
  seed: SeedCard[];
  candidates: TrainingCandidate[];
  /** indices into candidates of the positives (uniform target) */
  positiveIndices: number[];
  /** contribution multiplier for loss and gradients (default 1) */
  weight?: number;
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
    maxCandidates = Math.max(maxCandidates, pair.candidates.length);
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
  const C = pair.candidates.length;
  if (C === 0 || pair.positiveIndices.length === 0) {
    return { loss: 0, hit: false };
  }
  // hot-loop alias: imported bindings are proxy reads under vitest's module
  // runner — keep them out of the inner loops
  const dim = FEATURE_DIM;
  const candidateDim = CANDIDATE_DIM;
  const encH = ENCODER_HIDDEN;
  const poolDim = POOL_DIM;
  const scorerH = SCORER_HIDDEN;
  const scorerIn = SCORER_INPUT_DIM;
  forwardPair(model, pair.seed, pair.candidates, act);

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
  const weight = pair.weight ?? 1;
  let loss = 0;
  for (let j = 0; j < C; j++) {
    const p = scratch.exp[j]! / sumExp;
    act.scores[j] = p; // scores now hold probabilities
    if (positives.has(j)) loss -= Math.log(Math.max(p, 1e-12));
  }
  loss *= invK * weight;
  const hit = positives.has(argmax(act.scores, C));
  if (!grads) return { loss, hit };

  // scorer backward: W1 grads accumulate only at the candidate's nonzero
  // input positions (zero terms contribute nothing); dU collects just the
  // pool-path input gradient — the feature/interaction slices of dU have no
  // downstream consumer (candidates do not pass through the encoder)
  const dV = scratch.dV;
  const dU = scratch.dU;
  dU.fill(0, 0, C * scorerIn);
  let gb2 = 0;
  for (let j = 0; j < C; j++) {
    const row = j * scorerIn;
    const nz = pair.candidates[j]!.nz!;
    // pair weight scales the gradient contribution (D2a/D1b)
    const dS = (act.scores[j]! - (positives.has(j) ? invK : 0)) * weight;
    gb2 += dS;
    for (let o = 0; o < scorerH; o++) {
      const vj = act.v[j * scorerH + o]!;
      const dv = dS * model.scorerW2[o]! * (1 - vj * vj);
      dV[j * scorerH + o] = dv;
      grads.scorerW2[o]! += dS * vj;
      const wRow = o * scorerIn;
      for (let n = 0; n < nz.length; n++) {
        const d = nz[n]!;
        grads.scorerW1[wRow + d]! += dv * act.u[row + d]!;
      }
      for (let p = 0; p < poolDim; p++) {
        dU[row + candidateDim + p]! +=
          model.scorerW1[wRow + candidateDim + p]! * dv;
      }
      grads.scorerB1[o]! += dv;
    }
  }
  grads.scorerB2 += gb2;

  // pool + encoder backward (the pool slice of u sits past the candidate
  // block: features ⊕ interactions ⊕ pool)
  const dPool = scratch.dPool;
  dPool.fill(0);
  for (let j = 0; j < C; j++) {
    const row = j * scorerIn + candidateDim;
    for (let p = 0; p < poolDim; p++) {
      dPool[p]! += dU[row + p]!;
    }
  }
  const seed = pair.seed;
  for (let k = 0; k < seed.length; k++) {
    const card = seed[k]!;
    const weight = card.count / act.total;
    const gBase = k * encH;
    const hBase = k * poolDim;
    const f = card.features;
    const nz = card.nz!;
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
        const wRow = un * dim;
        for (let n = 0; n < nz.length; n++) {
          const i = nz[n]!;
          grads.encW1[wRow + i]! += da * f[i]!;
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
  /** interaction profile per card id (features.cardInteractionProfile) */
  profilesById: Map<number, CardInteractionProfile>;
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
  pair: ImitationPair,
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
  pair: ImitationPair,
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
  const aggregate = seedInteractionAggregate(
    [...seedIds].map((id) => requireProfile(id, ctx)),
  );
  return {
    seed,
    candidates: [...positiveIds, ...negativeIds].map((id) =>
      candidateInput(id, ctx, aggregate),
    ),
    positiveIndices: positiveIds.map((_, index) => index),
  };
}

function requireFeatures(id: number, ctx: ExampleContext): Float64Array {
  const features = ctx.featuresById.get(id);
  if (!features) throw new Error(`unknown card id in corpus pair: ${id}`);
  return features;
}

function requireProfile(
  id: number,
  ctx: ExampleContext,
): CardInteractionProfile {
  const profile = ctx.profilesById.get(id);
  if (!profile) throw new Error(`unknown card id in corpus pair: ${id}`);
  return profile;
}

/** one candidate row: shared features ⊕ pair-specific interaction dims */
function candidateInput(
  id: number,
  ctx: ExampleContext,
  aggregate: SeedInteractionAggregate,
): TrainingCandidate {
  return {
    features: requireFeatures(id, ctx),
    interactions: interactionDims(requireProfile(id, ctx), aggregate),
  };
}

/**
 * Substitution-delta pair → training row (D2a): the context deck minus
 * cardOut is the seed; cardIn and cardOut are explicit candidates alongside
 * sampled pool negatives. Δ > 0 → cardIn is the positive with pair weight Δ;
 * Δ < 0 → cardOut is the positive (keep what you have) and cardIn must lose,
 * with pair weight |Δ|. Illegal candidates fail loudly — legality is never
 * learned.
 */
export function buildDeltaExample(
  pair: SubstitutionDeltaPair,
  ctx: ExampleContext,
  rng: () => number,
): TrainingPair {
  const seedIds = new Set(Object.keys(pair.context).map(Number));
  const seedCounts: Record<number, number> = {};
  for (const [id, count] of Object.entries(pair.context)) {
    seedCounts[Number(id)] = count;
  }
  const cardIn = Number(pair.cardIn);
  const cardOut = Number(pair.cardOut);
  // cardIn enters the deck: it must be legal in the swapped deck (context +
  // candidate), whose declared inks are the union of both sides' inks —
  // seedInkState throws past two inks, an illegal swap. cardOut is already
  // in the deck (buildCorpus validated the context shape), so it needs no
  // fresh legality check.
  const cardInCard = ctx.byId.get(cardIn);
  if (!cardInCard) throw new Error(`unknown card id in delta pair: ${cardIn}`);
  const swapDeck: DeckState = {
    title: 'training-view',
    format: ctx.format,
    inks: seedInkState([...seedIds, cardIn], ctx.byId),
    cards: seedCounts,
  };
  if (!canAddCard(swapDeck, cardInCard, ctx.byId).ok) {
    throw new Error(
      `delta pair ${pair.deckId}: candidate ${cardIn} is illegal in the context`,
    );
  }
  const positiveId = pair.delta > 0 ? cardIn : cardOut;
  const negativeIds = sampleNegatives({
    seedCounts,
    seedIds,
    targetIds: new Set([cardIn, cardOut]),
    ctx,
    count: ctx.negativesPerPair,
    rng,
  });
  // candidates: positive first, then the remaining explicit candidate, then
  // sampled negatives (same ordering convention as buildImitationExample)
  const candidateIds = [
    positiveId,
    positiveId === cardIn ? cardOut : cardIn,
    ...negativeIds,
  ];
  const seed: SeedCard[] = Object.keys(pair.context)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => ({
      features: requireFeatures(id, ctx),
      count: pair.context[String(id)]!,
    }));
  const aggregate = seedInteractionAggregate(
    [...seedIds].map((id) => requireProfile(id, ctx)),
  );
  return {
    seed,
    candidates: candidateIds.map((id) => candidateInput(id, ctx, aggregate)),
    positiveIndices: [0],
    weight: Math.abs(pair.delta),
  };
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
 * Split a corpus into training rows across all five strata. Imitation pairs
 * (masked-elites, restricted, pool-slice) train at weight 1; coverage pairs
 * at the pre-committed COVERAGE_TRAIN_WEIGHT; substitution-delta pairs train
 * under D2a advantage weighting — |Δ| < DELTA_NOISE_FLOOR is skipped so the
 * artifact's evidence stays honest.
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
    if (pair.stratum === 'substitution-delta') {
      if (Math.abs(pair.delta) < DELTA_NOISE_FLOOR) {
        stats.skipped++;
        continue;
      }
      const rng = mulberry32(
        pairTrainingSeed(corpusSeed, {
          stratum: 'masked-elites',
          deckId: pair.deckId,
          cellKey: pair.cellKey,
          seed: pair.context,
          target: { [pair.cardIn]: 1 },
        }),
      );
      bucket.push(buildDeltaExample(pair, ctx, rng));
      if (bucket === holdout) stats.holdout++;
      else stats.trained++;
    } else {
      const rng = mulberry32(pairTrainingSeed(corpusSeed, pair));
      const example = buildImitationExample(pair, ctx, rng);
      if (pair.stratum === 'coverage') example.weight = COVERAGE_TRAIN_WEIGHT;
      bucket.push(example);
      if (bucket === holdout) stats.holdout++;
      else stats.trained++;
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
