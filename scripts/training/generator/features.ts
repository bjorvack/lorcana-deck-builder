/**
 * Card-data-only feature extraction for the learned deck generator
 * (learned-deck-generator, tasks 1.3 + 6.1/6.2; design D2b — amended to
 * signed feature hashing; spec learned-deck-completion "Card-data-only
 * features").
 *
 * Features are a pure function of the committed card snapshot fields — no
 * tournament, co-occurrence or archive statistics. The v2 contract adds card
 * identity via SIGNED FEATURE HASHING into fixed buckets: the model SHAPE is
 * frozen across set arrivals (a new Lorcana set grows no dimension — new
 * vocabulary entries land in existing buckets, at the cost of measured,
 * reported collisions). The crisp candidate↔seed relations the data hands us
 * are NOT learned from these blocks — they are computed at scoring time as
 * exact set-operation interaction dims (INTERACTION_NAMES below), which
 * collisions cannot corrupt.
 *
 * Hash: fnv1a32 over the lowercased string (identical in both
 * implementations, stable across snapshots); bucket = h % width, sign =
 * ((h >>> 8) & 1) ? +1 : -1; occurrences accumulate (own names and
 * text-referenced names both feed the name block, so a card that is named
 * Gaston and references Gaston accumulates ±2).
 *
 * Exact feature vector layout (index → name, see FEATURE_NAMES):
 *
 *      0  cost            card.cost / 10, clamped to [0, 1]
 *      1  inkable         card.inkwell ? 1 : 0
 *      2  type.character  type === 'Character' ? 1 : 0
 *      3  type.action     type === 'Action' ? 1 : 0
 *      4  type.item       type === 'Item' ? 1 : 0
 *      5  type.other      everything else (Location, …) ? 1 : 0
 *    6–15 keywords      word-boundary, case-insensitive match of the keyword
 *                       in card.text → 1 : 0, in this order:
 *                       rush, evasive, singer, ward, resist, challenger,
 *                       support, reckless, bodyguard, shift
 *     16  willpower       (card.willpower ?? 0) / 10, clamped to [0, 1]
 *     17  strength        (card.strength ?? 0) / 10, clamped to [0, 1]
 *     18  lore            (card.lore ?? 0) / 5, clamped to [0, 1]
 *     19  textLengthBucket 0 = no text, 1 = ≤ 80 chars, 2 = ≤ 200, 3 = more;
 *                         stored as bucket / 3
 *     20  numericTokens   count of /\d+/g matches in text, capped at 5 → /5
 *     21  hasWhenPlayed   /\bwhen you play\b/i in text → 1 : 0
 *     22  hasOnPlay       /\bon play\b/i in text → 1 : 0
 *     23  hasDuringTurn   /\bduring\b[^\n]*\bturns?\b/i in text → 1 : 0
 *   24–55 kwfield hash   signed hash of each curated `keywords` value into
 *                         32 buckets (the curated field carries the Shift
 *                         family invisible to the text-derived flags)
 *   56–119 subtype hash  signed hash of each card.subtypes entry into 64
 *   120–183 tag hash     signed hash of each functional `tags` value into 64
 *    184  isDualInk      card.isDualInk ? 1 : 0
 *    185  isSong         card.isSong ? 1 : 0
 *  186–697 name hash     signed hash of every parsed name (own names AND
 *                         text-referenced family names) into 512 buckets
 *    698  uniqueName      any parsed name sits on a single card (or is
 *                         unknown to the snapshot vocabulary)
 *
 * The block widths are frozen constants — a snapshot refresh never changes
 * FEATURE_DIM, so the artifact's arch block and the runtime shape survive
 * set arrivals. Only a deliberate bucket-count change (evidence-driven via
 * the reported collision rates) is a real schema bump.
 *
 * Bump FEATURE_SCHEMA_VERSION whenever this list changes meaning; the corpus
 * and the trained artifact both carry it so stale artifacts degrade cleanly.
 */
import type { Card } from '../../../src/data/types';
import {
  cardNameInfo,
  NAME_CARD_COUNTS,
  NAME_FAMILIES,
  SNAPSHOT_CARDS_READONLY,
  SUBTYPE_VOCAB,
} from './names';

export const FEATURE_SCHEMA_VERSION = 2;

export { CARD_TYPE_VOCAB, NAME_FAMILIES, SUBTYPE_VOCAB } from './names';

