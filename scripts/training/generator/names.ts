/**
 * Snapshot-bound name/reference wrapper for the learned deck generator.
 * The pure primitives live in `src/shared/card-names`; this module applies
 * them to the committed card snapshot and caches per-identity results.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Card } from '../../../src/data/types';
import {
  buildNameVocabularies,
  type CardNameInfo,
  CARD_TYPE_VOCAB as SHARED_CARD_TYPE_VOCAB,
  cardNameInfo as sharedCardNameInfo,
} from '../../../src/shared/card-names';

function loadSnapshotCards(): Card[] {
  const raw = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'public',
        'data',
        'cards.min.json',
      ),
      'utf8',
    ),
  ) as { cards?: Card[] } | Card[];
  const cards = Array.isArray(raw) ? raw : (raw.cards ?? []);
  if (cards.length === 0)
    throw new Error(
      'public/data/cards.min.json is empty; run npm run data:build',
    );
  return cards;
}

const SNAPSHOT_CARDS: Card[] = loadSnapshotCards();

/** the committed snapshot the vocabularies below derive from (read-only) */
export const SNAPSHOT_CARDS_READONLY: readonly Card[] = SNAPSHOT_CARDS;

const snapshotVocab = buildNameVocabularies(SNAPSHOT_CARDS_READONLY);

/** parsed name -> number of snapshot cards whose names include it */
export const NAME_CARD_COUNTS: ReadonlyMap<string, number> =
  snapshotVocab.nameCardCounts;

/** The family vocabulary: parsed names appearing on >= 2 cards, sorted ascending. */
export const NAME_FAMILIES: readonly string[] = snapshotVocab.nameFamilies;

/** distinct values of card.subtypes across the snapshot, sorted */
export const SUBTYPE_VOCAB: readonly string[] = snapshotVocab.subtypes;

/** fixed card-type vocabulary for reference extraction, in dim order */
export const CARD_TYPE_VOCAB: readonly string[] = SHARED_CARD_TYPE_VOCAB;

/**
 * 1-based index of a name in NAME_FAMILIES, or -1 when the name is on a
 * single card (uniqueName bucket) or unknown to the snapshot vocabulary.
 */
export function familyIndex(name: string): number {
  const index = snapshotVocab.familyIndex.get(name);
  return index === undefined ? -1 : index + 1;
}

const infoCache = new Map<
  number,
  { fingerprint: string; info: CardNameInfo }
>();

/**
 * Per-identity cache keyed by card.id with a name+text fingerprint, so test
 * fixtures that reuse one id for different cards never read a stale entry.
 */
export function cardNameInfo(card: Card): CardNameInfo {
  const fingerprint = `${card.name}\u0000${card.text ?? ''}`;
  const cached = infoCache.get(card.id);
  if (cached && cached.fingerprint === fingerprint) return cached.info;
  const info = sharedCardNameInfo(card, snapshotVocab);
  infoCache.set(card.id, { fingerprint, info });
  return info;
}

export type { CardNameInfo } from '../../../src/shared/card-names';
export { parseCardNames } from '../../../src/shared/card-names';
