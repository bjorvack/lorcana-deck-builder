import type { Card } from '../data/types';

/**
 * Canonical card identity (D1): one embedding identity per card — the latest
 * print of a full name. Prints group on `groupKey` (normalized full name,
 * already emitted in the snapshot); the canonical representative is the print
 * with the newest `releasedAt`, tiebreak highest `setCode`, final tiebreak
 * lowest id so the pick stays fully deterministic. Every print aliases to that
 * identity, so reprints never duplicate embeddings and wording/keyword/
 * classification changes in a newer print flow in via the snapshot.
 *
 * Shared by the trainer (fed from cards.min.json) and the client (fed from the
 * app's live card list) — one implementation, so the two sides can never
 * disagree about identity.
 */
export interface CanonicalRegistry {
  /** groupKey → canonical (newest) print */
  canonicalByGroup: Map<string, Card>;
  /** every print id → its group's canonical print id */
  alias: Map<number, number>;
}

export function buildCanonicalRegistry(cards: Card[]): CanonicalRegistry {
  const canonicalByGroup = new Map<string, Card>();
  for (const card of cards) {
    const current = canonicalByGroup.get(card.groupKey);
    if (!current || isNewerPrint(card, current))
      canonicalByGroup.set(card.groupKey, card);
  }
  const alias = new Map<number, number>();
  for (const card of cards) {
    const canonical = canonicalByGroup.get(card.groupKey);
    if (canonical) alias.set(card.id, canonical.id);
  }
  return { canonicalByGroup, alias };
}

/** printId → canonical print id, for canonicalizing deck lists and vectors */
export function canonicalAlias(cards: Card[]): Map<number, number> {
  return buildCanonicalRegistry(cards).alias;
}

function isNewerPrint(a: Card, b: Card): boolean {
  const dateA = a.releasedAt ?? '';
  const dateB = b.releasedAt ?? '';
  if (dateA !== dateB) return dateA > dateB;
  const codeCmp = compareSetCodes(a.setCode, b.setCode);
  if (codeCmp !== 0) return codeCmp > 0;
  return a.id < b.id;
}

/** numeric set codes compare numerically (2 > 10 as strings is wrong); others lexicographically */
function compareSetCodes(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '')
    return na - nb;
  return a.localeCompare(b);
}
