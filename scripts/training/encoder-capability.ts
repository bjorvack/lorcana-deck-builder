import type { Card } from '../../src/data/types';
import {
  cardTextVector,
  type TextFeatureVocab,
  textFeatureVocab,
} from '../../src/meta/score';
import type { TrainRow } from './model-types';

/**
 * Inductive card encoder (M2 close-out): a ridge regression from the client's
 * text-feature space onto the SGNS relation space, letting cards without
 * tournament history join the trusted relation fusion ("day-zero suggestions").
 *
 * Gate (temporal, mirroring the house style): the encoder trains on cards
 * first seen in tournament rows up to a cutoff and is evaluated on cards that
 * debuted AFTER it — mean cosine(predicted, observed) must beat the
 * mean-vector baseline (the best possible prediction with no content
 * information) by the house factor. A gate failure means content does not
 * yet predict the relation space and the encoder ships off.
 *
 * Determinism: closed-form ridge solve (Gauss–Jordan with partial pivoting),
 * no randomness.
 */

export const ENCODER_THRESHOLD = 1.1;
const RIDGE_LAMBDA = 1.0;

export interface EncoderGateMetrics {
  metric: 'holdout_cosine_ratio';
  /** mean cosine(predicted, observed) on post-cutoff debut cards */
  value: number;
  /** mean cosine(mean train vector, observed) — the no-content baseline */
  random: number;
  threshold: number;
  passed: boolean;
  trainCards: number;
  evalCards: number;
  textDim: number;
  dim: number;
}

export interface EncoderPayload {
  version: '1';
  /** client text-feature dimensionality (rows of W) */
  textDim: number;
  /** relation dimensionality (columns of W) */
  dim: number;
  /** int8 decode: weight = byte / scale */
  scale: number;
  /** (textDim + 1) × dim int8-le weights, row-major; last row = bias */
  weightsB64: string;
}

export interface EncoderOutput {
  passed: boolean;
  payload: EncoderPayload;
  metrics: EncoderGateMetrics;
}

export interface EncoderCapabilityInput {
  rows: TrainRow[];
  cards: Card[];
  /** SGNS vectors keyed by canonical card id (from the relations capability) */
  vectors: Map<number, Float64Array>;
  /** era cutoff for the temporal split (YYYY-MM-DD, inclusive on train side) */
  cutoffDate: string;
}

interface VectorPair {
  features: Float64Array;
  observed: Float64Array;
}

