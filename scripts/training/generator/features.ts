/**
 * Snapshot-bound wrapper around `src/shared/card-features` for the learned
 * deck generator training pipeline.
 */
import type { Card } from '../../../src/data/types';
import * as shared from '../../../src/shared/card-features';
import { SNAPSHOT_CARDS_READONLY } from './names';

const snapshotVocab = shared.buildFeatureVocabularies(SNAPSHOT_CARDS_READONLY);

export const FEATURE_SCHEMA_VERSION = shared.FEATURE_SCHEMA_VERSION;
export const KEYWORD_NAMES = shared.KEYWORD_NAMES;
export const FEATURE_NAMES = shared.FEATURE_NAMES;
export const BASE_DIM = shared.BASE_DIM;
export const KEYWORD_HASH_WIDTH = shared.KEYWORD_HASH_WIDTH;
export const SUBTYPE_HASH_WIDTH = shared.SUBTYPE_HASH_WIDTH;
export const TAG_HASH_WIDTH = shared.TAG_HASH_WIDTH;
export const NAME_HASH_WIDTH = shared.NAME_HASH_WIDTH;
export const KEYWORD_BLOCK_OFFSET = shared.KEYWORD_BLOCK_OFFSET;
export const SUBTYPE_BLOCK_OFFSET = shared.SUBTYPE_BLOCK_OFFSET;
export const TAG_BLOCK_OFFSET = shared.TAG_BLOCK_OFFSET;
export const DUAL_SONG_OFFSET = shared.DUAL_SONG_OFFSET;
export const NAME_BLOCK_OFFSET = shared.NAME_BLOCK_OFFSET;
export const UNIQUE_NAME_OFFSET = shared.UNIQUE_NAME_OFFSET;
export const FEATURE_DIM = shared.FEATURE_DIM;
export const INTERACTION_DIM = shared.INTERACTION_DIM;
export const INTERACTION_NAMES = shared.INTERACTION_NAMES;
export const CANDIDATE_DIM = shared.CANDIDATE_DIM;
export const SCORER_INPUT_DIM = shared.SCORER_INPUT_DIM;
export const ENCODER_HIDDEN = shared.ENCODER_HIDDEN;
export const POOL_DIM = shared.POOL_DIM;
export const SCORER_HIDDEN = shared.SCORER_HIDDEN;
export const STAT_NORM = shared.STAT_NORM;
export const LORE_NORM = shared.LORE_NORM;

export { CARD_TYPE_VOCAB, NAME_FAMILIES, SUBTYPE_VOCAB } from './names';

export const KEYWORD_VOCAB: readonly string[] = snapshotVocab.keywordVocab;
export const TAG_VOCAB: readonly string[] = snapshotVocab.tagVocab;

export function cardFeatures(card: Card): Float64Array {
  return shared.cardFeatures(card, snapshotVocab);
}

export function cardInteractionProfile(
  card: Card,
): shared.CardInteractionProfile {
  return shared.cardInteractionProfile(card, snapshotVocab);
}

export function interactionDims(
  profile: shared.CardInteractionProfile,
  aggregate: shared.SeedInteractionAggregate,
): Float64Array {
  return shared.interactionDims(profile, aggregate);
}

export function seedInteractionAggregate(
  profiles: readonly shared.CardInteractionProfile[],
): shared.SeedInteractionAggregate {
  return shared.seedInteractionAggregate(profiles);
}

export function hashCollisionStats(): Record<
  'nameFamilies' | 'subtypes' | 'keywords' | 'tags' | 'nameBlockAllNames',
  shared.HashCollisionStats
> {
  return shared.hashCollisionStats(snapshotVocab);
}

export { fnv1a32 } from '../../../src/shared/hash';

export type CardInteractionProfile = shared.CardInteractionProfile;
export type SeedInteractionAggregate = shared.SeedInteractionAggregate;
export type HashCollisionStats = shared.HashCollisionStats;
