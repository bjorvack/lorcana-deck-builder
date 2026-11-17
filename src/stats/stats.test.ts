import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';
import { openingHandOdds } from './odds';
import { byIdMap, makeCard } from '../test/fixtures';
import type { DeckState } from '../data/types';

const byId = byIdMap([
  makeCard({ id: 1, name: 'A', cost: 1, inkwell: true, tags: [{ tag: 'removal', by: 'rule' }] }),
  makeCard({ id: 2, name: 'B', cost: 3, inkwell: true, strength: 4, willpower: 5, lore: 2 }),
  makeCard({ id: 3, name: 'C', cost: 5, inkwell: false, type: 'Action' }),
  makeCard({ id: 4, name: 'D', cost: 2, inkwell: true, inks: ['Amber', 'Ruby'] }),
]);

const deck: DeckState = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 24, 2: 20, 3: 10, 4: 6 } };

describe('stats', () => {
  it('reports inkability overall (24+20+6 inkable of 60 = 83%)', () => {
    const s = computeStats(deck, byId);
    expect(s.total).toBe(60);
    expect(s.inkable).toBe(50);
    expect(s.inkablePct).toBeCloseTo(50 / 60);
  });

  it('splits inkability per cost bucket', () => {
    const s = computeStats(deck, byId);
    const cost1 = s.inkabilityByCost.find((b) => b.cost === 1)!;
    const cost5 = s.inkabilityByCost.find((b) => b.cost === 5)!;
    expect(cost1).toEqual({ cost: 1, inkable: 24, notInkable: 0 });
    expect(cost5).toEqual({ cost: 5, inkable: 0, notInkable: 10 });
  });

  it('counts dual-ink cards toward both inks', () => {
    const s = computeStats(deck, byId);
    expect(s.byInk.Amber).toBe(60);
    expect(s.byInk.Ruby).toBe(6);
  });

  it('tracks the dual-ink share of each ink separately', () => {
    const s = computeStats(deck, byId);
    expect(s.byInkDual.Amber).toBe(6);
    expect(s.byInkDual.Ruby).toBe(6);
  });

  it('counts tags copies-weighted (removal: 24)', () => {
    const s = computeStats(deck, byId);
    expect(s.byTag.removal).toBe(24);
  });

  it('averages character stats copies-weighted, ignoring other types', () => {
    const s = computeStats(deck, byId);
    // characters: card 1 (S2 ×24), card 2 (S4 ×20), card 4 (S2 ×6) → 140/50
    expect(s.avgStrength).toBeCloseTo(2.8);
    expect(s.avgWillpower).toBeCloseTo(3.8); // (3×24 + 5×20 + 3×6) / 50
  });

  it('builds cost × ink rows with duals on their own row', () => {
    const s = computeStats(deck, byId);
    const rows = Object.fromEntries(s.costInkRows.map((r) => [r.key, r]));
    // card 4 is the dual Amber/Ruby (cost 2, 6 copies)
    expect(rows['dual:Amber/Ruby']!.cells).toEqual({ 2: 6 });
    // pure Amber: cards 1, 2, 3 (24 + 20 + 10)
    expect(rows['Amber']!.cells).toEqual({ 1: 24, 3: 20, 5: 10 });
    expect(s.maxCost).toBe(5);
    const cellSum = s.costInkRows.reduce((sum, r) => sum + Object.values(r.cells).reduce((a, b) => a + b, 0), 0);
    expect(cellSum).toBe(60); // matrix sums to deck size, no double counting
  });

  it('builds character stat distributions copies-weighted', () => {
    const s = computeStats(deck, byId);
    // characters: card 1 (S2/W3/L1 ×24), card 2 (S4/W5/L2 ×20), card 4 (S2/W3/L1 ×6)
    expect(s.distributions.strength).toEqual({ 2: 30, 4: 20 });
    expect(s.distributions.willpower).toEqual({ 3: 30, 5: 20 });
    expect(s.distributions.lore).toEqual({ 1: 30, 2: 20 });
  });
});

describe('opening hand odds', () => {
  const mk = (cards: Record<number, number>): DeckState => ({ title: 'T', inks: ['Amber'], format: 'core', cards });

  it('returns 100% when every card is inkable', () => {
    const o = openingHandOdds(mk({ 1: 60 }), byIdMap([makeCard({ id: 1, inkwell: true })]))!;
    expect(o.pAtLeast1).toBeCloseTo(1);
    expect(o.pAtLeast2).toBeCloseTo(1);
  });

  it('matches closed-form hypergeometric values (40/20 split, 7 cards)', () => {
    const o = openingHandOdds(mk({ 1: 40, 2: 20 }), byIdMap([
      makeCard({ id: 1, inkwell: true }),
      makeCard({ id: 2, inkwell: false, type: 'Action' }),
    ]))!;
    // P(0) = C(20,7)/C(60,7) ≈ 0.0002007, P(1) = 40·C(20,6)/C(60,7) ≈ 0.0040138
    expect(o.pAtLeast1).toBeCloseTo(1 - 0.0002007, 4);
    expect(o.pAtLeast2).toBeCloseTo(1 - 0.0002007 - 0.0040138, 4);
  });

  it('scales with hand size and returns null for an empty deck', () => {
    const byId = byIdMap([makeCard({ id: 1, inkwell: true }), makeCard({ id: 2, inkwell: false, type: 'Action' })]);
    const seven = openingHandOdds(mk({ 1: 30, 2: 30 }), byId)!;
    const six = openingHandOdds(mk({ 1: 30, 2: 30 }), byId, 6)!;
    expect(six.pAtLeast1).toBeLessThan(seven.pAtLeast1);
    expect(openingHandOdds(mk({}), byId)).toBeNull();
  });

  it('is 0 for two inkables when the deck has fewer than 2', () => {
    const o = openingHandOdds(mk({ 1: 1, 2: 59 }), byIdMap([makeCard({ id: 1, inkwell: true }), makeCard({ id: 2, inkwell: false, type: 'Action' })]))!;
    expect(o.pAtLeast1).toBeGreaterThan(0);
    expect(o.pAtLeast2).toBe(0);
  });
});
