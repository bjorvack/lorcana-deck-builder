import type { Card } from '../data/types';
import {
  CARD_TYPE_VOCAB,
  compareStrings,
  extractMentions,
  type NameVocabularies,
  parseCardNames,
} from './card-names';
import { fnv1a32 } from './hash';

export { CARD_TYPE_VOCAB, compareStrings };

/** per-card feature vector version; bump when the feature layout changes meaning */
export const FEATURE_SCHEMA_VERSION = 2;

// pinned DeepSets architecture constants — must match the trained artifact
export const ENCODER_HIDDEN = 32;
export const POOL_DIM = 16;
export const SCORER_HIDDEN = 16;

// frozen hashed-block widths + offsets
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

/** text-derived keyword flags, in vector order (index 6–15) */
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

export const STAT_NORM = 10;
export const LORE_NORM = 5;
export const TEXT_LEN_BOUNDS = [80, 200] as const;

/** cost bucket used by the text feature vector and the suggest-fill band counts */
export const costBand = (cost: number): number =>
  cost <= 2 ? 0 : cost <= 4 ? 1 : cost <= 6 ? 2 : 3;

export const KEYWORD_REGEXES: Array<RegExp> = KEYWORD_NAMES.map(
  (name) => new RegExp(`\\b${name}\\b`, 'i'),
);

const WHEN_PLAYED_REGEX = /\bwhen you play\b/i;
const ON_PLAY_REGEX = /\bon play\b/i;
const DURING_TURN_REGEX = /\bduring\b[^\n]*\bturns?\b/i;
const NUMERIC_TOKEN_REGEX = /\d+/g;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value)) || 0;

function textLengthBucket(text: string): number {
  if (text.length === 0) return 0;
  if (text.length <= TEXT_LEN_BOUNDS[0]) return 1;
  if (text.length <= TEXT_LEN_BOUNDS[1]) return 2;
  return 3;
}

export interface FeatureVocabularies extends NameVocabularies {
  keywordVocab: readonly string[];
  tagVocab: readonly string[];
}

const featureVocabCache = new WeakMap<object, FeatureVocabularies>();

export function buildFeatureVocabularies(
  cards: readonly Card[],
): FeatureVocabularies {
  const cached = featureVocabCache.get(cards);
  if (cached) return cached;
  const base = buildNameVocabulariesMaybeReused(cards);
  const keywords = [...new Set(cards.flatMap((card) => card.keywords))].sort(
    compareStrings,
  );
  const tags = [
    ...new Set(cards.flatMap((card) => card.tags.map((tag) => tag.tag))),
  ].sort(compareStrings);
  const vocab: FeatureVocabularies = {
    ...base,
    keywordVocab: keywords,
    tagVocab: tags,
  };
  featureVocabCache.set(cards, vocab);
  return vocab;
}

function buildNameVocabulariesMaybeReused(
  cards: readonly Card[],
): NameVocabularies {
  // card-features builds on top of card-names, but we only need the public
  // helper from there; keep a single implementation.
  const nameCounts = new Map<string, number>();
  const allSubtypes = new Set<string>();
  for (const card of cards) {
    for (const name of parseCardNames(card.name, card.type)) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    for (const subtype of card.subtypes) {
      allSubtypes.add(subtype);
    }
  }
  const nameFamilies = [...nameCounts]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort(compareStrings);
  const subtypes = [...allSubtypes].sort(compareStrings);
  const familyIndex = new Map(nameFamilies.map((name, i) => [name, i]));
  const subtypeIndex = new Map(subtypes.map((name, i) => [name, i]));
  return {
    subtypes,
    nameFamilies,
    sortedNameFamilies: [...nameFamilies].sort((a, b) => b.length - a.length),
    sortedSubtypes: [...subtypes].sort((a, b) => b.length - a.length),
    subtypeIndex,
    familyIndex,
    nameCardCounts: nameCounts,
    cardTypeVocab: CARD_TYPE_VOCAB,
  };
}

/** bucket/sign of one hashed string within a `width`-bucket block */
function hashBucket(
  value: string,
  width: number,
): { bucket: number; sign: number } {
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

/** Feature vector for one card identity (FEATURE_DIM dims, card-data only). */
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
  features[UNIQUE_NAME_OFFSET] = names.some(
    (name) => (vocab.nameCardCounts.get(name) ?? 0) <= 1,
  )
    ? 1
    : 0;
  return features;
}

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

/** candidate↔seed interaction dim labels, in vector order */
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
export const CANDIDATE_DIM = FEATURE_DIM + INTERACTION_DIM;
export const SCORER_INPUT_DIM = CANDIDATE_DIM + POOL_DIM;

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
  const refTypes = new Set(extractMentions(text, vocab.cardTypeVocab, true));
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

export interface HashCollisionStats {
  entries: number;
  buckets: number;
  usedBuckets: number;
  collidingEntries: number;
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

export function hashCollisionStats(
  vocab: FeatureVocabularies,
): Record<
  'nameFamilies' | 'subtypes' | 'keywords' | 'tags' | 'nameBlockAllNames',
  HashCollisionStats
> {
  return {
    nameFamilies: blockCollisions(vocab.nameFamilies, NAME_HASH_WIDTH),
    subtypes: blockCollisions(vocab.subtypes, SUBTYPE_HASH_WIDTH),
    keywords: blockCollisions(vocab.keywordVocab, KEYWORD_HASH_WIDTH),
    tags: blockCollisions(vocab.tagVocab, TAG_HASH_WIDTH),
    nameBlockAllNames: blockCollisions(
      [...vocab.nameCardCounts.keys()].sort(compareStrings),
      NAME_HASH_WIDTH,
    ),
  };
}
