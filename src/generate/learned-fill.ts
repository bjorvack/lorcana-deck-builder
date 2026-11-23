import type { Card } from '../data/types';

/**
 * Learned deck-completion source (learned-deck-generator, tasks 4.1; design
 * D4/D5; spec learned-deck-completion "Smart-mode integration with graceful
 * degradation").
 *
 * The trained artifact ships as a static same-origin file (the offline-site
 * rule): `public/data/generator-model.json`, emitted by the training pipeline
 * (`scripts/training/generator/`). Loading mirrors `src/meta/infer.ts`:
 * anything wrong — missing file, corrupt JSON, schema/architecture mismatch,
 * malformed tensors — degrades to `null` and the caller falls back to the
 * shipped suggest-fill scoring. This module never throws into the generator.
 *
 * The inference math (feature vector, int16 dequantization, DeepSets forward
 * pass) is reimplemented here instead of importing the training module:
 * `scripts/training/generator/model.ts` transitively imports `corpus.ts`,
 * which pulls `node:fs` — unusable in the browser bundle. Runtime code must
 * not import training code; drift between the two implementations is caught
 * by the cross-implementation consistency test (learned-fill.test.ts), which
 * imports the training module in tests only and pins both sides to
 * FEATURE_SCHEMA_VERSION 1.
 */

/** bumps with scripts/training/generator/features.ts; mismatched artifacts degrade to null */
export const FEATURE_SCHEMA_VERSION = 1;

/** per-card feature vector length (see the training features module for the layout) */
export const FEATURE_DIM = 24;

// pinned inference architecture — must match the training model constants;
// the cross-implementation test asserts the pairing
const ENCODER_HIDDEN = 32;
const POOL_DIM = 16;
const SCORER_HIDDEN = 16;
const SCORER_INPUT_DIM = FEATURE_DIM + POOL_DIM;

/** keyword flags, in vector order (indices 6–15) — keep in step with features.ts */
const KEYWORD_NAMES = [
  'rush',
  'evasive',
  'singer',
  'ward',
  'resist',
  'challenger',
  'support',
  'reckless',
  'bodyguard',
  'shift',
] as const;

const KEYWORD_REGEXES: Array<RegExp> = KEYWORD_NAMES.map(
  (name) => new RegExp(`\\b${name}\\b`, 'i'),
);

const WHEN_PLAYED_REGEX = /\bwhen you play\b/i;
const ON_PLAY_REGEX = /\bon play\b/i;
const DURING_TURN_REGEX = /\bduring\b[^\n]*\bturns?\b/i;
const NUMERIC_TOKEN_REGEX = /\d+/g;

const STAT_NORM = 10;
const LORE_NORM = 5;
const TEXT_LEN_BOUNDS = [80, 200] as const;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value)) || 0;

function textLengthBucket(text: string): number {
  if (text.length === 0) return 0;
  if (text.length <= TEXT_LEN_BOUNDS[0]) return 1;
  if (text.length <= TEXT_LEN_BOUNDS[1]) return 2;
  return 3;
}

/**
 * Feature vector for one card identity (24-dim, card-data only): cost, ink,
 * type one-hots, text-derived keyword flags, stats, text-shape buckets.
 * Pure function of the card record; mirrors the training features module.
 */
export function cardFeatures(card: Card): Float64Array {
  const features = new Float64Array(FEATURE_DIM);
  features[0] = clamp01(card.cost / STAT_NORM);
  features[1] = card.inkwell ? 1 : 0;
  features[2] = card.type === 'Character' ? 1 : 0;
  features[3] = card.type === 'Action' ? 1 : 0;
  features[4] = card.type === 'Item' ? 1 : 0;
  features[5] =
    card.type !== 'Character' && card.type !== 'Action' && card.type !== 'Item'
      ? 1
      : 0;
  const text = card.text ?? '';
  for (const [index, regex] of KEYWORD_REGEXES.entries()) {
    features[6 + index] = regex.test(text) ? 1 : 0;
  }
  features[16] = clamp01((card.willpower ?? 0) / STAT_NORM);
  features[17] = clamp01((card.strength ?? 0) / STAT_NORM);
  features[18] = clamp01((card.lore ?? 0) / LORE_NORM);
  features[19] = textLengthBucket(text) / 3;
  features[20] = Math.min(text.match(NUMERIC_TOKEN_REGEX)?.length ?? 0, 5) / 5;
  features[21] = WHEN_PLAYED_REGEX.test(text) ? 1 : 0;
  features[22] = ON_PLAY_REGEX.test(text) ? 1 : 0;
  features[23] = DURING_TURN_REGEX.test(text) ? 1 : 0;
  return features;
}