export function encoderCapability(input: EncoderCapabilityInput): {
  encoder: EncoderOutput;
} {
  const { rows, cards, vectors, cutoffDate } = input;
  const vocab: TextFeatureVocab = textFeatureVocab(cards);
  const dim = vectors.size > 0 ? vectors.values().next().value!.length : 0;

  // first tournament appearance per canonical card id
  const firstSeen = new Map<number, string>();
  for (const row of rows) {
    for (const id of row.counts.keys()) {
      const known = firstSeen.get(id);
      if (known === undefined || row.date < known) firstSeen.set(id, row.date);
    }
  }

  const train: VectorPair[] = [];
  const evalPairs: VectorPair[] = [];
  for (const card of cards) {
    const canonicalId = card.id; // rows are already canonicalized
    const observed = vectors.get(canonicalId);
    if (!observed) continue; // never in tournament decks: no gate evidence
    const features = cardTextVector(card, vocab);
    const firstDate = firstSeen.get(canonicalId);
    const pair: VectorPair = { features, observed };
    if (firstDate !== undefined && firstDate <= cutoffDate) train.push(pair);
    else evalPairs.push(pair);
  }

  const meanVector = meanOf(
    train.map((p) => p.observed),
    dim,
  );
  const textDim = vocab.dim;

  const solve = (): Array<Float64Array> | null => {
    if (train.length < 30 || dim === 0) return null;
    // X: n × (textDim + 1) with bias column
    const cols = textDim + 1;
    const XtX = new Float64Array(cols * cols).fill(0);
    const XtY = new Float64Array(cols * dim).fill(0);
    for (const { features, observed } of train) {
      for (let i = 0; i < cols; i++) {
        const xi = i < textDim ? features[i]! : 1;
        if (xi === 0) continue;
        for (let j = 0; j < cols; j++) {
          const xj = j < textDim ? features[j]! : 1;
          XtX[i * cols + j]! += xi * xj;
        }
        for (let d = 0; d < dim; d++) XtY[i * dim + d]! += xi * observed[d]!;
      }
    }
    for (let i = 0; i < cols; i++) XtX[i * cols + i]! += RIDGE_LAMBDA;
    return solveSymmetric(XtX, XtY, cols, dim);
  };

  const weights = solve();
  const predict = (features: Float64Array): Float64Array | null => {
    if (!weights) return null;
    const out = new Float64Array(dim);
    for (let d = 0; d < dim; d++) {
      let acc = 0;
      // W is (textDim + 1) rows × dim columns: row i = text feature i,
      // column d = output dimension; last row = bias
      for (let i = 0; i < textDim; i++) acc += features[i]! * weights[i]![d]!;
      acc += weights[textDim]![d]!; // bias
      out[d] = acc;
    }
    return out;
  };

  // a failed solve predicts null for every card: count only computable
  // predictions, and gate on having enough of them
  const evalPredictions = evalPairs
    .map((p) => ({ observed: p.observed, predicted: predict(p.features) }))
    .filter(
      (p): p is { observed: Float64Array; predicted: Float64Array } =>
        p.predicted !== null,
    );
  const value = evalPredictions.length
    ? evalPredictions.reduce(
        (sum, p) => sum + cosine(p.predicted, p.observed),
        0,
      ) / evalPredictions.length
    : 0;
  const random = evalPairs.length
    ? evalPairs.reduce((sum, p) => sum + cosine(meanVector, p.observed), 0) /
      evalPairs.length
    : 0;
  const ratio = random > 1e-9 ? value / random : 0;
  const passed =
    weights !== null &&
    evalPredictions.length >= 10 &&
    ratio >= ENCODER_THRESHOLD &&
    value > 0;

  const metrics: EncoderGateMetrics = {
    metric: 'holdout_cosine_ratio',
    value: round4(value),
    random: round4(random),
    threshold: ENCODER_THRESHOLD,
    passed,
    trainCards: train.length,
    evalCards: evalPredictions.length,
    textDim,
    dim,
  };

  // ---- quantize: (textDim + 1) × dim int8, single global scale ----
  let payload: EncoderPayload = {
    version: '1',
    textDim,
    dim,
    scale: 1,
    weightsB64: '',
  };
  if (passed && weights) {
    let maxAbs = 0;
    for (const rowW of weights)
      for (const w of rowW) maxAbs = Math.max(maxAbs, Math.abs(w));
    const scale = maxAbs > 0 ? maxAbs / 127 : 1;
    const buf = new ArrayBuffer(weights.length * dim);
    const view = new DataView(buf);
    let offset = 0;
    for (const rowW of weights) {
      for (const w of rowW) {
        view.setInt8(
          offset,
          Math.max(-127, Math.min(127, Math.round(w / scale))),
        );
        offset += 1;
      }
    }
    payload = {
      version: '1',
      textDim,
      dim,
      scale: round4(scale),
      weightsB64: Buffer.from(buf).toString('base64'),
    };
  }

  return { encoder: { passed, payload, metrics } };
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function meanOf(vectors: Float64Array[], dim: number): Float64Array {
  const mean = new Float64Array(dim);
  if (vectors.length === 0) return mean;
  for (const v of vectors) for (let d = 0; d < dim; d++) mean[d]! += v[d]!;
  for (let d = 0; d < dim; d++) mean[d] = mean[d]! / vectors.length;
  return mean;
}

/**
 * Solve (XᵀX + λI) W = XᵀY with the symmetric system folded into one
 * augmented matrix, Gauss–Jordan with partial pivoting. Deterministic.
 */
function solveSymmetric(
  a: Float64Array,
  b: Float64Array,
  cols: number,
  dim: number,
): Array<Float64Array> | null {
  const n = cols;
  // augmented [A | B]
  const m = new Float64Array(n * (n + dim));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i * (n + dim) + j] = a[i * n + j]!;
    for (let d = 0; d < dim; d++) m[i * (n + dim) + n + d] = b[i * dim + d]!;
  }
  for (let col = 0; col < n; col++) {
    // partial pivot
    let pivotRow = col;
    let pivotAbs = Math.abs(m[col * (n + dim) + col]!);
    for (let row = col + 1; row < n; row++) {
      const candidate = Math.abs(m[row * (n + dim) + col]!);
      if (candidate > pivotAbs) {
        pivotAbs = candidate;
        pivotRow = row;
      }
    }
    if (pivotAbs < 1e-10) return null; // singular (collinear features)
    if (pivotRow !== col) {
      for (let j = 0; j < n + dim; j++) {
        const tmp = m[col * (n + dim) + j]!;
        m[col * (n + dim) + j] = m[pivotRow * (n + dim) + j]!;
        m[pivotRow * (n + dim) + j] = tmp;
      }
    }
    const pivot = m[col * (n + dim) + col]!;
    for (let j = col; j < n + dim; j++) m[col * (n + dim) + j]! /= pivot;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row * (n + dim) + col]!;
      if (factor === 0) continue;
      for (let j = col; j < n + dim; j++)
        m[row * (n + dim) + j]! -= factor * m[col * (n + dim) + j]!;
    }
  }
  const out: Array<Float64Array> = [];
  for (let i = 0; i < n; i++) {
    const rowW = new Float64Array(dim);
    for (let d = 0; d < dim; d++) rowW[d] = m[i * (n + dim) + n + d]!;
    out.push(rowW);
  }
  return out;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
