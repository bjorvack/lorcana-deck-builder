import type { Card } from '../data/types';

export const CARD_TYPE_VOCAB: readonly string[] = [
  'Character',
  'Action',
  'Item',
  'Location',
];

export interface NameVocabularies {
  subtypes: readonly string[];
  nameFamilies: readonly string[];
  sortedNameFamilies: readonly string[];
  sortedSubtypes: readonly string[];
  subtypeIndex: ReadonlyMap<string, number>;
  familyIndex: ReadonlyMap<string, number>;
  nameCardCounts: ReadonlyMap<string, number>;
  cardTypeVocab: readonly string[];
}

/** codepoint order — locale-independent, so sorting stays deterministic */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Parsed names of a card. " & " splits multi-CHARACTER names only; other card
 * types keep their full name as a single name.
 */
export function parseCardNames(name: string, type?: string): string[] {
  if (type !== undefined && type !== 'Character') return [name.trim()];
  return name.split(' & ').map((part) => part.trim());
}

/**
 * Greedy longest-match-first extraction with span removal: a matched span is
 * recorded and blocked so a shorter entry contained in it does not double-fire,
 * while separate occurrences of the shorter entry still count. Returns matches
 * deduplicated and sorted ascending.
 */
export function extractMentions(
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

export function buildNameVocabularies(
  cards: readonly Card[],
): NameVocabularies {
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

export function cardNameInfo(
  card: Card,
  vocab: NameVocabularies,
): CardNameInfo {
  const names = parseCardNames(card.name, card.type);
  const text = card.text ?? '';
  const referencedTypes = extractMentions(text, vocab.cardTypeVocab, true);
  const mentions = extractMentions(text, vocab.sortedNameFamilies, false);
  const familyIndices = names.map((name) => {
    const index = vocab.familyIndex.get(name);
    return index === undefined ? -1 : index + 1;
  });
  const referencesNames = mentions
    .map((name) => vocab.familyIndex.get(name))
    .filter((index): index is number => index !== undefined)
    .map((index) => index + 1)
    .sort((a, b) => a - b);
  const referencesSubtypes = extractMentions(text, vocab.sortedSubtypes, false);
  const referencesTypes = CARD_TYPE_VOCAB.filter((type) =>
    referencedTypes.includes(type),
  );
  const isUniqueName = names.some(
    (name) => (vocab.nameCardCounts.get(name) ?? 0) <= 1,
  );
  return Object.freeze({
    names: Object.freeze(names),
    familyIndices: Object.freeze(familyIndices),
    referencesNames: Object.freeze(referencesNames),
    referencesSubtypes: Object.freeze(referencesSubtypes),
    referencesTypes: Object.freeze(referencesTypes),
    isUniqueName,
  });
}