// ---- artifact parsing (strict; null on any doubt) ----

export interface GeneratorModel {
  encW1: Float64Array;
  encB1: Float64Array;
  encW2: Float64Array;
  encB2: Float64Array;
  scorerW1: Float64Array;
  scorerB1: Float64Array;
  scorerW2: Float64Array;
  scorerB2: number;
}

export interface GeneratorModelArtifact {
  featureSchemaVersion: number;
  gate: {
    passed: boolean;
    verdict: string | null;
    ciLow: number | null;
  };
  model: GeneratorModel;
}

/** tensor shapes of the weights block, keyed by model field */
const TENSOR_SHAPES: Record<string, number[]> = {
  encW1: [ENCODER_HIDDEN, FEATURE_DIM],
  encB1: [ENCODER_HIDDEN],
  encW2: [POOL_DIM, ENCODER_HIDDEN],
  encB2: [POOL_DIM],
  scorerW1: [SCORER_HIDDEN, SCORER_INPUT_DIM],
  scorerB1: [SCORER_HIDDEN],
  scorerW2: [SCORER_HIDDEN],
  scorerB2: [1],
};

/** base64 → bytes (browser-safe; atob throws on malformed input) */
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** one int16-le tensor: validate shape/payload, dequantize by its scale */
function decodeTensor(
  tensor: unknown,
  expectedShape: number[],
): Float64Array | null {
  if (!tensor || typeof tensor !== 'object') return null;
  const t = tensor as { shape?: unknown; b64?: unknown; scale?: unknown };
  if (
    !Array.isArray(t.shape) ||
    t.shape.length !== expectedShape.length ||
    t.shape.some((d, i) => d !== expectedShape[i])
  ) {
    return null;
  }
  if (
    typeof t.b64 !== 'string' ||
    typeof t.scale !== 'number' ||
    !Number.isFinite(t.scale) ||
    t.scale <= 0
  ) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(t.b64);
  } catch {
    return null;
  }
  const count = expectedShape.reduce((a, b) => a * b, 1);
  if (bytes.length !== count * 2) return null;
  const out = new Float64Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) * t.scale;
  return out;
}

/**
 * Validate + dequantize a generator-model artifact; null means "learned
 * completion unavailable". The artifact is single-capability, so there is no
 * partial degradation: any malformed part disables the whole learned path
 * (infer.ts precedent — only a fully unusable artifact matters here).
 */
export function parseGeneratorModel(
  json: unknown,
): GeneratorModelArtifact | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Record<string, unknown>;
  if (m.format !== 'generator-model') return null;
  if (m.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) return null;
  const gate = m.gate as Record<string, unknown> | undefined;
  if (!gate || typeof gate.passed !== 'boolean') return null;
  // a different architecture is a schema mismatch, not a runtime error
  const arch = m.arch as Record<string, unknown> | undefined;
  if (
    !arch ||
    arch.encoderHidden !== ENCODER_HIDDEN ||
    arch.poolDim !== POOL_DIM ||
    arch.scorerHidden !== SCORER_HIDDEN ||
    arch.inputDim !== FEATURE_DIM ||
    arch.scorerInputDim !== SCORER_INPUT_DIM
  ) {
    return null;
  }
  const weights = m.weights as Record<string, unknown> | undefined;
  if (weights?.quantization !== 'int16-le') return null;
  const tensors = weights.tensors as Record<string, unknown> | undefined;
  if (!tensors || typeof tensors !== 'object') return null;

  const decode = (key: string): Float64Array | null =>
    decodeTensor(tensors[key], TENSOR_SHAPES[key]!);
  const encW1 = decode('encW1');
  const encB1 = decode('encB1');
  const encW2 = decode('encW2');
  const encB2 = decode('encB2');
  const scorerW1 = decode('scorerW1');
  const scorerB1 = decode('scorerB1');
  const scorerW2 = decode('scorerW2');
  const scorerB2 = decode('scorerB2');
  if (
    !encW1 ||
    !encB1 ||
    !encW2 ||
    !encB2 ||
    !scorerW1 ||
    !scorerB1 ||
    !scorerW2 ||
    !scorerB2
  ) {
    return null;
  }
  const model: GeneratorModel = {
    encW1,
    encB1,
    encW2,
    encB2,
    scorerW1,
    scorerB1,
    scorerW2,
    scorerB2: scorerB2[0] ?? 0,
  };
  return {
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    gate: {
      passed: gate.passed,
      verdict: typeof gate.verdict === 'string' ? gate.verdict : null,
      ciLow: typeof gate.ciLow === 'number' ? gate.ciLow : null,
    },
    model,
  };
}

