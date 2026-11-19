import { describe, expect, it } from 'vitest';
import type { Card, DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { payoffHint } from './SuggestionRow';

const shift = (overrides: Partial<Card>): Card =>
  ({
    ...makeCard({
      id: 10,
      name: 'Hiro - Band Leader',
      inks: ['Ruby'],
      text: 'Shift',
    }),
    payoffs: [
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'ink', amount: 3 },
        names: ['Hiro'],
      },
    ],
    ...overrides,
  }) as Card;

const deckOf = (cards: Card[]): DeckState => ({
  title: 'T',
  inks: ['Ruby'],
  format: 'core',
  cards: Object.fromEntries(cards.map((c) => [c.id, 4])),
});

describe('payoff hints (suggestion rows)', () => {
  const byId = byIdMap([
    makeCard({ id: 1, name: 'Deck Filler' }),
    makeCard({ id: 2, name: 'Hiro - Armor Designer', inks: ['Ruby'] }),
    makeCard({ id: 3, name: 'Puppy Pal', subtypes: ['Puppy'] }),
  ]);

  it('hints when the candidate completes a deck card’s shift target', () => {
    const deck = deckOf([byId.get(2)!]);
    expect(payoffHint(shift({}), deck, byId)).toBe(
      'completes the Shift target for Hiro',
    );
  });

  it('hints keyword grants to the deck’s characters', () => {
    const granter: Card = {
      ...makeCard({ id: 11, name: 'Ward Giver', text: 'gain Ward' }),
      payoffs: [{ kind: 'keywordGrant', keyword: 'Ward' }],
    } as Card;
    const deck = deckOf([byId.get(1)!]);
    expect(payoffHint(granter, deck, byId)).toBe(
      'grants Ward to your characters',
    );
  });

  it('hints classification payoffs when the deck has the classification', () => {
    const puppyPayoff: Card = {
      ...makeCard({
        id: 12,
        name: 'Puppy Booster',
        text: 'Your Puppy characters gain Ward.',
      }),
      payoffs: [{ kind: 'classification', classification: 'Puppy' }],
    } as Card;
    const deck = deckOf([byId.get(3)!]);
    expect(payoffHint(puppyPayoff, deck, byId)).toBe(
      'boosts your Puppy characters',
    );
  });

  it('returns no hint when nothing matches the deck', () => {
    const emptyDeck = deckOf([]);
    expect(payoffHint(shift({}), emptyDeck, byId)).toBeUndefined();
    const unrelatedDeck = deckOf([byId.get(1)!]);
    expect(payoffHint(shift({}), unrelatedDeck, byId)).toBeUndefined();
  });
});
