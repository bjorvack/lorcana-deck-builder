import { describe, expect, it } from 'vitest';
import { extractNameReferences, referenceDecks } from './text-refs';
import type { Card } from '../../src/data/types';

const card = (id: number, fullName: string, text: string, releasedAt?: string): Card =>
  ({
    id,
    name: fullName.split(' - ')[0]!,
    fullName,
    subtypes: [],
    type: 'Character',
    setCode: '1',
    text,
    releasedAt,
  }) as unknown as Card;

describe('text-reference extraction', () => {
  const hiro1 = card(1, 'Hiro Hamada - Armor Designer', 'Shift 5 (You may pay 5 to play this on top of one of your characters named Hiro Hamada.)', '2024-05-17');
  const hiro2 = card(2, 'Hiro Hamada - Team Leader', 'Your Floodborn characters gain Evasive.', '2023-08-18');
  const mickey = card(3, 'Mickey Mouse - Brave Little Tailor', 'When you play this character, if you have a character named Hiro Hamada in play, gain 2 lore.');
  const beast = card(4, 'Beast - Hardheaded', 'Banish chosen character of cost 3 or less.');
  const song = card(5, 'A Whole New World', 'Each player discards their hand and draws 7 cards.');

  const cards = [hiro1, hiro2, mickey, beast, song];

  it('links "named X" text to every print of the referenced character', () => {
    const { refs } = extractNameReferences(cards);
    expect(refs.get(3)).toEqual([1, 2]); // mickey → both hiro prints
    expect(refs.get(1)).toEqual([2]); // hiro1 → hiro2 (shift target), not itself
    expect(refs.get(2)).toBeUndefined(); // hiro2's text mentions no names
  });

  it('does not link unrelated cards or unmentioned names', () => {
    const { refs } = extractNameReferences(cards);
    expect(refs.get(4)).toBeUndefined(); // beast mentions no names
    expect(refs.get(5)).toBeUndefined();
  });

  it('matches full names without substring false positives', () => {
    const a = card(10, 'Belle - Mechanic', 'Gain 1 lore for each Belle - Inventor you have in play.');
    const belleInventor = card(11, 'Belle - Inventor', 'Something.');
    const noise = card(12, 'Bell - Ringer', 'Ring.');
    const { refs } = extractNameReferences([a, belleInventor, noise]);
    expect(refs.get(10)).toEqual([11]); // full-name match, and "Bell" ⊄ "Belle"
  });

  it('builds one deterministic synthetic deck per referencing card with the card doubled', () => {
    const { refs } = extractNameReferences(cards);
    const decks = referenceDecks({ refs }, cards);
    expect(decks.find((d) => d.tokens[0] === 3)).toEqual({
      tokens: [3, 3, 1, 2],
      date: '',
    });
    expect(decks.find((d) => d.tokens[0] === 1)).toEqual({
      tokens: [1, 1, 2],
      date: '2024-05-17',
    });
  });

  it('caps synthetic decks at half the real corpus, cold-start references first', () => {
    const { refs } = extractNameReferences(cards); // 3 referencing cards
    const coldIds = new Set([2]); // hiro2 never appears in real decks
    const decks = referenceDecks({ refs }, cards, { realDecks: 2, coldIds }); // budget 1
    // the only deck referencing a card outside the real corpus wins the slot
    expect(decks).toHaveLength(1);
    expect(decks[0]!.tokens).toContain(2);
  });
});