/**
 * Fetch the artifact the same way the meta model loads: static same-origin
 * asset under the site's base path, revalidated against its ETag so a stale
 * artifact cannot survive deploys, and `null` on anything wrong.
 */
export async function loadGeneratorModel(
  base = `${import.meta.env.BASE_URL ?? '/'}`,
): Promise<GeneratorModelArtifact | null> {
  try {
    const res = await fetch(`${base}data/generator-model.json`, {
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    return parseGeneratorModel(await res.json());
  } catch {
    return null;
  }
}

// ---- inference (DeepSets forward, mirrored from the training model) ----

/** one seed-deck card: feature vector + copy count (the pool weight) */
interface SeedCard {
  features: Float64Array;
  count: number;
}

/**
 * Score each candidate given the seed deck: per-card encoder MLP, masked mean
 * pool weighted by copy counts, scorer MLP over [candidate ⊕ pooled context].
 * Mirrors `forwardPair`/`scoreCandidates` in the training model, including
 * accumulation order, so a trained artifact scores identically (asserted by
 * the cross-implementation test). Deterministic.
 */
function scoreWithModel(
  model: GeneratorModel,
  seed: readonly SeedCard[],
  candidates: readonly Float64Array[],
): Float64Array {
  const scores = new Float64Array(candidates.length);
  if (candidates.length === 0) return scores;
  const pool = new Float64Array(POOL_DIM);
  const g = new Float64Array(Math.max(1, seed.length) * ENCODER_HIDDEN);
  let total = 0;
  for (const card of seed) total += card.count;
  for (let k = 0; k < seed.length; k++) {
    const f = seed[k]!.features;
    const gBase = k * ENCODER_HIDDEN;
    for (let un = 0; un < ENCODER_HIDDEN; un++) {
      let a = model.encB1[un]!;
      for (let i = 0; i < FEATURE_DIM; i++) {
        a += model.encW1[un * FEATURE_DIM + i]! * f[i]!;
      }
      g[gBase + un] = Math.tanh(a);
    }
    // an empty seed deck pools to the zero vector (no division — the loop
    // never runs); callers only score once the deck has cards
    const weight = seed[k]!.count / total;
    for (let p = 0; p < POOL_DIM; p++) {
      let a = model.encB2[p]!;
      for (let un = 0; un < ENCODER_HIDDEN; un++) {
        a += model.encW2[p * ENCODER_HIDDEN + un]! * g[gBase + un]!;
      }
      pool[p]! += weight * Math.tanh(a);
    }
  }
  for (let j = 0; j < candidates.length; j++) {
    const x = candidates[j]!;
    let s = model.scorerB2;
    for (let o = 0; o < SCORER_HIDDEN; o++) {
      let z = model.scorerB1[o]!;
      for (let i = 0; i < FEATURE_DIM; i++) {
        z += model.scorerW1[o * SCORER_INPUT_DIM + i]! * x[i]!;
      }
      for (let p = 0; p < POOL_DIM; p++) {
        z += model.scorerW1[o * SCORER_INPUT_DIM + FEATURE_DIM + p]! * pool[p]!;
      }
      s += model.scorerW2[o]! * Math.tanh(z);
    }
    scores[j] = s;
  }
  return scores;
}

/**
 * Per-pick completion source for the suggest-fill loop (D5): scores masked,
 * eligible candidates against the evolving deck. Only exists for artifacts
 * whose A/B gate passed — anything else returns null so callers stay on the
 * shipped scoring path (honest degradation, no silent enable).
 */
export interface LearnedFillSource {
  /** learned score per candidate, aligned with the candidates array */
  score(
    deck: Record<number, number>,
    candidates: readonly Card[],
  ): Float64Array;
}

export function createLearnedFillSource(
  artifact: GeneratorModelArtifact,
  byId: Map<number, Card>,
): LearnedFillSource | null {
  if (!artifact.gate.passed) return null;
  const featureCache = new Map<number, Float64Array>();
  const featuresFor = (card: Card): Float64Array => {
    let features = featureCache.get(card.id);
    if (!features) {
      features = cardFeatures(card);
      featureCache.set(card.id, features);
    }
    return features;
  };
  return {
    score(deck, candidates) {
      // id-sorted seed: the pool is a floating-point weighted mean, so fix
      // the accumulation order for determinism (and match the training-side
      // construction, which sorts by id)
      const seed = Object.keys(deck)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((id) => {
          const card = byId.get(id);
          const count = deck[id] ?? 0;
          return card && count > 0
            ? [{ features: featuresFor(card), count }]
            : [];
        });
      const candidateFeatures = candidates.map((card) => featuresFor(card));
      return scoreWithModel(artifact.model, seed, candidateFeatures);
    },
  };
}