/** text-derived keyword flags, in vector order (index 6–15) — v1, unchanged */
export const KEYWORD_NAMES = [
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

/**
 * Curated `keywords` field vocabulary — no longer dim-defining (the hashed
 * block needs no table); kept for the per-block collision accounting that
 * the training evidence and the run report carry.
 */
export const KEYWORD_VOCAB: readonly string[] = [
  ...new Set(SNAPSHOT_CARDS_READONLY.flatMap((card) => card.keywords)),
].sort(compareStrings);

/** functional `tags` values — reporting input for the collision accounting */
export const TAG_VOCAB: readonly string[] = [
  ...new Set(
    SNAPSHOT_CARDS_READONLY.flatMap((card) => card.tags.map((tag) => tag.tag)),
  ),
].sort(compareStrings);

// ---- hashing (identical in both implementations; parity-pinned) ----

/** FNV-1a 32-bit over the string's UTF-16 code units, lowercased first */
export function fnv1a32(value: string): number {
  let hash = 2166136261;
  const lower = value.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash = Math.imul(hash ^ lower.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** bucket/sign of one hashed string within a `width`-bucket block */
function hashBucket(
  value: string,
  width: number,
): {
  bucket: number;
  sign: number;
} {
  const hash = fnv1a32(value);
  return {
    bucket: hash % width,
    sign: ((hash >>> 8) & 1) !== 0 ? 1 : -1,
  };
}

/** signed accumulation of `value` into a fixed-width block of `features` */
function hashInto(
  features: Float64Array,
  offset: number,
  width: number,
  value: string,
): void {
  const { bucket, sign } = hashBucket(value, width);
  features[offset + bucket]! += sign;
}

// ---- frozen block widths + offsets ----

/** v1 base dims (0–23), unchanged */
export const BASE_DIM = 24;
export const KEYWORD_HASH_WIDTH = 32;
export const SUBTYPE_HASH_WIDTH = 64;
export const TAG_HASH_WIDTH = 64;
export const NAME_HASH_WIDTH = 512;
export const KEYWORD_BLOCK_OFFSET = BASE_DIM;
export const SUBTYPE_BLOCK_OFFSET = KEYWORD_BLOCK_OFFSET + KEYWORD_HASH_WIDTH;
export const TAG_BLOCK_OFFSET = SUBTYPE_BLOCK_OFFSET + SUBTYPE_HASH_WIDTH;
export const DUAL_SONG_OFFSET = TAG_BLOCK_OFFSET + TAG_HASH_WIDTH;
export const NAME_BLOCK_OFFSET = DUAL_SONG_OFFSET + 2;
export const UNIQUE_NAME_OFFSET = NAME_BLOCK_OFFSET + NAME_HASH_WIDTH;
export const FEATURE_DIM = UNIQUE_NAME_OFFSET + 1;

/** dim label per index; hashed dims are labeled by block (not by value) */
export const FEATURE_NAMES = [
  'cost',
  'inkable',
  'type.character',
  'type.action',
  'type.item',
  'type.other',
  ...KEYWORD_NAMES.map((name) => `keyword.${name}`),
  'willpower',
  'strength',
  'lore',
  'textLengthBucket',
  'numericTokens',
  'hasWhenPlayed',
  'hasOnPlay',
  'hasDuringTurn',
  ...Array.from({ length: KEYWORD_HASH_WIDTH }, (_, i) => `kwfield.hash[${i}]`),
  ...Array.from({ length: SUBTYPE_HASH_WIDTH }, (_, i) => `subtype.hash[${i}]`),
  ...Array.from({ length: TAG_HASH_WIDTH }, (_, i) => `tag.hash[${i}]`),
  'isDualInk',
  'isSong',
  ...Array.from({ length: NAME_HASH_WIDTH }, (_, i) => `name.hash[${i}]`),
  'uniqueName',
] as const;

/** cost / strength / willpower normalizer (printed ranges mostly ≤ 10) */
export const STAT_NORM = 10;
/** lore normalizer (max printed lore) */
export const LORE_NORM = 5;
/** text length bucket upper bounds; bucket 3 = anything longer */
const TEXT_LEN_BOUNDS = [80, 200] as const;

const KEYWORD_REGEXES: Array<RegExp> = KEYWORD_NAMES.map(
  (name) => new RegExp(`\\b${name}\\b`, 'i'),
);

const WHEN_PLAYED_REGEX = /\bwhen you play\b/i;
const ON_PLAY_REGEX = /\bon play\b/i;
const DURING_TURN_REGEX = /\bduring\b[^\n]*\bturns?\b/i;
const NUMERIC_TOKEN_REGEX = /\d+/g;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value)) || 0;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function textLengthBucket(text: string): number {
  if (text.length === 0) return 0;
  if (text.length <= TEXT_LEN_BOUNDS[0]) return 1;
  if (text.length <= TEXT_LEN_BOUNDS[1]) return 2;
  return 3;
}

/**
 * Feature vector for one card identity (FEATURE_DIM dims, card-data only).
 * Fresh Float64Array per call; the heavy name/reference extraction is cached
 * per identity inside names.ts. Pure function, deterministic.
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
  const info = cardNameInfo(card);
  // the shared name block: own parsed names AND text-referenced family
  // names accumulate signed hashes (D2b amendment)
  for (const name of info.names) {
    hashInto(features, NAME_BLOCK_OFFSET, NAME_HASH_WIDTH, name);
  }
  for (const family of info.referencesNames) {
    hashInto(
      features,
      NAME_BLOCK_OFFSET,
      NAME_HASH_WIDTH,
      NAME_FAMILIES[family - 1]!,
    );
  }
  features[UNIQUE_NAME_OFFSET] = info.isUniqueName ? 1 : 0;
  return features;
}

// ---- collision accounting (D2b amendment §3: evidence-driven bucket size) ----

export interface HashCollisionStats {
  /** entries hashed (vocabulary size) */
  entries: number;
  /** block width (frozen buckets) */
  buckets: number;
  /** distinct buckets receiving at least one entry */
  usedBuckets: number;
  /** entries whose bucket holds ≥ 2 distinct entries */
  collidingEntries: number;
  /** collidingEntries / entries */
  collisionRate: number;
}

