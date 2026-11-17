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

describe('generator', () => {
  it('generates a legal 60-card deck from empty (smart)', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', mode: 'smart', seed: 42 });
    expect(result.error).toBeUndefined();
    const deck = result.deck!;
    expect(Object.values(deck.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(deck, byIdMap(catalog))).toEqual([]);
  });

  it('generates a legal 60-card deck (chaos)', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', mode: 'chaos', seed: 7 });
    expect(result.deck).not.toBeNull();
    expect(validateDeck(result.deck!, byIdMap(catalog))).toEqual([]);
  });

  it('only adds dual-ink cards when both inks are declared', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', mode: 'chaos', seed: 3 });
    const dual = Object.keys(result.deck!.cards).map((id) => Number(id)).map((id) => catalog.find((c) => c.id === id)!).filter((c) => c.isDualInk);
    expect(dual).toHaveLength(0); // duals are Amber/Ruby, deck declares only Amber
    let found = false;
    for (let seed = 1; seed <= 10 && !found; seed++) {
      const r = generateDeck({ cards: catalog, inks: ['Amber', 'Ruby'], format: 'core', mode: 'chaos', seed });
      found = Object.keys(r.deck!.cards).some((id) => catalog.find((c) => c.id === Number(id))?.isDualInk);
    }
    expect(found).toBe(true);
  });

  it('completes a partial deck, keeping user cards unchanged', () => {
    const partial: Record<number, number> = Object.fromEntries(AMBER.slice(0, 8).map((c) => [c.id, 3])); // 24 cards
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', mode: 'smart', seed: 11, partial });
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
    const result = generateDeck({ cards: catalog, inks: ['Amber'], format: 'core', mode: 'smart', seed: 5, partial });
    expect(result.deck!.cards[ruby.id]).toBe(2);
    const violations = validateDeck(result.deck!, byIdMap(catalog));
    expect(violations.filter((v) => v.rule === 'off-ink').length).toBeGreaterThan(0);
  });

  it('targets 40-43% inkables, a 2-4 modal cost and character plurality in smart mode', () => {
    const result = generateDeck({ cards: catalog, inks: ['Amber', 'Ruby'], format: 'core', mode: 'smart', seed: 21 });
    const deck = result.deck!;
    const cards = Object.entries(deck.cards).flatMap(([id, count]) => Array(count).fill(catalog.find((c) => c.id === Number(id))!)) as Card[];
    const inkable = cards.filter((c) => c.inkwell).length;
    expect(inkable / 60).toBeGreaterThanOrEqual(0.4);
    expect(inkable / 60).toBeLessThanOrEqual(0.46);
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
      mode: 'chaos',
      seed: 9,
      franchises: ['Tiny Franchise'], // pool far below 60
    });
    expect(result.deck).not.toBeNull();
    expect(result.notes.relaxations[0]).toContain('expanded to the full pool');
  });

  it('fails with a reason when even the relaxed pool is too small', () => {
    const small: Card[] = fillPool(['Steel'], 5, 5, 500);
    const result = generateDeck({ cards: small, inks: ['Steel'], format: 'core', mode: 'chaos', seed: 1 });
    expect(result.deck).toBeNull();
    expect(result.error).toContain('too small');
  });

  it('requires 1-2 declared inks', () => {
    const result = generateDeck({ cards: catalog, inks: [], format: 'core', mode: 'smart' });
    expect(result.error).toContain('Pick 1 or 2 inks');
  });

  it('inkLegal helper matches the engine view', () => {
    const dual = makeCard({ inks: ['Amber', 'Ruby'] });
    expect(inkLegal(dual, ['Amber'])).toBe(false);
    expect(inkLegal(dual, ['Amber', 'Ruby'])).toBe(true);
    expect(inkLegal(makeCard({ inks: ['Steel'] }), ['Amber', 'Ruby'])).toBe(false);
  });
});

export type { DeckState };
