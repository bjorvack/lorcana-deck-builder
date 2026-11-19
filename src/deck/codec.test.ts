import { describe, expect, it } from 'vitest';
import type { DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import {
  deckFromText,
  deckToText,
  decodeDeck,
  encodeDeck,
  sanitize,
} from './codec';

const catalog = [
  makeCard({ id: 1, name: 'Aladdin', version: 'Heroic Outlaw' }),
  makeCard({ id: 2, name: 'Elsa', version: 'Spirit of Winter' }),
  makeCard({ id: 3, name: 'Be Prepared' }),
];
const byId = byIdMap(catalog);

const deck: DeckState = {
  title: 'Test',
  inks: ['Amber', 'Ruby'],
  format: 'core',
  cards: { 1: 4, 2: 3, 3: 2 },
};

describe('deck codec', () => {
  it('exports and imports plain text losslessly', () => {
    const text = deckToText(deck, byId);
    expect(text).toBe(
      '4x Aladdin - Heroic Outlaw\n2x Be Prepared\n3x Elsa - Spirit of Winter',
    );
    const result = deckFromText(text, byId, {
      inks: deck.inks,
      format: deck.format,
      title: deck.title,
    });
    expect(result.deck).toEqual(deck);
    expect(result.unmatched).toEqual([]);
  });

  it('accepts alternative count notations', () => {
    const result = deckFromText(
      '2 Aladdin - Heroic Outlaw\nBe Prepared x3',
      byId,
    );
    expect(result.deck.cards).toEqual({ 1: 2, 3: 3 });
  });

  it('reports unmatched lines', () => {
    const result = deckFromText(
      '2x Aladdin - Heroic Outlaw\n2x Nonexistent Card',
      byId,
    );
    expect(result.deck.cards[1]).toBe(2);
    expect(result.unmatched).toEqual(['2x Nonexistent Card']);
  });

  it('round-trips through the URL codec', () => {
    const encoded = encodeDeck(deck);
    expect(decodeDeck(encoded)).toEqual(deck);
  });

  it('sanitize drops malformed entries', () => {
    expect(
      sanitize({
        cards: { 1: 4, bad: 'x', '-2': 3 },
        inks: ['Amber', 5, 'Ruby'],
        format: 'weird',
      }),
    ).toEqual({
      title: 'New Deck',
      inks: ['Amber', 'Ruby'],
      format: 'core',
      cards: { 1: 4 },
    });
  });
});
