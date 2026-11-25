import {
  CANDIDATE_DIM,
  ENCODER_HIDDEN,
  FEATURE_DIM,
  INTERACTION_DIM,
  POOL_DIM,
  SCORER_HIDDEN,
  SCORER_INPUT_DIM,
} from './card-features';

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

export interface SeedCard {
  features: Float64Array;
  count: number;
  /**
   * Ascending nonzero feature indices, memoized by the forward pass (the
   * sparse encoder path — v2 vectors are ~98% zeros, and skipping exact
   * zero terms in ascending order is bit-identical to the dense sum).
   */
  nz?: Uint32Array;
}

/**
 * One candidate row: the shared per-identity feature vector (FEATURE_DIM)
 * plus the pair-specific interaction dims vs the seed (INTERACTION_DIM).
 * Split so the 667-dim block is shared, not copied per pair.
 */
export interface TrainingCandidate {
  features: Float64Array;
  interactions: Float64Array;
  /**
   * Ascending nonzero positions over [features ⊕ interactions] (0-based;
   * the pool block is handled inline) — memoized by the forward pass.
   */
  nz?: Uint32Array;
}

/** tensor shapes of the weights block, keyed by model field */
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

/** per-pair activations kept between forward and backward */
export interface PairActivations {
  g: Float64Array; // S × ENCODER_HIDDEN, tanh(W1e f + b1e)
  h: Float64Array; // S × POOL_DIM, tanh(W2e g + b2e)
  pool: Float64Array; // POOL_DIM
  u: Float64Array; // C × SCORER_INPUT_DIM ([candidate ⊕ pool])
  v: Float64Array; // C × SCORER_HIDDEN
  scores: Float64Array; // C
  /** Σ copy counts of the seed deck (the pool's normalizer) */
  total: number;
}

/** ascending nonzero indices of `values` (offset-shifted when offset > 0) */
function nonzeroIndices(values: Float64Array, offset = 0): Uint32Array {
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 0) count++;
  }
  const out = new Uint32Array(count);
  let at = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== 0) out[at++] = i + offset;
  }
  return out;
}

/** scratch activations sized for a batch of pairs */
export function allocActivations(
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
 * Shared forward pass: encoder + masked-mean pool + scorer.
 * The exact loop order and activation layout are pinned so the training
 * gradient pass, the trainer's inference, and the runtime site inference all
 * produce byte-identical results for the same weights and rows.
 */
export function forwardPair(
  model: DeepSetsModel,
  seed: readonly SeedCard[],
  candidates: readonly TrainingCandidate[],
  act: PairActivations,
): void {
  const S = seed.length;
  const C = candidates.length;
  const { g, h, pool, u, v, scores } = act;
  // local alias: under vitest's module runner, imported bindings turn into
  // proxy property reads — fatal in a hot loop
  const dim = FEATURE_DIM;
  const candidateDim = CANDIDATE_DIM;
  const interactionDim = INTERACTION_DIM;

  // encoder + masked mean pool (copy counts as weights); an empty seed deck
  // pools to the zero vector — the caller picks legal candidates, so this
  // only arises for degenerate inputs. The sparse path skips exact zero
  // features in ascending order — bit-identical to the dense sum.
  let total = 0;
  for (const card of seed) total += card.count;
  act.total = total;
  pool.fill(0);
  for (let k = 0; k < S; k++) {
    const card = seed[k]!;
    const f = card.features;
    if (card.nz === undefined) card.nz = nonzeroIndices(f);
    const nz = card.nz;
    const gBase = k * ENCODER_HIDDEN;
    for (let un = 0; un < ENCODER_HIDDEN; un++) {
      let a = model.encB1[un]!;
      const wBase = un * dim;
      for (let n = 0; n < nz.length; n++) {
        const i = nz[n]!;
        a += model.encW1[wBase + i]! * f[i]!;
      }
      g[gBase + un] = Math.tanh(a);
    }
    const hBase = k * POOL_DIM;
    const weight = card.count / total;
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

  // scorer over [candidate features ⊕ interactions ⊕ pooled context]
  for (let j = 0; j < C; j++) {
    const row = j * SCORER_INPUT_DIM;
    const candidate = candidates[j]!;
    const features = candidate.features;
    const interactions = candidate.interactions;
    if (candidate.nz === undefined) {
      const featureNz = nonzeroIndices(features);
      const interactionNz = nonzeroIndices(interactions, dim);
      const merged = new Uint32Array(featureNz.length + interactionNz.length);
      merged.set(featureNz);
      merged.set(interactionNz, featureNz.length);
      candidate.nz = merged;
    }
    const nz = candidate.nz;
    for (let n = 0; n < nz.length; n++) {
      const i = nz[n]!;
      u[row + i] = i < dim ? features[i]! : interactions[i - dim]!;
    }
    for (let i = 0; i < interactionDim; i++) {
      u[row + dim + i] = interactions[i]!;
    }
    for (let p = 0; p < POOL_DIM; p++) {
      u[row + candidateDim + p] = pool[p]!;
    }
    let s = model.scorerB2;
    for (let o = 0; o < SCORER_HIDDEN; o++) {
      let z = model.scorerB1[o]!;
      const wRow = o * SCORER_INPUT_DIM;
      for (let n = 0; n < nz.length; n++) {
        const d = nz[n]!;
        z += model.scorerW1[wRow + d]! * u[row + d]!;
      }
      for (let p = 0; p < POOL_DIM; p++) {
        const pooled = pool[p]!;
        if (pooled !== 0)
          z += model.scorerW1[wRow + candidateDim + p]! * pooled;
      }
      const vv = Math.tanh(z);
      v[j * SCORER_HIDDEN + o] = vv;
      s += model.scorerW2[o]! * vv;
    }
    scores[j] = s;
  }
}

/**
 * Inference API: score each candidate given the seed deck. The candidate set
 * must already be legality-masked by the caller (D4: legality is never
 * learned). Deterministic; the exact forward path training uses.
 */
export function scoreCandidates(
  model: DeepSetsModel,
  seedDeck: readonly SeedCard[],
  candidates: readonly TrainingCandidate[],
): Float64Array {
  const scores = new Float64Array(candidates.length);
  if (candidates.length === 0) return scores;
  const act = allocActivations(Math.max(1, seedDeck.length), candidates.length);
  forwardPair(model, seedDeck, candidates, act);
  scores.set(act.scores.subarray(0, candidates.length));
  return scores;
}
