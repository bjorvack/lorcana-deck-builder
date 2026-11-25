import type { Card } from '../data/types';
import {
  buildFeatureVocabularies,
  CANDIDATE_DIM,
  type CardInteractionProfile,
  ENCODER_HIDDEN,
  FEATURE_DIM,
  FEATURE_SCHEMA_VERSION,
  type FeatureVocabularies,
  INTERACTION_DIM,
  INTERACTION_NAMES,
  POOL_DIM,
  SCORER_HIDDEN,
  SCORER_INPUT_DIM,
  type SeedInteractionAggregate,
  cardFeatures as sharedCardFeatures,
  cardInteractionProfile as sharedCardInteractionProfile,
  interactionDims as sharedInteractionDims,
  seedInteractionAggregate as sharedSeedInteractionAggregate,
} from '../shared/card-features';
import {
  type DeepSetsModel,
  scoreCandidates,
  TENSOR_SHAPES,
} from '../shared/deepsets';
import { fnv1a32 } from '../shared/hash';

/**
 * Learned deck-completion source (learned-deck-generator, tasks 4.1/6.1/6.2;
 * design D2b/D4/D5; spec learned-deck-completion "Smart-mode integration with
 * graceful degradation").
 *
 * The trained artifact ships as a static same-origin file (the offline-site
 * rule): `public/data/generator-model.json`, emitted by the training pipeline
 * (`scripts/training/generator/`). Loading mirrors `src/meta/infer.ts`:
 * anything wrong — missing file, corrupt JSON, schema/architecture mismatch,
 * malformed tensors — degrades to `null` and the caller falls back to the
 * shipped suggest-fill scoring. This module never throws into the generator.
 */

export type { FeatureVocabularies };
export {
  CANDIDATE_DIM,
  FEATURE_DIM,
  FEATURE_SCHEMA_VERSION,
  fnv1a32,
  INTERACTION_DIM,
  INTERACTION_NAMES,
  SCORER_INPUT_DIM,
};

export function featureVocabularies(
  cards: readonly Card[],
): FeatureVocabularies {
  return buildFeatureVocabularies(cards);
}

export function cardFeatures(
  card: Card,
  vocab: FeatureVocabularies,
): Float64Array {
  return sharedCardFeatures(card, vocab);
}

export function cardInteractionProfile(
  card: Card,
  vocab: FeatureVocabularies,
): CardInteractionProfile {
  return sharedCardInteractionProfile(card, vocab);
}

export function seedInteractionAggregate(
  profiles: readonly CardInteractionProfile[],
): SeedInteractionAggregate {
  return sharedSeedInteractionAggregate(profiles);
}

export function interactionDims(
  profile: CardInteractionProfile,
  aggregate: SeedInteractionAggregate,
): Float64Array {
  return sharedInteractionDims(profile, aggregate);
}

export type GeneratorModel = DeepSetsModel;

export interface GeneratorModelArtifact {
  featureSchemaVersion: number;
  gate: {
    passed: boolean;
    verdict: string | null;
    ciLow: number | null;
  };
  model: GeneratorModel;
}

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
 * completion unavailable".
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

/**
 * Live-trial loader for the generator page (user decision 2026-11-23):
 * always load the artifact and bypass its A/B gate flag locally so the
 * model is testable site-wide before the gate concludes.
 */
export async function loadLearnedModelForSite(
  base = `${import.meta.env.BASE_URL ?? '/'}`,
): Promise<GeneratorModelArtifact | null> {
  const artifact = await loadGeneratorModel(base);
  if (!artifact) return null;
  return { ...artifact, gate: { ...artifact.gate, passed: true } };
}

export interface LearnedFillSource {
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
  const vocab = featureVocabularies([...byId.values()]);
  const featureCache = new Map<number, Float64Array>();
  const profileCache = new Map<number, CardInteractionProfile>();
  const cached = <T>(
    cache: Map<number, T>,
    card: Card,
    compute: () => T,
  ): T => {
    let value = cache.get(card.id);
    if (value === undefined) {
      value = compute();
      cache.set(card.id, value);
    }
    return value;
  };
  const featuresFor = (card: Card): Float64Array =>
    cached(featureCache, card, () => cardFeatures(card, vocab));
  const profileFor = (card: Card): CardInteractionProfile =>
    cached(profileCache, card, () => cardInteractionProfile(card, vocab));
  return {
    score(deck, candidates) {
      const seedCards: Card[] = [];
      const seed = Object.keys(deck)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((id) => {
          const card = byId.get(id);
          const count = deck[id] ?? 0;
          if (card && count > 0) {
            seedCards.push(card);
            return [{ features: featuresFor(card), count }];
          }
          return [];
        });
      const aggregate = seedInteractionAggregate(
        seedCards.map((card) => profileFor(card)),
      );
      const candidateFeatures = candidates.map((card) => ({
        features: featuresFor(card),
        interactions: interactionDims(profileFor(card), aggregate),
      }));
      return scoreCandidates(artifact.model, seed, candidateFeatures);
    },
  };
}
