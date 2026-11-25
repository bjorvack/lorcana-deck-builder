import type { Card, DeckState } from '../data/types';
import type { AddResult } from '../state';
import { applyAdd } from './add';

export function applyVersionSwap(
  deck: DeckState,
  fromId: number,
  toId: number,
  byId: Map<number, Card>,
): { deck: DeckState; result: AddResult } {
  if (fromId === toId) return { deck, result: { status: 'added' } };
  const fromCard = byId.get(fromId);
  const toCard = byId.get(toId);
  if (!fromCard || !toCard) return { deck, result: { status: 'unknown' } };
  if (fromCard.groupKey !== toCard.groupKey)
    return {
      deck,
      result: { status: 'refused', reason: 'Not the same card' },
    };

  const count = deck.cards[fromId] ?? 0;
  if (count <= 0) return { deck, result: { status: 'added' } };

  let next: DeckState = { ...deck, cards: { ...deck.cards } };
  delete next.cards[fromId];

  for (let i = 0; i < count; i++) {
    const { deck: updated, result } = applyAdd(next, toCard, byId);
    if (result.status !== 'added') return { deck, result };
    next = updated;
  }

  return { deck: next, result: { status: 'added' } };
}
