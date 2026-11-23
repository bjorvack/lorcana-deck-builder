import type { Card } from '../data/types';

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
 * (The v2 identity blocks are signed feature hashes into frozen buckets, so
 * a snapshot refresh cannot change the model shape — no snapshot-drift
 * degradation path exists.)
 *
 * The inference math (feature vector v2, interaction dims, int16
 * dequantization, DeepSets forward pass) is reimplemented here instead of
 * importing the training module: `scripts/training/generator/model.ts`
 * transitively imports `corpus.ts`, which pulls `node:fs` — unusable in the
 * browser bundle. Runtime code must not import training code; drift between
 * the two implementations is caught by the cross-implementation consistency
 * test (learned-fill.test.ts), which imports the training module in tests
 * only and pins both sides to FEATURE_SCHEMA_VERSION 2 across every snapshot
 * card.
 */

/** bumps with scripts/training/generator/features.ts; mismatched artifacts degrade to null */
export const FEATURE_SCHEMA_VERSION = 2;

/** per-card feature vector length (see the training features module for the layout) */
export const FEATURE_DIM = 699;

// pinned inference architecture — must match the training model constants;
// the cross-implementation test asserts the pairing
const ENCODER_HIDDEN = 32;
const POOL_DIM = 16;
const SCORER_HIDDEN = 16;
/** candidate↔seed interaction dims (D2b) — see interactionDims below */
export const INTERACTION_DIM = 8;
export const CANDIDATE_DIM = FEATURE_DIM + INTERACTION_DIM;
export const SCORER_INPUT_DIM = CANDIDATE_DIM + POOL_DIM;

// frozen hashed-block widths + offsets — keep in step with features.ts
// (asserted by the parity test); the shape never changes with the snapshot
const KEYWORD_HASH_WIDTH = 32;
const SUBTYPE_HASH_WIDTH = 64;
const TAG_HASH_WIDTH = 64;
const NAME_HASH_WIDTH = 512;
const KEYWORD_BLOCK_OFFSET = 24;
const SUBTYPE_BLOCK_OFFSET = KEYWORD_BLOCK_OFFSET + KEYWORD_HASH_WIDTH;
const TAG_BLOCK_OFFSET = SUBTYPE_BLOCK_OFFSET + SUBTYPE_HASH_WIDTH;
const DUAL_SONG_OFFSET = TAG_BLOCK_OFFSET + TAG_HASH_WIDTH;
const NAME_BLOCK_OFFSET = DUAL_SONG_OFFSET + 2;
const UNIQUE_NAME_OFFSET = NAME_BLOCK_OFFSET + NAME_HASH_WIDTH;

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

const CARD_TYPE_VOCAB = ['Character', 'Action', 'Item', 'Location'] as const;
/** longest-first, hoisted for the type-reference extraction */
const SORTED_CARD_TYPES = [...CARD_TYPE_VOCAB].sort(
  (a, b) => b.length - a.length,
);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value)) || 0;

function textLengthBucket(text: string): number {
  if (text.length === 0) return 0;
  if (text.length <= TEXT_LEN_BOUNDS[0]) return 1;
  if (text.length <= TEXT_LEN_BOUNDS[1]) return 2;
  return 3;
}

// ---- feature vocabularies (snapshot-derived, mirrored from names.ts) ----

/** codepoint order — locale-independent, so sorting stays deterministic */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Parsed names of a card: " & " splits multi-CHARACTER names only —
 * non-character cards keep their full name as a single name (names.ts rule).
 */
function parseCardNames(name: string, type: string): string[] {
  if (type !== 'Character') return [name.trim()];
  return name.split(' & ').map((part) => part.trim());
}

/**
 * Greedy longest-match-first extraction with span removal: a matched span is
 * recorded and blocked so a shorter entry contained in it does not
 * double-fire ("Prince" inside "Princess"). `vocab` must be sorted
 * longest-first (the feature vocabularies carry it pre-sorted). Mirrors
 * names.ts extractMentions.
 */