function blockCollisions(
  values: readonly string[],
  width: number,
): HashCollisionStats {
  const perBucket = new Map<number, number>();
  for (const value of values) {
    const { bucket } = hashBucket(value, width);
    perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
  }
  let collidingEntries = 0;
  for (const count of perBucket.values()) {
    if (count >= 2) collidingEntries += count;
  }
  return {
    entries: values.length,
    buckets: width,
    usedBuckets: perBucket.size,
    collidingEntries,
    collisionRate: Math.round((collidingEntries / values.length) * 1e6) / 1e6,
  };
}

/**
 * Measured collision rate per hashed block on the committed snapshot
 * vocabularies (families, subtypes, keywords, tags). Deterministic; goes
 * into the artifact's training evidence and generator.report.json so a
 * future bucket-size bump is evidence-driven. `nameBlockAllNames` is the
 * supplementary full-load view: every distinct parsed name (families AND
 * single-card names) that lands in the 512-bucket name block at runtime.
 */
export function hashCollisionStats(): Record<
  'nameFamilies' | 'subtypes' | 'keywords' | 'tags' | 'nameBlockAllNames',
  HashCollisionStats
> {
  return {
    nameFamilies: blockCollisions(NAME_FAMILIES, NAME_HASH_WIDTH),
    subtypes: blockCollisions(SUBTYPE_VOCAB, SUBTYPE_HASH_WIDTH),
    keywords: blockCollisions(KEYWORD_VOCAB, KEYWORD_HASH_WIDTH),
    tags: blockCollisions(TAG_VOCAB, TAG_HASH_WIDTH),
    nameBlockAllNames: blockCollisions(
      [...NAME_CARD_COUNTS.keys()].sort(compareStrings),
      NAME_HASH_WIDTH,
    ),
  };
}

// ---- interaction dims (D2b; task 6.2) ----

/**
 * The eight computed candidate↔seed relations, in vector order. Counts are
 * distinct-set sizes (small integers); flags are 0/1. Exact set operations
 * over the family/subtype/type tables — collisions in the hashed blocks
 * cannot corrupt them. Both implementations (training pair construction and
 * runtime scoring) run this exact function — pinned by the all-cards
 * cross-implementation parity test.
 */
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

export const INTERACTION_DIM = INTERACTION_NAMES.length;

/**
 * Per-identity interaction inputs (cheap assembly over the cached
 * names.ts extraction — the heavy text scans are cached there).
 */
export interface CardInteractionProfile {
  /** parsed names, raw (shiftMatch matches exact names, families or not) */
  readonly names: readonly string[];
  /** 0-based NAME_FAMILIES indices the card is named */
  readonly nameFamilies: ReadonlySet<number>;
  /** 0-based NAME_FAMILIES indices referenced by the text */
  readonly refFamilies: ReadonlySet<number>;
  readonly subtypes: ReadonlySet<string>;
  /** subtypes referenced by the text (Grand Duke → Prince/…; Hunny package) */
  readonly refSubtypes: ReadonlySet<string>;
  readonly type: string;
  /** card types referenced by the text (case-insensitive: "…action you play") */
  readonly refTypes: ReadonlySet<string>;
  /** curated keyword is exactly "Shift" (the 341 same-name shift cards) */
  readonly isShift: boolean;
  /** the text references a subtype or name the card itself has */
  readonly selfRefTrait: boolean;
}

export function cardInteractionProfile(card: Card): CardInteractionProfile {
  const info = cardNameInfo(card);
  const nameFamilies = new Set<number>();
  for (const family of info.familyIndices) {
    if (family > 0) nameFamilies.add(family - 1);
  }
  const refFamilies = new Set<number>();
  for (const family of info.referencesNames) refFamilies.add(family - 1);
  const subtypes = new Set(card.subtypes);
  const selfRefTrait =
    info.referencesSubtypes.some((subtype) => subtypes.has(subtype)) ||
    [...refFamilies].some((family) => nameFamilies.has(family));
  return Object.freeze({
    names: info.names,
    nameFamilies: Object.freeze(nameFamilies),
    refFamilies: Object.freeze(refFamilies),
    subtypes: Object.freeze(subtypes),
    refSubtypes: Object.freeze(new Set(info.referencesSubtypes)),
    type: card.type,
    refTypes: Object.freeze(new Set(info.referencesTypes)),
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

/**
 * The eight interaction dims for a candidate given the seed deck's aggregate.
 * Deterministic; allocates a fresh Float64Array(INTERACTION_DIM).
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
