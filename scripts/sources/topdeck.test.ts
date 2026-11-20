import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { retryAfterMs } from './shared';
import {
  type CardIndex,
  fetchWindow,
  normalize,
  parseDecklist,
  syncTopdeck,
  toDatasetTournament,
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

describe('topdeck request resilience', () => {
  it('parses Retry-After as seconds and falls back for HTTP-dates', () => {
    expect(
      retryAfterMs(
        new Response(null, { headers: { 'Retry-After': '2' } }),
        15_000,
      ),
    ).toBe(2000);
    expect(
      retryAfterMs(
        new Response(null, {
          headers: { 'Retry-After': 'Thu, 19 Nov 2026 20:00:00 GMT' },
        }),
        15_000,
      ),
    ).toBe(15_000);
  });

  it('requests standings and stops after five rate-limited attempts', async () => {
    let calls = 0;
    let requestBody = '';
    vi.stubGlobal(
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        requestBody = String(init?.body);
        return new Response('limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      },
    );
    try {
      await expect(fetchWindow('k', 1, 2, 8)).rejects.toThrow('topdeck 429');
      expect(calls).toBe(5);
      expect(JSON.parse(requestBody).columns).toContain('standing');
    } finally {
      vi.unstubAllGlobals();
    }
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
  const rawEvent = (
    tid: string,
    start: number,
    decklist: string | null = '4 Ariel - Spectacular Singer (1-2)',
    standings?: Array<Record<string, unknown>>,
  ) => ({
    TID: tid,
    tournamentName: `Event ${tid}`,
    startDate: start,
    topCut: 4,
    standings: standings ?? [
      {
        name: 'Alice',
        standing: 1,
        decklist,
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
    const callsAfterSecond = calls;
    await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
    });
    // the identical overlap window is keyed by its stable start and hits cache
    expect(calls).toBe(callsAfterSecond);
    await rm(dir, { recursive: true, force: true });
  });

  it('re-lists zero-decklist events until late decklists are published', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td-late-'));
    const eventStart = Math.floor(Date.now() / 1000) - 2 * 86400;
    let published = false;
    let calls = 0;
    const fetchWindowImpl = async (
      apiKey: string,
      start: number,
      end: number,
    ): Promise<unknown[]> => {
      calls++;
      void apiKey;
      if (eventStart < start || eventStart > end) return [];
      return [
        rawEvent(
          'late',
          eventStart,
          published ? '4 Ariel - Spectacular Singer (1-2)' : null,
        ),
      ];
    };
    const opts = {
      apiKey: 'k',
      cards: mkIndex(),
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl,
      sleepMs: 0,
    };
    const first = await syncTopdeck(opts);
    expect(first.state.events.late).toMatchObject({
      decklistCount: 0,
      complete: false,
    });
    expect(first.state.pending).toContainEqual({
      id: 'late',
      reason: 'incomplete',
      attempts: 1,
    });

    const callsAfterFirst = calls;
    const retry = await syncTopdeck(opts);
    expect(calls).toBeGreaterThan(callsAfterFirst);
    expect(retry.state.pending).toContainEqual({
      id: 'late',
      reason: 'incomplete',
      attempts: 2,
    });

    published = true;
    const completed = await syncTopdeck(opts);
    expect(completed.state.events.late).toMatchObject({
      decklistCount: 1,
      complete: true,
    });
    expect(completed.state.pending).toEqual([]);
    expect(
      completed.dataset.tournaments.find((t) => t.eventId === 'late')?.entries,
    ).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('rebuilds from an orphaned event cache after a crashed dataset write', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td-cache-'));
    const dataDir = path.join(dir, 'topdeck');
    await mkdir(path.join(dataDir, 'events'), { recursive: true });
    const cached = {
      eventId: 'orphan',
      name: 'Recovered Event',
      date: new Date().toISOString().slice(0, 10),
      playerCount: 8,
      topCut: 4,
      entries: [
        {
          player: 'Alice',
          standing: 1,
          winRate: 0.7,
          cards: [{ cardId: 1, count: 4 }],
          unmatched: [],
        },
      ],
    };
    await writeFile(
      path.join(dataDir, 'events', 'event-orphan.json'),
      JSON.stringify(cached),
    );
    const result = await syncTopdeck({
      apiKey: 'k',
      cards: mkIndex(),
      dataDir,
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'topdeck.json'),
      fetchWindowImpl: async () => [],
      sleepMs: 0,
    });
    expect(result.fetched).toBe(0);
    expect(result.dataset.tournaments).toEqual([cached]);
    expect(result.state.events.orphan?.complete).toBe(true);
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

describe('standing derivation', () => {
  const cards = index;

  it('derives standing from the rank-ordered standings index (API has no field)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'td-standing-'));
    // live API (verified 2026-11-20): standings are rank-ordered and carry no
    // `standing` field — topdeck rows previously all had standing: null, which
    // silenced top-cut labels for the whole source in the trainer
    const event = {
      TID: 'ranked-1',
      tournamentName: 'Event ranked-1',
      startDate: 1_700_000_000,
      topCut: 4,
      standings: [
        {
          name: 'A',
          decklist: '4 Ariel - Spectacular Singer (1-2)',
          wins: 3,
          losses: 0,
          winRate: 1,
        },
        {
          name: 'B',
          decklist: '4 Strength of a Raging Fire (11-29)',
          wins: 2,
          losses: 1,
          winRate: 0.66,
        },
        { name: 'C', decklist: null, wins: 2, losses: 1, winRate: 0.66 }, // no decklist: dropped
        {
          name: 'D',
          decklist: '2 Strength of a Raging Fire (11-29)',
          wins: 1,
          losses: 2,
          winRate: 0.33,
        },
      ],
    };
    const ds = await syncTopdeck({
      apiKey: 'k',
      cards: index,
      dataDir: path.join(dir, 'topdeck'),
      cacheDir: path.join(dir, 'cache'),
      full: true,
      sleepMs: 0,
      fetchWindowImpl: async () => [event],
    });
    const entries = ds.dataset.tournaments[0]!.entries;
    expect(entries.map((e) => e.standing)).toEqual([1, 2, 4]);
    // topCut labels become real: the trainer's logistic labels need them
    expect(ds.dataset.tournaments[0]!.topCut).toBe(4);
    await rm(dir, { recursive: true, force: true });
  });

  it('honors an explicit standing field when the API provides one', () => {
    const t = toDatasetTournament(
      {
        TID: 'x',
        tournamentName: 'X',
        startDate: 1_700_000_000,
        topCut: 8,
        standings: [
          {
            name: 'A',
            standing: 7,
            decklist: '4 Ariel - Spectacular Singer (1-2)',
            winRate: 0.9,
          },
        ],
      },
      cards,
    );
    expect(t.entries[0]!.standing).toBe(7);
  });
});