function extractMentions(
  text: string,
  vocab: readonly string[],
  caseInsensitive: boolean,
): string[] {
  const hay = caseInsensitive ? text.toLowerCase() : text;
  const spans: Array<{ start: number; end: number }> = [];
  const matches = new Set<string>();
  for (const entry of vocab) {
    const needle = caseInsensitive ? entry.toLowerCase() : entry;
    let at = hay.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      if (!spans.some((span) => at < span.end && end > span.start)) {
        matches.add(entry);
        spans.push({ start: at, end });
      }
      at = hay.indexOf(needle, at + 1);
    }
  }
  return [...matches].sort(compareStrings);
}

/**
 * The snapshot-derived extraction tables. Only the name-family table (and
 * the subtype table for text-reference extraction) is still needed: the v2
 * identity blocks are SIGNED FEATURE HASHES into frozen buckets, so no
 * keyword/tag/subtype vocabulary defines dims and the model shape is frozen
 * across set arrivals. The family table drives (a) which text references are
 * extracted, (b) the exact set-operation interaction dims, and (c) the
 * uniqueName flag. Memoized per cards array (WeakMap).
 */
export interface FeatureVocabularies {
  subtypes: readonly string[];
  nameFamilies: readonly string[];
  /** extraction-ready: vocabularies sorted longest-first (hoisted per array) */
  readonly sortedNameFamilies: readonly string[];
  readonly sortedSubtypes: readonly string[];
  readonly subtypeIndex: ReadonlyMap<string, number>;
  readonly familyIndex: ReadonlyMap<string, number>;
}

const vocabCache = new WeakMap<object, FeatureVocabularies>();

export function featureVocabularies(
  cards: readonly Card[],
): FeatureVocabularies {
  const cached = vocabCache.get(cards);
  if (cached) return cached;
  const subtypes = [...new Set(cards.flatMap((card) => card.subtypes))].sort(
    compareStrings,
  );
  const nameCounts = new Map<string, number>();
  for (const card of cards) {
    for (const name of parseCardNames(card.name, card.type)) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
  }
  const nameFamilies = [...nameCounts]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort(compareStrings);
  const vocab: FeatureVocabularies = {
    subtypes,
    nameFamilies,
    sortedNameFamilies: [...nameFamilies].sort((a, b) => b.length - a.length),
    sortedSubtypes: [...subtypes].sort((a, b) => b.length - a.length),
    subtypeIndex: new Map(subtypes.map((v, i) => [v, i])),
    familyIndex: new Map(nameFamilies.map((v, i) => [v, i])),
  };
  vocabCache.set(cards, vocab);
  return vocab;
}

// ---- signed feature hashing (identical to features.ts; parity-pinned) ----

