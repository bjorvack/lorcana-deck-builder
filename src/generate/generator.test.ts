import { describe, expect, it } from 'vitest';
import { generateDeck, inkLegal } from './generator';
import { byIdMap, fillPool, makeCard } from '../test/fixtures';
import { validateDeck } from '../rules/engine';
import type { Card, DeckState } from '../data/types';

const AMBER: Card[] = fillPool(['Amber'], 30, 10, 100);
const RUBY: Card[] = fillPool(['Ruby'], 30, 10, 200);
const duals: Card[] = Array.from({ length: 8 }, (_, i) =>
  makeCard({ id: 900 + i, name: `Dual ${i}`, inks: ['Amber', 'Ruby'], cost: (i % 4) + 2, inkwell: true })
);
const catalog = [...AMBER, ...RUBY, ...duals];

const cardsOf = (deck: DeckState, list: Card[]): Card[] =>
  Object.entries(deck.cards).flatMap(([id, count]) => Array(count).fill(list.find((c) => c.id === Number(id))!)) as Card[];

describe('generator', () => {
  it('generates a legal 60-card deck from empty (middle slider)', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 42 });
    expect(result.error).toBeUndefined();
    const deck = result.deck!;
    expect(Object.values(deck.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(deck, byIdMap(catalog))).toEqual([]);
  });

  it('generates a legal deck at the novel end with high temperature', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', novelty: 1, seed: 7 });
    expect(result.deck).not.toBeNull();
    expect(validateDeck(result.deck!, byIdMap(catalog))).toEqual([]);
  });

  it('only adds dual-ink cards when both inks are declared', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 3 });
    const dual = Object.keys(result.deck!.cards).map((id) => Number(id)).map((id) => catalog.find((c) => c.id === id)!).filter((c) => c.isDualInk);
    expect(dual).toHaveLength(0); // duals are Amber/Ruby, deck declares only Amber
    let found = false;
    for (let seed = 1; seed <= 10 && !found; seed++) {
      const r = generateDeck({ cards: catalog, inks: ['Amber', 'Ruby'], format: 'core', seed });
      found = Object.keys(r.deck!.cards).some((id) => catalog.find((c) => c.id === Number(id))?.isDualInk);
    }
    expect(found).toBe(true);
  });

  it('completes a partial deck, keeping user cards unchanged', () => {
    const partial: Record<number, number> = Object.fromEntries(AMBER.slice(0, 8).map((c) => [c.id, 3])); // 24 cards
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 11, partial });
    const deck = result.deck!;
    for (const [id, count] of Object.entries(partial)) {
      expect(deck.cards[Number(id)]).toBe(count);
    }
    expect(Object.values(deck.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(deck, byIdMap(catalog))).toEqual([]);
    expect(result.notes.notes[0]).toContain('24 cards');
  });

  it('keeps an off-ink partial card and lets validation report it', () => {
    const ruby = RUBY[0]!;
    const partial: Record<number, number> = { [ruby.id]: 2 };
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 5, partial });
    expect(result.deck!.cards[ruby.id]).toBe(2);
    const violations = validateDeck(result.deck!, byIdMap(catalog));
    expect(violations.filter((v) => v.rule === 'off-ink').length).toBeGreaterThan(0);
  });

  it('targets 70-85% inkables, a 2-4 modal cost and character plurality at the middle slider', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber', 'Ruby'], format: 'core', seed: 21 });
    const deck = result.deck!;
    const cards = cardsOf(deck, catalog);
    const inkable = cards.filter((c) => c.inkwell).length;
    expect(inkable / 60).toBeGreaterThanOrEqual(0.7);
    expect(inkable / 60).toBeLessThanOrEqual(0.85);
    // completing a partial deck re-balances toward the same band
    const partial: Record<number, number> = Object.fromEntries(AMBER.slice(0, 10).map((c) => [c.id, 3])); // 30 inkable cards
    const completed = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 8, partial });
    const completedCards = cardsOf(completed.deck!, catalog);
    const completedInkable = completedCards.filter((c) => c.inkwell).length;
    expect(completedInkable / 60).toBeGreaterThanOrEqual(0.7);
    expect(completedInkable / 60).toBeLessThanOrEqual(0.85);
    const costs = cards.map((c) => c.cost);
    const mode = costs.sort((a, b) => a - b)[Math.floor(costs.length / 2)]!;
    expect(mode).toBeGreaterThanOrEqual(2);
    expect(mode).toBeLessThanOrEqual(4);
    const byType: Record<string, number> = {};
    for (const c of cards) byType[c.type] = (byType[c.type] ?? 0) + 1;
    const top = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]!;
    expect(top[0]).toBe('Character');
  });

  it('relaxes optional filters and reports it', () => {
    const result = generateDeck({
      cards: catalog,
      inks: ['Amber'],
      format: 'core',
      seed: 9,
      franchises: ['Tiny Franchise'], // pool far below 60
    });
    expect(result.deck).not.toBeNull();
    expect(result.notes.relaxations[0]).toContain('expanded to the full pool');
  });

  it('unions multiple franchise filters without relaxing', () => {
    const franchiseA: Card[] = Array.from({ length: 15 }, (_, i) =>
      makeCard({ id: 4000 + i, name: `FA ${i}`, inks: ['Amber'], franchise: 'Franchise A', inkwell: true })
    );
    const franchiseB: Card[] = Array.from({ length: 15 }, (_, i) =>
      makeCard({ id: 4100 + i, name: `FB ${i}`, inks: ['Amber'], franchise: 'Franchise B', inkwell: true })
    );
    const smallCatalog = [...franchiseA, ...franchiseB];

    // single franchise: 15*4 = 60 exactly — fills without relaxation
    const single = generateDeck({ cards: smallCatalog, inks: ['Amber'], format: 'core', seed: 2, franchises: ['Franchise A'] });
    expect(single.deck).not.toBeNull();
    expect(single.notes.relaxations).toHaveLength(0);
    const singleNames = Object.keys(single.deck!.cards).map((id) => smallCatalog.find((c) => c.id === Number(id))!.franchise);
    expect(new Set(singleNames)).toEqual(new Set(['Franchise A']));

    // both franchises union: pool of 30 cards → still legal, no relaxation
    const both = generateDeck({ cards: smallCatalog, inks: ['Amber'], format: 'core', seed: 2, franchises: ['Franchise A', 'Franchise B'] });
    expect(both.deck).not.toBeNull();
    expect(both.notes.relaxations).toHaveLength(0);
    const bothNames = Object.keys(both.deck!.cards).map((id) => smallCatalog.find((c) => c.id === Number(id))!.franchise);
    expect(new Set(bothNames).size).toBe(2);
  });

  it('unions multiple set filters', () => {
    const set1: Card[] = Array.from({ length: 15 }, (_, i) =>
      makeCard({ id: 4200 + i, name: `S1C ${i}`, inks: ['Ruby'], setCode: '1' })
    );
    const set2: Card[] = Array.from({ length: 15 }, (_, i) =>
      makeCard({ id: 4300 + i, name: `S2C ${i}`, inks: ['Ruby'], setCode: '2' })
    );
    const result = generateDeck({ cards: [...set1, ...set2], inks: ['Ruby'], format: 'core', seed: 4, sets: ['1', '2'] });
    expect(result.deck).not.toBeNull();
    expect(result.notes.relaxations).toHaveLength(0);
    const setCodesUsed = new Set(Object.keys(result.deck!.cards).map((id) => [...set1, ...set2].find((c) => c.id === Number(id))!.setCode));
    expect(setCodesUsed).toEqual(new Set(['1', '2']));
  });

  it('fails with a reason when even the relaxed pool is too small', () => {
    const small: Card[] = fillPool(['Steel'], 5, 5, 500);
    const result = generateDeck({ cards: small, inks: ['Steel'], format: 'core', seed: 1 });
    expect(result.deck).toBeNull();
    expect(result.error).toContain('too small');
  });

  it('treats an empty ink selection as auto (ink-emergent) instead of erroring', () => {
    const result = generateDeck({ cards: catalog, inks: [], format: 'core', seed: 31 });
    expect(result.error).toBeUndefined();
    const deck = result.deck!;
    expect(Object.values(deck.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(deck, byIdMap(catalog))).toEqual([]);
    expect(deck.inks.length).toBeGreaterThanOrEqual(1);
    expect(deck.inks.length).toBeLessThanOrEqual(2);
  });

  it('inkLegal helper matches the engine view', () => {
    const dual = makeCard({ inks: ['Amber', 'Ruby'] });
    expect(inkLegal(dual, ['Amber'])).toBe(false);
    expect(inkLegal(dual, ['Amber', 'Ruby'])).toBe(true);
    expect(inkLegal(makeCard({ inks: ['Steel'] }), ['Amber', 'Ruby'])).toBe(false);
  });

  it('is deterministic for the same seed and slider, and varies across seeds', () => {
    const a = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', novelty: 0.5, seed: 123 });
    const b = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', novelty: 0.5, seed: 123 });
    expect(a.deck!.cards).toEqual(b.deck!.cards);
    const c = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', novelty: 0.5, seed: 124 });
    expect(c.deck!.cards).not.toEqual(a.deck!.cards);
  });

  it('produces multiplicities without copy-limit violations (copy policy)', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber', 'Ruby'], format: 'core', seed: 77 });
    const deck = result.deck!;
    const distinct = Object.keys(deck.cards).length;
    expect(Object.values(deck.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(distinct).toBeLessThan(60); // multiplicities exist
    expect(validateDeck(deck, byIdMap(catalog)).filter((v) => v.rule === 'copy-limit')).toEqual([]);
  });

  it('polish is off by default and only keeps legality-clean improvements when on', () => {
    const plain = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 55 });
    expect(plain.notes.notes.some((n) => n.startsWith('Polish'))).toBe(false);
    const polished = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', seed: 55, polish: true });
    expect(polished.deck).not.toBeNull();
    expect(validateDeck(polished.deck!, byIdMap(catalog))).toEqual([]);
  });
});
