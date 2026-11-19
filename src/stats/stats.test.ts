import { describe, expect, it } from 'vitest';
import type { DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { curveConsistency } from './curve';
import { computeStats } from './stats';

const byId = byIdMap([
  makeCard({
    id: 1,
    name: 'A',
    cost: 1,
    inkwell: true,
    tags: [{ tag: 'removal', by: 'rule' }],
  }),
  makeCard({
    id: 2,
    name: 'B',
    cost: 3,
    inkwell: true,
    strength: 4,
    willpower: 5,
    lore: 2,
  }),
  makeCard({ id: 3, name: 'C', cost: 5, inkwell: false, type: 'Action' }),
  makeCard({
    id: 4,
    name: 'D',
    cost: 2,
    inkwell: true,
    inks: ['Amber', 'Ruby'],
  }),
]);

const deck: DeckState = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 24, 2: 20, 3: 10, 4: 6 },
};

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
    expect(rows.Amber!.cells).toEqual({ 1: 24, 3: 20, 5: 10 });
    expect(s.maxCost).toBe(5);
    const cellSum = s.costInkRows.reduce(
      (sum, r) => sum + Object.values(r.cells).reduce((a, b) => a + b, 0),
      0,
    );
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

describe('curve consistency', () => {
  const mk = (cards: Record<number, number>): DeckState => ({
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards,
  });
  // ids 1-3: inkable curve cards at cost 1/2/3; id 4: non-inkable cost-3 action
  const byId = byIdMap([
    makeCard({ id: 1, cost: 1 }),
    makeCard({ id: 2, cost: 2 }),
    makeCard({ id: 3, cost: 3 }),
    makeCard({ id: 4, cost: 3, inkwell: false, type: 'Action' }),
  ]);

  it('is deterministic for a fixed seed', () => {
    const deck = mk({ 1: 20, 2: 20, 3: 15, 4: 5 });
    expect(curveConsistency(deck, byId, { trials: 500, seed: 7 })).toEqual(
      curveConsistency(deck, byId, { trials: 500, seed: 7 }),
    );
  });

  it('a 75% inkable deck stays on curve more often than a 43% one', () => {
    const rich = curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId)!; // 45/60 inkable
    const poor = curveConsistency(mk({ 1: 8, 2: 8, 3: 10, 4: 34 }), byId)!; // 26/60 inkable
    for (const turn of [1, 2, 3]) {
      expect(rich.byTurn[turn]!).toBeGreaterThanOrEqual(poor.byTurn[turn]!);
    }
    expect(rich.onCurveThrough).toBeGreaterThan(poor.onCurveThrough);
  });

  it('simulates sensible absolute numbers for a healthy curve', () => {
    const c = curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId)!;
    // cheap, mostly-inkable deck: early turns should be near-certain
    expect(c.byTurn[1]!).toBeGreaterThan(0.9);
    expect(c.byTurn[2]!).toBeGreaterThan(0.85);
    expect(c.expectedInk[1]).toBeCloseTo(1, 1);
    expect(c.expectedInk[3]).toBeCloseTo(3, 0);
  });

  it('skips turns the deck has no matching cost for', () => {
    const c = curveConsistency(mk({ 2: 60 }), byId)!;
    expect(c.byTurn[1]).toBeNull();
    expect(c.byTurn[2]!).toBeGreaterThan(0.9);
    expect(c.byTurn[3]).toBeNull();
    // only turn 2 has a matching cost, so the streak can never exceed 1
    expect(c.onCurveThrough).toBe(1);
  });

  it('returns null for an empty deck', () => {
    expect(curveConsistency(mk({}), byId)).toBeNull();
  });
});
