import type { Card, DeckState, Ink } from '../data/types';
import { canAddCard } from '../rules/engine';
import type { AddResult } from '../state';

/**
 * The single add-card path (card-first creation): every surface adds through
 * this. Inks emerge from the cards — a card added to a deck with 0 or 1
 * declared inks auto-declares its ink(s); anything a 2-ink deck cannot cover
 * is refused with the same explained reason everywhere.
 */
export function applyAdd(
  deck: DeckState,
  card: Card,
  byId: Map<number, Card>
): { deck: DeckState; result: AddResult } {
  const nextInks = [...new Set([...deck.inks, ...card.inks])] as Ink[];
  const hypothetical: DeckState = {
    ...deck,
    inks: nextInks.length <= 2 ? nextInks : deck.inks,
    cards: { ...deck.cards, [card.id]: (deck.cards[card.id] ?? 0) + 1 },
  };
  const check = canAddCard(hypothetical, card, byId);
  if (!check.ok) return { deck, result: { status: 'refused', reason: check.reason ?? 'Cannot add this card' } };
  return { deck: hypothetical, result: { status: 'added' } };
}
