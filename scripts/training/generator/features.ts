/**
 * Card-data-only feature extraction for the learned deck generator
 * (learned-deck-generator, task 1.3; spec learned-deck-completion
 * "Card-data-only features").
 *
 * Features are a pure function of the committed card snapshot fields — no
 * tournament, co-occurrence or archive statistics — so new sets stay usable
 * without re-mining. Keyword and phrasing flags derive from the body text
 * (card.text is rules text; flavor text is not part of the card record), not
 * from the curated `keywords` array, so the schema only depends on raw
 * committed data.
 *
 * Exact feature vector layout (index → name, see FEATURE_NAMES):
 *
 *     0  cost            card.cost / 10, clamped to [0, 1]
 *     1  inkable         card.inkwell ? 1 : 0
 *     2  type.character  type === 'Character' ? 1 : 0
 *     3  type.action     type === 'Action' ? 1 : 0
 *     4  type.item       type === 'Item' ? 1 : 0
 *     5  type.other      everything else (Location, …) ? 1 : 0
 *    6–15 keywords      word-boundary, case-insensitive match of the keyword
 *                       in card.text → 1 : 0, in this order:
 *                       rush, evasive, singer, ward, resist, challenger,
 *                       support, reckless, bodyguard, shift
 *    16  willpower       (card.willpower ?? 0) / 10, clamped to [0, 1]
 *    17  strength        (card.strength ?? 0) / 10, clamped to [0, 1]
 *    18  lore            (card.lore ?? 0) / 5, clamped to [0, 1]
 *    19  textLengthBucket 0 = no text, 1 = ≤ 80 chars, 2 = ≤ 200, 3 = more;
 *                        stored as bucket / 3
 *    20  numericTokens   count of /\d+/g matches in text, capped at 5 → /5
 *    21  hasWhenPlayed   /\bwhen you play\b/i in text → 1 : 0
 *    22  hasOnPlay       /\bon play\b/i in text → 1 : 0
 *    23  hasDuringTurn   /\bduring\b[^\n]*\bturns?\b/i in text → 1 : 0
 *
 * Bump FEATURE_SCHEMA_VERSION whenever this list changes meaning; the corpus
 * and the trained artifact both carry it so stale artifacts degrade cleanly.
 */
import type { Card } from '../../../src/data/types';

export const FEATURE_SCHEMA_VERSION = 1;

/** keyword flags, in vector order (index 6–15) */
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
] as const;

export const FEATURE_DIM = FEATURE_NAMES.length;

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

function textLengthBucket(text: string): number {
  if (text.length === 0) return 0;
  if (text.length <= TEXT_LEN_BOUNDS[0]) return 1;
  if (text.length <= TEXT_LEN_BOUNDS[1]) return 2;
  return 3;
}

/**
 * Feature vector for one card identity. Fresh Float64Array per call; depends
 * only on the card record (pure function, deterministic).
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
