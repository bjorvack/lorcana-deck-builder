/** MAP-Elites descriptor + cell-key tests — synthetic cards, hand-computed values. */
import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import {
  binIndex,
  describeDeck,
  descriptorCell,
  dominantAndSecondary,
} from './map-elites-descriptors';

const mkCard = (over: Partial<Card> & { id: number }): Card => ({
  name: `Card ${over.id}`,
  fullName: `Card ${over.id}`,
  groupKey: `card-${over.id}`,
  inks: ['Amber'],
  isDualInk: false,
  cost: 1,
  inkwell: false,
  type: 'Character',
  subtypes: [],
  isSong: false,
  franchise: 'test',
  setCode: 'TST',
  setName: 'Test',
  setNumber: 1,
  setType: 'expansion',
  rarity: 'common',
  maxCopies: 3,
  text: '',
  keywords: [],
  tags: [],
  deckRuleEffects: [],
  payoffs: [],
  images: {},
  formats: { core: true, infinity: true },
  ...over,
});

// fixture: 10 copies over 4 cards
const charA = mkCard({ id: 1, cost: 2, inkwell: true, lore: 2 }); // 4 copies
const charB = mkCard({ id: 2, cost: 5, inkwell: false, lore: 3 }); // 2 copies
const action = mkCard({ id: 3, cost: 3, type: 'Action' }); // 2 copies
const item = mkCard({ id: 4, cost: 1, inkwell: true, type: 'Item' }); // 2 copies
const cards = [charA, charB, action, item];
const deck = { 1: 4, 2: 2, 3: 2, 4: 2 };

describe('describeDeck', () => {
  it('computes hand-checked descriptor values', () => {
    // avgCost = (4·2 + 2·5 + 2·3 + 2·1) / 10 = 26/10 = 2.6
    // inkable = (4 + 2) / 10 = 0.6; mix = 6/10, 2/10, 2/10
    // lore/turn = (4·2·(10−2) + 2·3·(10−5)) / 10 = (64 + 30) / 10 = 9.4
    expect(describeDeck(deck, cards)).toEqual({
      avgCost: 2.6,
      inkableRatio: 0.6,
      typeMix: { character: 0.6, action: 0.2, item: 0.2 },
      lorePerTurnProxy: 9.4,
    });
  });

  it('ignores unknown identities and non-positive counts', () => {
    expect(describeDeck({ 1: 2, 999: 4, 2: -1 }, cards)).toEqual(
      describeDeck({ 1: 2 }, cards),
    );
  });

  it('yields the zero descriptor for an empty deck', () => {
    expect(describeDeck({}, cards)).toEqual({
      avgCost: 0,
      inkableRatio: 0,
      typeMix: { character: 0, action: 0, item: 0 },
      lorePerTurnProxy: 0,
    });
  });
});

describe('binIndex', () => {
  const quartiles = [0, 0.25, 0.5, 0.75, 1];
  it('places values in right-open bins with the last bin closed', () => {
    expect(binIndex(0, quartiles)).toBe(0);
    expect(binIndex(0.25, quartiles)).toBe(1);
    expect(binIndex(0.6, quartiles)).toBe(2);
    expect(binIndex(0.75, quartiles)).toBe(3);
    expect(binIndex(1, quartiles)).toBe(3);
    expect(binIndex(1.5, quartiles)).toBe(3);
  });

  it('sorts a defensive copy of the edges', () => {
    expect(binIndex(0.6, [1, 0, 0.5, 0.25, 0.75])).toBe(2);
  });
});

describe('descriptorCell', () => {
  it('matches the hand-computed default key', () => {
    // cost: floor(2.6/0.5)=5; ink: 0.6 → bin 2; secondary share 0.2 → bin 2;
    // lore: floor(9.4/0.5)=18
    expect(descriptorCell(describeDeck(deck, cards))).toBe(
      'cost-5_ink-2_mix-character-2_lore-18',
    );
  });

  it('breaks type ties in fixed character > action > item order', () => {
    const tieDeck = { 1: 1, 3: 1, 4: 1 };
    const descriptor = describeDeck(tieDeck, cards);
    expect(dominantAndSecondary(descriptor.typeMix)).toEqual({
      dominant: 'character',
      secondaryShare: 1 / 3,
    });
    // avgCost (2+3+1)/3 = 2 → bin 4; inkable 2/3 → bin 2; secondary 1/3 → bin 3;
    // lore 1·2·(10−2)/10 = 1.6 → bin 3
    expect(descriptorCell(descriptor)).toBe(
      'cost-4_ink-2_mix-character-3_lore-3',
    );
  });

  it('is stable across repeated calls and deck rebuilds', () => {
    const key = descriptorCell(describeDeck(deck, cards));
    expect(
      descriptorCell(describeDeck({ ...deck }, [...cards].reverse())),
    ).toBe(key);
  });

  it('separates descriptors differing in a single dimension', () => {
    const base = describeDeck(deck, cards);
    const taller = { ...base, avgCost: base.avgCost + 0.75 };
    const lessInk = { ...base, inkableRatio: 0.3 };
    const actionHeavy = {
      ...base,
      typeMix: { character: 0.2, action: 0.6, item: 0.2 },
    };
    const moreLore = { ...base, lorePerTurnProxy: base.lorePerTurnProxy + 2 };
    const keys = [taller, lessInk, actionHeavy, moreLore].map((d) =>
      descriptorCell(d),
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys).not.toContain(descriptorCell(base));
  });

  it('honours custom bins', () => {
    const descriptor = describeDeck(deck, cards);
    expect(
      descriptorCell(descriptor, {
        avgCostWidth: 10,
        inkableRatioEdges: [0, 0.5, 1],
        secondaryShareEdges: [0, 1],
        lorePerTurnWidth: 100,
      }),
    ).toBe('cost-0_ink-1_mix-character-0_lore-0');
  });
});
