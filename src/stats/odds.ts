import type { Card, DeckState } from '../data/types';

const choose = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

export interface OpeningHandOdds {
  handSize: number;
  inkables: number;
  total: number;
  /** exact hypergeometric P(>= 1 inkable in the opening hand) */
  pAtLeast1: number;
  /** exact hypergeometric P(>= 2 inkables in the opening hand) */
  pAtLeast2: number;
}

/**
 * Exact hypergeometric odds of drawing inkables in an opening hand.
 * Assumes the deck is shuffled uniformly and `handSize` cards are drawn.
 */
export function openingHandOdds(deck: DeckState, byId: Map<number, Card>, handSize = 7): OpeningHandOdds | null {
  let total = 0;
  let inkable = 0;
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card || count <= 0) continue;
    total += count;
    if (card.inkwell) inkable += count;
  }
  if (total === 0) return null;

  const h = Math.min(handSize, total);
  const nonInkable = total - inkable;
  const denom = choose(total, h) || 1;
  const pNone = choose(nonInkable, h) / denom;
  const pExactlyOne = (inkable * choose(nonInkable, h - 1)) / denom;

  return {
    handSize: h,
    inkables: inkable,
    total,
    pAtLeast1: 1 - pNone,
    pAtLeast2: inkable >= 2 ? 1 - pNone - pExactlyOne : 0,
  };
}
