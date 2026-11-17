import { describe, expect, it } from 'vitest';
import { identifyArchetype, isStale, metaAdjustedViability, snapshotDate, type MetaModel } from './infer';
import { makeCard, byIdMap } from '../test/fixtures';

const model: MetaModel = {
  version: '1-fixture',
  dataThroughDate: '2026-11-10',
  archetypes: [
    { id: 1, name: 'Steel Song', observedWinRate: 0.54, sampleSize: 120, centroid: { '1': 0.12, '2': 0.1 } },
    { id: 2, name: 'Ramp Leviathan', observedWinRate: 0.44, sampleSize: 80, centroid: { '9': 0.1 } },
  ],
  cardWeights: {},
};

const byId = byIdMap([makeCard({ id: 1, cost: 3 }), makeCard({ id: 2, cost: 4 })]);
const deck = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 30, 2: 30 } } as const;

describe('meta inference', () => {
  it('matches the closest archetype by centroid similarity', () => {
    const m = identifyArchetype(deck as never, byId, model)!;
    expect(m.archetype.name).toBe('Steel Song');
    expect(m.similarity).toBeGreaterThan(0.9);
  });

  it('decomposes viability into sim strength and meta alignment', () => {
    const fp = {
      version: 1,
      axes: { Tempo: 60, Consistency: 60, Resilience: 40, Interaction: 40, Reach: 40 },
    } as never;
    const v = metaAdjustedViability(fp as never, deck as never, byId, model);
    // sim: .3*60 + .25*60 + .2*40 + .15*40 + .1*40 = 51
    expect(v.simStrength).toBe(51);
    // alignment: (0.54 - 0.5) * 2 * similarity * 50 > 0
    expect(v.metaAlignment).toBeGreaterThan(0);
    expect(v.total).toBe(Math.max(0, Math.min(100, v.simStrength + v.metaAlignment)));
  });

  it('flags a model stale when its data predates the card snapshot', () => {
    expect(snapshotDate('2026-11-17T12:23:26.078Z')).toBe('2026-11-17');
    expect(isStale(model, '2026-11-17T00:00:00Z')).toBe(true);
    expect(isStale(model, '2026-11-10T00:00:00Z')).toBe(false);
    expect(isStale({ ...model, dataThroughDate: '2026-11-17' }, '2026-11-17T00:00:00Z')).toBe(false);
  });
});
