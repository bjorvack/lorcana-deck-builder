import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CardIndex,
  normalize,
  parseDecklist,
  syncTopdeck,
} from './topdeck';

const index: CardIndex[] = [
  {
    id: 1,
    fullName: 'Ariel - Spectacular Singer',
    setCode: '1',
    collectorNumber: '2',
  },
  {
    id: 2,
    fullName: 'Strength of a Raging Fire',
    setCode: '11',
    collectorNumber: '29',
  },
];

describe('topdeck adapter', () => {
  it('parses decklist text by collector code, with name fallback', () => {
    const list =
      '4 Ariel - Spectacular Singer (1-2)\n2 Unknown Card (99-1)\n4 Strength of a Raging Fire (11-29)\n3 Chernabog - Unnatural Force (11-77)';
    const r = parseDecklist(list, index);
    expect(r.cards).toEqual([
      { cardId: 1, count: 4 },
      { cardId: 2, count: 4 },
    ]);
    expect(r.unmatched).toEqual([
      { name: 'Unknown Card', code: '99-1', count: 2 },
      { name: 'Chernabog - Unnatural Force', code: '11-77', count: 3 },
    ]);
  });

  it('normalizes dashes and quotes in names', () => {
    expect(normalize('Ariel – Spectacular Singer')).toBe(
      normalize('Ariel - Spectacular Singer'),
    );
    expect(normalize('Max Goof - Rebellious Teen')).toBe(
      'max goof - rebellious teen',
    );
  });

  it('returns empty for empty lists', () => {
    expect(parseDecklist('', index)).toEqual({ cards: [], unmatched: [] });
  });
});

describe('topdeck incremental sync', () => {
  const mkIndex = (): CardIndex[] => [
    {
      id: 1,
      fullName: 'Ariel - Spectacular Singer',
      setCode: '1',
      collectorNumber: '2',
    },
    {
      id: 2,
      fullName: 'Strength of a Raging Fire',
      setCode: '11',
      collectorNumber: '29',
    },
  ];
  const rawEvent = (tid: string, start: number): unknown => ({
    TID: tid,
    tournamentName: `Event ${tid}`,
    startDate: start,
    topCut: 4,
    standings: [
      {
        name: 'Alice',
        standing: 1,
        decklist: '4 Ariel - Spectacular Singer (1-2)',
        winRate: 0.7,
      },
    ],
  });

  it('seeded state fetches only the overlap windows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td-'));
    const now = Math.floor(Date.now() / 1000);
    const windows: [number, number][] = [];
    const fetchWindowImpl = async (
      apiKey: string,
      start: number,
      end: number,
    ): Promise<unknown[]> => {
      windows.push([start, end]);
      void apiKey;
      // one new event inside the overlap window
      return [rawEvent('new-1', end - 5 * 86400)];
    };
    const ds = await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
    });
    // first run (no state, no dataset): full range → several windows
    expect(windows.length).toBeGreaterThan(1);
    expect(ds.fetched).toBe(1);
    expect(ds.dataset.tournaments[0]!.entries[0]!.cards).toEqual([
      { cardId: 1, count: 4 },
    ]);
    const state = JSON.parse(
      await readFile(path.join(dir, 'topdeck', 'state.json'), 'utf8'),
    );
    expect(state.lastEventDate).toBe(
      new Date((now - 5 * 86400) * 1000).toISOString().slice(0, 10),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('second run fetches only the overlap window', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td2-'));
    let calls = 0;
    const fetchWindowImpl = async (
      apiKey: string,
      start: number,
      end: number,
    ): Promise<unknown[]> => {
      calls++;
      void apiKey;
      void start;
      void end;
      return [rawEvent('n2', end - 2 * 86400)];
    };
    const first = await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
    });
    expect(first.fetched).toBe(1); // full-range first run finds the event
    const callsAfterFirst = calls;
    const second = await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
    });
    expect(second.fetched).toBe(0);
    // overlap window only: fewer listing requests than the full-range first run
    expect(calls - callsAfterFirst).toBeLessThan(callsAfterFirst);
    await rm(dir, { recursive: true, force: true });
  });

  it('--full resets the sync state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td3-'));
    const now = Math.floor(Date.now() / 1000);
    const fetchWindowImpl = async (): Promise<unknown[]> => [
      rawEvent('x1', now - 3 * 86400),
    ];
    const a = await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
    });
    expect(a.state.lastEventDate).not.toBe('');
    const b = await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
      full: true,
    });
    // full run re-enumerates: the event is re-listed from scratch (state rebuilt)
    expect(b.state.events.x1).toBeDefined();
    await rm(dir, { recursive: true, force: true });
  });
});
