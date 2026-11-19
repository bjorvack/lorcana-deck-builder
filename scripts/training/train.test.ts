import { readFileSync } from 'node:fs';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  cardPopularityMaps,
  type Dataset,
  kmeans,
  logisticRegression,
  selectHoldoutEvents,
  type TrainRow,
  train,
} from './train';

const vec = (ids: number[]): Map<number, number> =>
  new Map(ids.map((id) => [id, 0.25]));

describe('holdout split', () => {
  const ev = (id: string, date: string): { id: string; date: string } => ({
    id,
    date,
  });

  it('caps the holdout to the recent era — deep history always trains', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) =>
        ev(`old-${i}`, `2023-0${(i % 9) + 1}-15`),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        ev(`new-${i}`, `2026-0${i + 1}-10`),
      ),
    ];
    const holdout = selectHoldoutEvents(events);
    expect([...holdout]).toEqual(['new-3']); // 25% of the 4 recent events, not of all 12
  });

  it('keeps a minimum of one holdout event in a thin recent window', () => {
    const events = [
      ev('old-1', '2023-06-01'),
      ev('old-2', '2024-01-01'),
      ev('new-1', '2026-11-01'),
    ];
    expect([...selectHoldoutEvents(events)]).toEqual(['new-1']);
  });

  it('preserves the 25% share when all events are recent', () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      ev(`e${i}`, `2026-${String((i % 8) + 1).padStart(2, '0')}-05`),
    );
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
            {
              player: 'a',
              standing: 1,
              winRate: 0.8,
              cards: [{ cardId: 1, count: 60 }],
              unmatched: [],
            },
            {
              player: 'a',
              standing: 1,
              winRate: 0.8,
              cards: [{ cardId: 1, count: 60 }],
              unmatched: [],
            },
            {
              player: 'b',
              standing: 2,
              winRate: 0.4,
              cards: [{ cardId: 1, count: 10 }],
              unmatched: [],
            }, // poorly mapped
            {
              player: 'c',
              standing: 3,
              winRate: null,
              cards: [{ cardId: 1, count: 60 }],
              unmatched: [],
            }, // no winRate
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
    const score = (v: Map<number, number>): number =>
      [...v].reduce((s, [d, val]) => s + (w.get(d) ?? 0) * val, 0);
    expect(score(vec([1, 2]))).toBeGreaterThan(score(vec([3, 4])));
  });

  it('publishes when archetype structure beats the baseline', async () => {
    const { model, report } = await train({
      dataDir: 'scripts/training/fixtures/structured',
      outDir: 'scripts/training/data/__test__out',
      k: 2,
    });
    expect(model).not.toBeNull();
    expect(report).toContain('PASSED');
    expect(model!.archetypes!.length).toBeGreaterThan(0);
    expect(model!.gates.calibration.passed).toBe(true);
    // version '3': popularity maps ship with the artifact and the emit gate holds
    expect(model!.version).toBe('3');
    expect(Object.keys(model!.playrate ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(model!.typicalCopies ?? {}).length).toBeGreaterThan(0);
    for (const copies of Object.values(model!.typicalCopies ?? {})) {
      expect(copies).toBeGreaterThanOrEqual(1);
      expect(copies).toBeLessThanOrEqual(4);
    }
    for (const rate of Object.values(model!.playrate ?? {})) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(255);
    }
  });

  it('quantizes playrate to a byte and clamps typical copies to 1-4', () => {
    const row = (counts: Record<number, number>): TrainRow => ({
      source: 'test',
      eventId: 'e',
      date: '2026-01-01',
      vec: new Map(
        Object.entries(counts).map(([id, c]) => [Number(id), c / 60]),
      ),
      counts: new Map(Object.entries(counts).map(([id, c]) => [Number(id), c])),
      winRate: 0.5,
      topCut: false,
      playerCount: 8,
      standing: 1,
    });
    const { playrate, typicalCopies } = cardPopularityMaps([
      row({ 1: 60, 2: 3 }), // card 1 in every deck with 60 copies; card 2 once with 3
      row({ 1: 60 }),
      row({ 1: 60 }),
      row({ 1: 30, 2: 4 }),
    ]);
    expect(playrate['1']).toBe(255); // 4/4 decks
    expect(playrate['2']).toBe(128); // 2/4 decks × 255
    expect(typicalCopies['1']).toBe(4); // mean 52 clamped to 4
    expect(typicalCopies['2']).toBe(4); // mean (3+4)/2 = 3.5 → rounds to 4
  });

  it('ships relations alone when calibration has no signal', async () => {
    const { model } = await train({
      dataDir: 'scripts/training/fixtures/flat',
      outDir: 'scripts/training/data/__test__out2',
      k: 2,
    });
    expect(model).not.toBeNull();
    expect(model!.capabilities).toEqual({
      relations: true,
      calibration: false,
    });
    expect(model!.archetypes).toBeUndefined();
    expect(model!.relations).toBeDefined();
  });
});

