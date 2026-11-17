import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';
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
});
