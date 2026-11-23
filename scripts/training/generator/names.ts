/**
 * Schema-v2 name/reference foundation for the learned deck generator
 * (learned-deck-generator design D2b; consumed by the task 6.1/6.2 feature
 * assembly). Pure card-data module: everything derives from the committed
 * snapshot (public/data/cards.min.json) — no engine or arena imports, no
 * randomness, fully deterministic.
 *
 * ## Name parsing
 *
 * `card.name` splits ONLY on the exact separator " & ". Commas, periods and
 * exclamation marks are name characters, never separators: "Fix-It Felix,
 * Jr." is one name (4 prints; no plain "Fix-It Felix" family exists in the
 * snapshot — trimming the ", Jr." would invent one), "Wake Up, Alice!" keeps
 * its "!", and "Hamish, Hubert & Harris" parses to
 * ["Hamish, Hubert", "Harris"]. The composite first element is accepted: no
 * standalone Hamish/Hubert cards exist (verified against the snapshot), and
 * splitting the comma would yield 532 families / 1401 distinct names,
 * breaking the pinned vocabulary below.
 *
 * The card `version` field is never part of `name` (verified snapshot-wide:
 * no version is a substring of its card's parsed names).
 *
 * ## Reference extraction
 *
 * Card text is scanned greedy longest-match-first with span removal: the
 * vocabulary is ordered by length descending, and a matched span is recorded
 * and blocked so a shorter entry contained in it does not double-fire
 * ("Prince" inside "Princess", "Ed" inside "Edna Mode") while separate
 * occurrences of the shorter entry still count. Names and subtypes match
 * case-sensitively; card types match case-insensitively because the type word
 * appears in prose ("…for the next action you play" — that IS a type
 * reference, e.g. Starlight Vial).
 *
 * Measured on the committed snapshot: 1400 distinct parsed names, 37
 * multi-name cards, 531 families (names on >= 2 cards) + 869 unique names,
 * 50 subtypes, 517 cards whose text references at least one name family.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Card } from '../../../src/data/types';

/** codepoint order — locale-independent, so sorting stays deterministic */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Parsed names of a card. " & " is the only multi-name separator; commas,
 * periods and exclamation marks stay part of a name (see module docblock).
 */
export function parseCardNames(name: string): string[] {
  return name.split(' & ').map((part) => part.trim());
}

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

/** parsed name -> number of snapshot cards whose names include it */
export const NAME_CARD_COUNTS: ReadonlyMap<string, number> = (() => {
  const counts = new Map<string, number>();
  for (const card of SNAPSHOT_CARDS) {
    for (const name of parseCardNames(card.name)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
})();

/**
 * The family vocabulary: parsed names appearing on >= 2 cards, sorted
 * ascending (531 entries on the committed snapshot). Names on exactly 1 card
 * are the uniqueName bucket instead — they fold into one flag, no dim.
 */
export const NAME_FAMILIES: readonly string[] = [...NAME_CARD_COUNTS]
  .filter(([, count]) => count >= 2)
  .map(([name]) => name)
  .sort(compareStrings);

const FAMILY_INDEX = new Map(
  NAME_FAMILIES.map((name, index) => [name, index + 1]),
);

/**
 * 1-based index of a name in NAME_FAMILIES, or -1 when the name is on a
 * single card (uniqueName bucket) or unknown to the snapshot vocabulary. The
 * +1 offset keeps 0 available as "no family" for consumers that need it.
 */
export function familyIndex(name: string): number {
  return FAMILY_INDEX.get(name) ?? -1;
}

/** distinct values of card.subtypes across the snapshot, sorted (50 entries) */
export const SUBTYPE_VOCAB: readonly string[] = [
  ...new Set(SNAPSHOT_CARDS.flatMap((card) => card.subtypes)),
].sort(compareStrings);

/** fixed card-type vocabulary for reference extraction, in dim order */
export const CARD_TYPE_VOCAB = [
  'Character',
  'Action',
  'Item',
  'Location',
] as const;

/**
 * Greedy longest-match-first extraction with span removal (see module
 * docblock). Returns matched vocabulary entries deduplicated and sorted —
 * deterministic regardless of vocabulary order.
 */
function extractMentions(
  text: string,
  vocab: readonly string[],
  caseInsensitive: boolean,
): string[] {
  const hay = caseInsensitive ? text.toLowerCase() : text;
  const spans: Array<{ start: number; end: number }> = [];
  const matches = new Set<string>();
  for (const entry of [...vocab].sort((a, b) => b.length - a.length)) {
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

export interface CardNameInfo {
  /** parsed names, in name order */
  readonly names: readonly string[];
  /** familyIndex per parsed name, aligned with `names` (-1 = unique/unknown) */
  readonly familyIndices: readonly number[];
  /** 1-based NAME_FAMILIES indices referenced by the text, ascending */
  readonly referencesNames: readonly number[];
  /** referenced subtypes, sorted */
  readonly referencesSubtypes: readonly string[];
  /** referenced card types, in CARD_TYPE_VOCAB order */
  readonly referencesTypes: readonly string[];
  /** at least one parsed name sits on a single card (or is unknown) */
  readonly isUniqueName: boolean;
}

function computeCardNameInfo(card: Card): CardNameInfo {
  const names = parseCardNames(card.name);
  const text = card.text ?? '';
  const referencedTypes = extractMentions(text, CARD_TYPE_VOCAB, true);
  return Object.freeze({
    names: Object.freeze(names),
    familyIndices: Object.freeze(names.map(familyIndex)),
    referencesNames: Object.freeze(
      extractMentions(text, NAME_FAMILIES, false)
        .map(familyIndex)
        .sort((a, b) => a - b),
    ),
    referencesSubtypes: Object.freeze(
      extractMentions(text, SUBTYPE_VOCAB, false),
    ),
    referencesTypes: Object.freeze(
      CARD_TYPE_VOCAB.filter((type) => referencedTypes.includes(type)),
    ),
    isUniqueName: names.some((name) => (NAME_CARD_COUNTS.get(name) ?? 0) <= 1),
  });
}

/**
 * Per-identity cache keyed by card.id with a name+text fingerprint, so test
 * fixtures that reuse one id for different cards never read a stale entry.
 * Returned objects are frozen — treat them as immutable.
 */
const infoCache = new Map<
  number,
  { fingerprint: string; info: CardNameInfo }
>();

export function cardNameInfo(card: Card): CardNameInfo {
  const fingerprint = `${card.name}\u0000${card.text ?? ''}`;
  const cached = infoCache.get(card.id);
  if (cached && cached.fingerprint === fingerprint) return cached.info;
  const info = computeCardNameInfo(card);
  infoCache.set(card.id, { fingerprint, info });
  return info;
}
