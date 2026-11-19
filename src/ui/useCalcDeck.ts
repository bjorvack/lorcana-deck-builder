import { useMemo } from 'react';
import type { DeckState } from '../data/types';
import { useApp } from '../state';

/**
 * A projection of the deck for expensive computation (validation, stats,
 * Monte Carlo fingerprinting, suggestion scoring). Its identity is stable
 * across title-only edits, so memos and the fingerprint WeakMap cache keyed
 * on it don't invalidate per keystroke. None of those consumers read
 * `deck.title` — display code should keep using the real deck from context.
 */
export function useCalcDeck(): DeckState {
  const { deck } = useApp();
  return useMemo(
    () => ({
      title: '',
      inks: deck.inks,
      format: deck.format,
      cards: deck.cards,
    }),
    [deck.inks, deck.format, deck.cards],
  );
}
