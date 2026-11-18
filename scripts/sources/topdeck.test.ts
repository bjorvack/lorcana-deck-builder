import { describe, expect, it } from 'vitest';
import { parseDecklist, normalize, type CardIndex } from './topdeck';

const index: CardIndex[] = [
  { id: 1, fullName: 'Ariel - Spectacular Singer', setCode: '1', collectorNumber: '2' },
  { id: 2, fullName: 'Strength of a Raging Fire', setCode: '11', collectorNumber: '29' },
];

describe('topdeck adapter', () => {
  it('parses decklist text by collector code, with name fallback', () => {
    const list = '4 Ariel - Spectacular Singer (1-2)\n2 Unknown Card (99-1)\n4 Strength of a Raging Fire (11-29)\n3 Chernabog - Unnatural Force (11-77)';
    const r = parseDecklist(list, index);
    expect(r.cards).toEqual([
      { cardId: 1, count: 4 },
      { cardId: 2, count: 4 },
    ]);
    expect(r.unmatched).toEqual([
      { name: 'Unknown Card', code: '99-1', count: 2 },
      { name: 'Chernabog - Unnatural Force', code: '11-77', count: 3 },
    ]);
  });

  it('normalizes dashes and quotes in names', () => {
    expect(normalize('Ariel – Spectacular Singer')).toBe(normalize('Ariel - Spectacular Singer'));
    expect(normalize("Max Goof - Rebellious Teen")).toBe('max goof - rebellious teen');
  });

  it('returns empty for empty lists', () => {
    expect(parseDecklist('', index)).toEqual({ cards: [], unmatched: [] });
  });
});
