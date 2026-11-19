import { describe, expect, it } from 'vitest';
import type { Card } from '../data/types';
import type { MetaArchetype } from '../meta/infer';
import { validateDeck } from '../rules/engine';
import { byIdMap, makeCard } from '../test/fixtures';
import { generateDeck } from './generator';
import { buildStarterDeck, dominantInks } from './starter';

const cards: Card[] = [
  makeCard({
    id: 1,
    name: 'Ruby Core',
    inks: ['Ruby'],
    cost: 3,
    inkwell: true,
  }),
  makeCard({
    id: 2,
    name: 'Ruby Support',
    inks: ['Ruby'],
    cost: 2,
    inkwell: true,
  }),
  makeCard({
    id: 3,
    name: 'Sapphire Draw',
    inks: ['Sapphire'],
    cost: 3,
    inkwell: true,
  }),
  makeCard({
    id: 4,
    name: 'RS Dual',
    inks: ['Ruby', 'Sapphire'],
    cost: 4,
    inkwell: true,
  }),
  makeCard({
    id: 5,
    name: 'Amber Off',
    inks: ['Amber'],
    cost: 2,
    inkwell: true,
  }),
  makeCard({
    id: 6,
    name: 'Steel Off',
    inks: ['Steel'],
    cost: 5,
    inkwell: true,
  }),
  // enough Ruby/Sapphire mass to complete a 60-card deck
  ...Array.from({ length: 16 }, (_, i) =>
    makeCard({
      id: 20 + i,
      name: `RS Filler ${i}`,
      inks:
        i % 3 === 2
          ? ['Ruby', 'Sapphire']
          : i % 2 === 0
            ? ['Ruby']
            : ['Sapphire'],
      cost: (i % 6) + 1,
      inkwell: i % 4 !== 3,
    }),
  ),
];

const archetype = (centroid: Record<string, number>): MetaArchetype => ({
  id: 1,
  name: 'Ruby Sapphire Tempo',
  observedWinRate: 0.55,
  sampleSize: 120,
  centroid,
});

describe('archetype starter decks', () => {
  it('builds an editable deck from the centroid with dominant inks declared', () => {
    const deck = buildStarterDeck(
      archetype({ 1: 0.15, 2: 0.1, 4: 0.05, 3: 0.05, 5: 0.02 }),
      cards,
      'core',
    )!;
    expect(deck.title).toBe('Ruby Sapphire Tempo');
    expect(deck.inks).toEqual(['Ruby', 'Sapphire']); // top-2 inks by centroid weight
    // off-pair cards are excluded
    expect(deck.cards[5]).toBeUndefined();
    expect(deck.cards[6]).toBeUndefined();
    // copies scale with centroid share, capped at 4
    expect(deck.cards[1]).toBe(4); // 0.15 × 60 = 9 → capped at 4
    expect(deck.cards[2]).toBe(4); // 0.1 × 60 = 6 → capped at 4
    expect(deck.cards[3]).toBe(3); // 0.05 × 60 = 3
    expect(deck.cards[4]).toBe(3);
    expect(
      validateDeck(deck, byIdMap(cards)).filter((v) => v.rule !== 'card-count'),
    ).toEqual([]);
  });

  it('produces zero copy-limit, off-ink and dual-ink violations', () => {
    const deck = buildStarterDeck(
      archetype({ 1: 0.3, 2: 0.25, 3: 0.2, 4: 0.1 }),
      cards,
      'core',
    )!;
    const violations = validateDeck(deck, byIdMap(cards));
    expect(
      violations.filter(
        (v) =>
          v.rule === 'copy-limit' ||
          v.rule === 'off-ink' ||
          v.rule === 'dual-ink',
      ),
    ).toEqual([]);
  });

  it('honors copy-limit exceptions (unlimited cards)', () => {
    const unlimited = makeCard({
      id: 7,
      name: 'Unlimited',
      inks: ['Ruby'],
      maxCopies: 'unlimited',
      inkwell: true,
    });
    const deck = buildStarterDeck(
      archetype({ 7: 0.5, 1: 0.2 }),
      [...cards, unlimited],
      'core',
    )!;
    expect(deck.cards[7]).toBeGreaterThan(4);
  });

  it('returns null when the centroid maps to nothing usable', () => {
    // empty centroid
    expect(buildStarterDeck(archetype({}), cards, 'core')).toBeNull();
    // unknown card ids
    expect(buildStarterDeck(archetype({ 999: 0.5 }), cards, 'core')).toBeNull();
  });

  it('a thin centroid yields a smaller but legal starter', () => {
    const deck = buildStarterDeck(
      archetype({ 1: 0.02, 2: 0.015 }),
      cards,
      'core',
    )!;
    const total = Object.values(deck.cards).reduce((s, c) => s + c, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(60);
    expect(
      validateDeck(deck, byIdMap(cards)).filter((v) => v.rule !== 'card-count'),
    ).toEqual([]);
  });

  it('dominantInks ranks by centroid weight and keeps two', () => {
    const idToCard = byIdMap(cards);
    expect(
      dominantInks(archetype({ 1: 0.4, 2: 0.3, 3: 0.2, 5: 0.1 }), idToCard),
    ).toEqual(['Ruby', 'Sapphire']);
  });

  it('clone + fill the rest completes to 60 legal cards', () => {
    // starter from the centroid, then suggest-fill completion via partial deck
    const starter = buildStarterDeck(
      archetype({ 1: 0.3, 2: 0.25, 3: 0.2, 4: 0.1 }),
      cards,
      'core',
    )!;
    const starterTotal = Object.values(starter.cards).reduce(
      (s, c) => s + c,
      0,
    );
    const result = generateDeck({
      cards,
      inks: starter.inks,
      format: 'core',
      partial: starter.cards,
      seed: 11,
    });
    expect(result.error).toBeUndefined();
    const filled = result.deck!;
    expect(Object.values(filled.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(filled.inks).toEqual(starter.inks);
    // the starter's cards are kept unchanged
    for (const [id, count] of Object.entries(starter.cards)) {
      expect(filled.cards[Number(id)]).toBe(count);
    }
    expect(validateDeck(filled, byIdMap(cards))).toEqual([]);
    expect(starterTotal).toBeLessThan(60); // the completion actually filled
  });
});