describe('corpus robustness', () => {
  it('keeps anonymous recordless entries distinct instead of dropping them', () => {
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
            {
              player: 'a',
              standing: 1,
              winRate: 0.8,
              cards: [{ cardId: 1, count: 60 }],
              unmatched: [],
            },
            {
              player: null,
              standing: 2,
              winRate: null,
              cards: [{ cardId: 1, count: 60 }],
              unmatched: [],
            },
            {
              player: null,
              standing: 3,
              winRate: null,
              cards: [{ cardId: 2, count: 60 }],
              unmatched: [],
            },
          ],
        },
      ],
    };
    // both anonymous entries used to share the key e1:<rows.length> and the
    // second was silently dropped as a duplicate
    const { rows, dropped, imputed } = buildRows([ds], { imputeWinRate: true });
    expect(dropped).toBe(0);
    expect(imputed).toBe(2);
    expect(rows).toHaveLength(3);
  });

  it('rejects structureless corpora, tolerates dateless rows and removes stale artifacts', async () => {
    // deterministic local PRNG (LCG) so the corpus is reproducible
    let seed = 42;
    const rng = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const snap = JSON.parse(
      readFileSync('public/data/cards.min.json', 'utf8'),
    ) as { cards: { id: number }[] };
    const ids = snap.cards.slice(0, 200).map((c) => c.id);
    const entry = (
      i: number,
    ): Dataset['tournaments'][number]['entries'][number] => {
      const chosen = new Set<number>();
      while (chosen.size < 15) chosen.add(ids[Math.floor(rng() * ids.length)]!);
      return {
        player: `p${i}`,
        standing: (i % 8) + 1,
        winRate: 0.5, // no calibration signal anywhere
        cards: [...chosen].map((cardId) => ({ cardId, count: 4 })),
        unmatched: [],
      };
    };
    // 12 events × 10 lists; the first event is dateless (10 dropped rows)
    const tournaments = Array.from({ length: 12 }, (_, t) => ({
      eventId: `r${t}`,
      name: `Random ${t}`,
      date: t === 0 ? '' : `2026-${String((t % 9) + 1).padStart(2, '0')}-15`,
      playerCount: 10,
      topCut: 4,
      entries: Array.from({ length: 10 }, (_, i) => entry(t * 10 + i)),
    }));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'train-random-'));
    await writeFile(
      path.join(dir, 'random.json'),
      JSON.stringify({ source: 'random', fetchedOn: 'x', tournaments }),
    );
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'train-out-'));
    // a stale artifact from a previous, passing run must not ship after a rejection
    await writeFile(
      path.join(outDir, 'meta-model.json'),
      '{"version":"stale"}',
    );
    const { model, report } = await train({ dataDir: dir, outDir });
    expect(model).toBeNull();
    expect(report).toContain('REJECTED');
    await expect(
      access(path.join(outDir, 'meta-model.json')),
    ).rejects.toThrow();
    await expect(
      access(path.join(outDir, 'rejected.json')),
    ).resolves.toBeUndefined();
  });
});
