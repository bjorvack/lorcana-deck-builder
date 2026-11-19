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

  it('round-trips non-Latin-1 titles through the URL codec', () => {
    const titled = { ...deck, title: 'Héllo — “deck” 🧙' };
    // used to throw InvalidCharacterError inside btoa
    const encoded = encodeDeck(titled);
    expect(decodeDeck(encoded)).toEqual(titled);
  });

  it('decodes legacy Latin-1 share links', () => {
    const json = JSON.stringify({
      t: 'Café',
      i: ['Amber'],
      f: 'core',
      c: [[1, 4]],
    });
    const legacy = btoa(json)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeDeck(legacy)?.title).toBe('Café');
  });

  it('sanitize rejects non-finite counts and unknown inks', () => {
    expect(
      sanitize({
        cards: { 1: Number.POSITIVE_INFINITY, 2: 2.7, 3: Number.NaN },
        inks: ['Amber', 'Pink', 'Ruby', 'Steel'],
      }),
    ).toEqual({
      title: 'New Deck',
      inks: ['Amber', 'Ruby'],
      format: 'core',
      cards: { 2: 2 },
    });
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