/** FNV-1a 32-bit over the string's UTF-16 code units, lowercased first */
export function fnv1a32(value: string): number {
  let hash = 2166136261;
  const lower = value.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash = Math.imul(hash ^ lower.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** signed accumulation of `value` into a fixed-width block of `features` */
function hashInto(
  features: Float64Array,
  offset: number,
  width: number,
  value: string,
): void {
  const hash = fnv1a32(value);
  const bucket = hash % width;
  const sign = ((hash >>> 8) & 1) !== 0 ? 1 : -1;
  features[offset + bucket]! += sign;
}

/**
 * Feature vector for one card identity (FEATURE_DIM, card-data only): the
 * v1 base dims, signed keyword/subtype/tag hashes, dual-ink/song flags, the
 * shared 512-bucket name-hash block (own names ∪ text-referenced family
 * names) and the uniqueName flag. Mirrors the training features module; the
 * all-cards parity test pins exact equality (hashing included).
 */
export function cardFeatures(
  card: Card,
  vocab: FeatureVocabularies,
): Float64Array {
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
  for (const keyword of card.keywords) {
    hashInto(features, KEYWORD_BLOCK_OFFSET, KEYWORD_HASH_WIDTH, keyword);
  }
  for (const subtype of card.subtypes) {
    hashInto(features, SUBTYPE_BLOCK_OFFSET, SUBTYPE_HASH_WIDTH, subtype);
  }
  for (const tag of card.tags) {
    hashInto(features, TAG_BLOCK_OFFSET, TAG_HASH_WIDTH, tag.tag);
  }
  features[DUAL_SONG_OFFSET] = card.isDualInk ? 1 : 0;
  features[DUAL_SONG_OFFSET + 1] = card.isSong ? 1 : 0;
  const names = parseCardNames(card.name, card.type);
  const mentions = extractMentions(text, vocab.sortedNameFamilies, false);
  for (const name of names) {
    hashInto(features, NAME_BLOCK_OFFSET, NAME_HASH_WIDTH, name);
  }
  for (const name of mentions) {
    hashInto(features, NAME_BLOCK_OFFSET, NAME_HASH_WIDTH, name);
  }
  // a parsed name with no family entry sits on a single card (or is unknown)
  features[UNIQUE_NAME_OFFSET] = names.some(
    (name) => !vocab.familyIndex.has(name),
  )
    ? 1
    : 0;
  return features;
}

// ---- interaction dims (mirrored from features.ts; parity-pinned) ----

/** per-identity interaction inputs, cached per card id by the fill source */
export interface CardInteractionProfile {
  readonly names: readonly string[];
  readonly nameFamilies: ReadonlySet<number>;
  readonly refFamilies: ReadonlySet<number>;
  readonly subtypes: ReadonlySet<string>;
  readonly refSubtypes: ReadonlySet<string>;
  readonly type: string;
  readonly refTypes: ReadonlySet<string>;
  readonly isShift: boolean;
  readonly selfRefTrait: boolean;
}

export function cardInteractionProfile(
  card: Card,
  vocab: FeatureVocabularies,
): CardInteractionProfile {
  const text = card.text ?? '';
  const names = parseCardNames(card.name, card.type);
  const nameFamilies = new Set<number>();
  for (const name of names) {
    const family = vocab.familyIndex.get(name);
    if (family !== undefined) nameFamilies.add(family);
  }
  const refFamilies = new Set<number>();
  for (const name of extractMentions(text, vocab.sortedNameFamilies, false)) {
    const family = vocab.familyIndex.get(name);
    if (family !== undefined) refFamilies.add(family);
  }
  const refSubtypes = new Set(
    extractMentions(text, vocab.sortedSubtypes, false),
  );
  const refTypes = new Set(extractMentions(text, SORTED_CARD_TYPES, true));
  const subtypes = new Set(card.subtypes);
  const selfRefTrait =
    [...refSubtypes].some((subtype) => subtypes.has(subtype)) ||
    [...refFamilies].some((family) => nameFamilies.has(family));
  return Object.freeze({
    names: Object.freeze(names),
    nameFamilies: Object.freeze(nameFamilies),
    refFamilies: Object.freeze(refFamilies),
    subtypes: Object.freeze(subtypes),
    refSubtypes: Object.freeze(refSubtypes),
    type: card.type,
    refTypes: Object.freeze(refTypes),
    isShift: card.keywords.includes('Shift'),
    selfRefTrait,
  });
}

/** the seed deck's aggregate identity sets, built once per scoring context */
export interface SeedInteractionAggregate {
  nameFamilies: Set<number>;
  refFamilies: Set<number>;
  names: Set<string>;
  subtypes: Set<string>;
  refSubtypes: Set<string>;
  types: Set<string>;
}

export function seedInteractionAggregate(
  profiles: readonly CardInteractionProfile[],
): SeedInteractionAggregate {
  const aggregate: SeedInteractionAggregate = {
    nameFamilies: new Set<number>(),
    refFamilies: new Set<number>(),
    names: new Set<string>(),
    subtypes: new Set<string>(),
    refSubtypes: new Set<string>(),
    types: new Set<string>(),
  };
  for (const profile of profiles) {
    for (const family of profile.nameFamilies)
      aggregate.nameFamilies.add(family);
    for (const family of profile.refFamilies) aggregate.refFamilies.add(family);
    for (const name of profile.names) aggregate.names.add(name);
    for (const subtype of profile.subtypes) aggregate.subtypes.add(subtype);
    for (const subtype of profile.refSubtypes)
      aggregate.refSubtypes.add(subtype);
    aggregate.types.add(profile.type);
  }
  return aggregate;
}

function countShared<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

export const INTERACTION_NAMES = [
  'nameOverlap',
  'shiftMatch',
  'refNameMatch',
  'nameTargetMatch',
  'traitEngineMatch',
  'traitTargetMatch',
  'selfRefTrait',
  'typeRefMatch',
] as const;

/**
 * The eight computed candidate↔seed relation dims (D2b): identical inputs
 * must produce identical outputs to the training implementation — pinned by
 * the cross-implementation parity test over every snapshot card.
 */
export function interactionDims(
  profile: CardInteractionProfile,
  aggregate: SeedInteractionAggregate,
): Float64Array {
  const dims = new Float64Array(INTERACTION_DIM);
  dims[0] = countShared(profile.nameFamilies, aggregate.nameFamilies);
  dims[1] =
    profile.isShift && profile.names.some((name) => aggregate.names.has(name))
      ? 1
      : 0;
  dims[2] = countShared(profile.refFamilies, aggregate.nameFamilies);
  dims[3] = countShared(profile.nameFamilies, aggregate.refFamilies);
  dims[4] = countShared(profile.refSubtypes, aggregate.subtypes);
  dims[5] = countShared(profile.subtypes, aggregate.refSubtypes);
  dims[6] = profile.selfRefTrait ? 1 : 0;
  dims[7] = countShared(profile.refTypes, aggregate.types);
  return dims;
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

/**
 * Live-trial loader for the generator page (user decision 2026-11-23):
 * always load the artifact and bypass its A/B gate flag locally so the
 * model is testable site-wide before the gate concludes. The artifact's
 * own flag still records the real verdict (task 5.2); if the A/B FAILs,
 * the follow-up commit reverts this forced path unless overridden.
 * Null means the artifact is missing or corrupt (shipped-fill fallback).
 */
export async function loadLearnedModelForSite(
  base = `${import.meta.env.BASE_URL ?? '/'}`,
): Promise<GeneratorModelArtifact | null> {
  const artifact = await loadGeneratorModel(base);
  if (!artifact) return null;
  return { ...artifact, gate: { ...artifact.gate, passed: true } };
}

// ---- inference (DeepSets forward, mirrored from the training model) ----

/** one seed-deck card: feature vector + copy count (the pool weight) */
interface SeedCard {
  features: Float64Array;
  count: number;
}

/**
 * Score each candidate given the seed deck: per-card encoder MLP, masked mean
 * pool weighted by copy counts, scorer MLP over [candidate features ⊕
 * interactions ⊕ pooled context]. Mirrors `forwardPair`/`scoreCandidates` in
 * the training model, including accumulation order, so a trained artifact
 * scores identically (asserted by the cross-implementation test).
 * Deterministic.
 */
function scoreWithModel(
  model: GeneratorModel,
  seed: readonly SeedCard[],
  candidates: readonly {
    features: Float64Array;
    interactions: Float64Array;
  }[],
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
    const candidate = candidates[j]!;
    const features = candidate.features;
    const interactions = candidate.interactions;
    let s = model.scorerB2;
    for (let o = 0; o < SCORER_HIDDEN; o++) {
      const row = o * SCORER_INPUT_DIM;
      let z = model.scorerB1[o]!;
      for (let i = 0; i < FEATURE_DIM; i++) {
        z += model.scorerW1[row + i]! * features[i]!;
      }
      for (let i = 0; i < INTERACTION_DIM; i++) {
        z += model.scorerW1[row + FEATURE_DIM + i]! * interactions[i]!;
      }
      for (let p = 0; p < POOL_DIM; p++) {
        z += model.scorerW1[row + CANDIDATE_DIM + p]! * pool[p]!;
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
      // id-sorted seed: the pool is a floating-point weighted mean, so fix
      // the accumulation order for determinism (and match the training-side
      // construction, which sorts by id)
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
      return scoreWithModel(artifact.model, seed, candidateFeatures);
    },
  };
}
