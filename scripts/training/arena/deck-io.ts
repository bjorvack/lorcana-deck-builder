import { readFileSync } from 'node:fs';
import type { Card } from '../../../src/data/types';
import { deckFromText } from '../../../src/deck/codec';
import { buildCanonicalRegistry } from '../canonical';
import type { CardMap, IneligibleReason } from './card-map';

export interface PreparedDeck {
  /** canonical print id → count (identity-level, per D1) */
  cards: Record<string, number>;
  inks: string[];
  title: string;
}

export interface DeckProblem {
  kind: 'count' | 'copies' | 'inks' | 'ineligible' | 'unmatched';
  detail: string;
}

/**
 * Load a deck in the app's plain-text format ("3x Card Name") and reduce it
 * to identity-level counts. Every print of a card aliases to its identity via
 * the canonical registry, so lists written against any printing are
 * equivalent here.
 */
export function prepareDeck(
  path: string,
  cards: Card[],
  alias: Map<number, number>,
): PreparedDeck {
  const text = readFileSync(path, 'utf8');
  const byId = new Map(cards.map((c) => [c.id, c]));
  const { deck, unmatched } = deckFromText(text, byId);
  if (unmatched.length > 0) {
    throw new Error(
      `unmatched card names in ${path}:\n  ${unmatched.join('\n  ')}`,
    );
  }
  const identityCards: Record<string, number> = {};
  for (const [printId, count] of Object.entries(deck.cards)) {
    const identity = alias.get(Number(printId));
    if (identity === undefined) continue;
    identityCards[String(identity)] =
      (identityCards[String(identity)] ?? 0) + count;
  }
  const canonicalById = new Map(cards.map((c) => [c.id, c]));
  const inks = new Set<string>();
  for (const identity of Object.keys(identityCards)) {
    const card = canonicalById.get(Number(identity));
    if (card) for (const ink of card.inks) inks.add(ink);
  }
  return { cards: identityCards, inks: [...inks].sort(), title: deck.title };
}

/** Light eligibility/legality gate — the app owns full rules validation. */
export function deckProblems(
  deck: PreparedDeck,
  _cardMap: CardMap,
  cards: Card[],
): DeckProblem[] {
  const problems: DeckProblem[] = [];
  const total = Object.values(deck.cards).reduce((a, b) => a + b, 0);
  if (total < 60)
    problems.push({ kind: 'count', detail: `${total} cards (minimum 60)` });
  if (deck.inks.length > 2)
    problems.push({
      kind: 'inks',
      detail: `${deck.inks.length} inks: ${deck.inks.join(', ')}`,
    });

  const byId = new Map(cards.map((c) => [c.id, c]));
  const copyLimitByIdentity = new Map<string, number>();
  for (const identity of Object.keys(deck.cards)) {
    const card = byId.get(Number(identity));
    if (card && typeof card.maxCopies === 'number')
      copyLimitByIdentity.set(identity, card.maxCopies);
  }
  // copy limits are enforced per identity group across prints/sets
  for (const [identity, limit] of copyLimitByIdentity) {
    const count = deck.cards[identity] ?? 0;
    if (count > limit) {
      const name = byId.get(Number(identity))?.fullName ?? identity;
      problems.push({
        kind: 'copies',
        detail: `${name}: ${count} copies (limit ${limit})`,
      });
    }
  }
  return problems;
}

/** Identities missing from the engine mapping, grouped by ineligibility reason. */
export function ineligibleIdentities(
  deck: PreparedDeck,
  cardMap: CardMap,
  cards: Card[],
): Array<{ identity: string; name: string; reason: IneligibleReason }> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const missing: Array<{
    identity: string;
    name: string;
    reason: IneligibleReason;
  }> = [];
  for (const identity of Object.keys(deck.cards)) {
    if (cardMap.byIdentity[identity]) continue;
    const card = byId.get(Number(identity));
    missing.push({
      identity,
      name: card?.fullName ?? identity,
      reason: card
        ? card.setType === 'quest'
          ? 'quest'
          : card.rarity.toLowerCase() === 'epic'
            ? 'epic'
            : 'unknown'
        : 'unknown',
    });
  }
  return missing.sort((a, b) => a.name.localeCompare(b.name));
}

export { buildCanonicalRegistry };
