import { describe, expect, it } from 'vitest';
import { buildRows, kmeans, logisticRegression, selectHoldoutEvents, train, type Dataset } from './train';

const vec = (ids: number[]): Map<number, number> => new Map(ids.map((id) => [id, 0.25]));

describe('holdout split', () => {
  const ev = (id: string, date: string): { id: string; date: string } => ({ id, date });

  it('caps the holdout to the recent era — deep history always trains', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => ev(`old-${i}`, `2023-0${(i % 9) + 1}-15`)),
      ...Array.from({ length: 4 }, (_, i) => ev(`new-${i}`, `2026-0${i + 1}-10`)),
    ];
    const holdout = selectHoldoutEvents(events);
    expect([...holdout]).toEqual(['new-3']); // 25% of the 4 recent events, not of all 12
  });

  it('keeps a minimum of one holdout event in a thin recent window', () => {
    const events = [ev('old-1', '2023-06-01'), ev('old-2', '2024-01-01'), ev('new-1', '2026-11-01')];
    expect([...selectHoldoutEvents(events)]).toEqual(['new-1']);
  });

  it('preserves the 25% share when all events are recent', () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(`e${i}`, `2026-${String((i % 8) + 1).padStart(2, '0')}-05`));
    expect(selectHoldoutEvents(events).size).toBe(2);
  });
});

describe('training core', () => {
  it('builds rows with per-event player dedupe and mapping filters', () => {
    const ds: Dataset = {
      source: 'test',
      fetchedOn: 'x',
      tournaments: [
        {
          eventId: 'e1',
          name: 'E',
          date: '2026-01-01',
          playerCount: 3,
          topCut: 1,
          entries: [
            { player: 'a', standing: 1, winRate: 0.8, cards: [{ cardId: 1, count: 60 }], unmatched: [] },
            { player: 'a', standing: 1, winRate: 0.8, cards: [{ cardId: 1, count: 60 }], unmatched: [] },
            { player: 'b', standing: 2, winRate: 0.4, cards: [{ cardId: 1, count: 10 }], unmatched: [] }, // poorly mapped
            { player: 'c', standing: 3, winRate: null, cards: [{ cardId: 1, count: 60 }], unmatched: [] }, // no winRate
          ],
        },
      ],
    };
    const { rows, dropped } = buildRows([ds]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(3);
    expect(rows[0]!.topCut).toBe(true);
    expect(rows[0]!.vec.get(1)).toBeCloseTo(1);
  });

  it('k-means separates disjoint decks', () => {
    const vecs = [vec([1, 2]), vec([1, 3]), vec([101, 102]), vec([101, 103])];
    const assign = kmeans(vecs, 2, 1);
    expect(assign[0]).toBe(assign[1]);
    expect(assign[2]).toBe(assign[3]);
    expect(assign[0]).not.toBe(assign[2]);
  });

  it('logistic regression learns a strong signal', () => {
    const rows = [
      ...Array.from({ length: 30 }, () => ({ vec: vec([1, 2]), y: 1 })),
      ...Array.from({ length: 30 }, () => ({ vec: vec([3, 4]), y: 0 })),
    ];
    const w = logisticRegression(rows, 600, 0.5, 0.5);
    const score = (v: Map<number, number>): number => [...v].reduce((s, [d, val]) => s + (w.get(d) ?? 0) * val, 0);
    expect(score(vec([1, 2]))).toBeGreaterThan(score(vec([3, 4])));
  });

  it('publishes when archetype structure beats the baseline', async () => {
    const { model, report } = await train({
      dataDir: 'scripts/training/data/__test__structured',
      outDir: 'scripts/training/data/__test__out',
      k: 2,
    });
    expect(model).not.toBeNull();
    expect(report).toContain('PASSED');
    expect(model!.archetypes!.length).toBeGreaterThan(0);
    expect(model!.gates.calibration.passed).toBe(true);
  });

  it('ships relations alone when calibration has no signal', async () => {
    const { model } = await train({
      dataDir: 'scripts/training/data/__test__flat',
      outDir: 'scripts/training/data/__test__out2',
      k: 2,
    });
    expect(model).not.toBeNull();
    expect(model!.capabilities).toEqual({ relations: true, calibration: false });
    expect(model!.archetypes).toBeUndefined();
    expect(model!.relations).toBeDefined();
  });
});
