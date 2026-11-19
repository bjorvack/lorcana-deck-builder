import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIdPremap, mapDeck, normalizeCode, parseRecord, syncDotgg } from './dotgg';
import type { CardIndex } from './topdeck';

const index: CardIndex[] = [
  { id: 1, fullName: 'Ariel - Spectacular Singer', setCode: '1', collectorNumber: '2' },
  { id: 2, fullName: 'Strength of a Raging Fire', setCode: '11', collectorNumber: '29' },
];

describe('dotgg adapter', () => {
  it('matches zero-padded dotgg ids against snapshot codes', () => {
    expect(normalizeCode('002-201')).toBe('2-201');
    expect(normalizeCode('011-029')).toBe('11-29');
    expect(normalizeCode('P2-024B')).toBe('p2-24b');
  });

  it('maps deck id lists by code, with the promo premap as fallback', () => {
    const premap = new Map([['p1-28', 1]]);
    const r = mapDeck({ '001-002': '4', '011-029': '2', 'P1-028': '3', '099-001': '3', undefined: '2' as never }, index, premap);
    expect(r.cards).toEqual([
      { cardId: 1, count: 7 },
      { cardId: 2, count: 2 },
    ]);
    expect(r.unmatched).toEqual(['3x 099-001']);
  });

  it('builds the promo premap by display name, skipping unnamed cards', () => {
    const premap = buildIdPremap(
      [
        { id: 'P1-028', displayName: 'Ariel - Spectacular Singer' },
        { id: 'X1-001', displayName: 'Not In Snapshot' },
        { id: 'X2-002', displayName: null },
      ],
      index,
    );
    expect(premap.get('p1-28')).toBe(1);
    expect(premap.has('x1-1')).toBe(false);
    expect(premap.has('x2-2')).toBe(false);
  });

  it('derives win rate from the match record', () => {
    expect(parseRecord('10-1-1')).toBeCloseTo(10 / 12);
    expect(parseRecord('9-3')).toBeCloseTo(0.75);
    expect(parseRecord('')).toBeNull();
    expect(parseRecord(undefined)).toBeNull();
    expect(parseRecord('0-0-0')).toBeNull();
  });
});

describe('dotgg incremental sync', () => {
  // page summaries carry no id — slug is the listing-time key (matches the live API)
  const pageOf = (...slugs: string[]): { name: string; slug: string; date: string }[] =>
    slugs.map((slug) => ({ name: `Event ${slug}`, slug, date: '1700000000' }));

  const detailOf = (id: string, playerCount = 20): unknown => ({
    id,
    name: `Event ${id}`,
    slug: `slug-${id}`,
    date: '1700000000',
    players_count: String(playerCount),
    standings: [
      { standing_place: '1', standing_record: '10-1-1', player_name: 'Alice', id: `deck-${id}-1` },
      { standing_place: '9', standing_record: '6-6-0', player_name: 'Bob', id: `deck-${id}-9` },
    ],
  });

  const deckOf = (key: string): unknown => ({
    id: key,
    slug: `slug-${key}`,
    deck: { '001-002': '4', '011-029': '4', 'P1-028': '2' }, // promo id resolved via premap
  });

  const dotggCards = [
    { id: '001-002', displayName: 'Ariel - Spectacular Singer' },
    { id: '011-029', displayName: 'Strength of a Raging Fire' },
    { id: 'P1-028', displayName: 'Ariel - Spectacular Singer' },
  ];

  /** fetch impl serving pages, tournament details, and decks from a fixture map */
  const mkFetch = (pages: unknown[][], details: Map<string, unknown>) => {
    const deckCalls: string[] = [];
    const impl = (async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.includes('butterfly.dotgg.gg')) return new Response('43567');
      if (u.includes('getcards')) return Response.json(dotggCards);
      if (u.includes('gettournaments')) {
        const page = parseInt(new URL(u).searchParams.get('page') ?? '1', 10);
        return Response.json(pages[page - 1] ?? []);
      }
      if (u.includes('gettournament')) {
        const slug = new URL(u).searchParams.get('slug') ?? '';
        const detail = details.get(slug);
        return detail ? Response.json(detail) : new Response('', { status: 404 });
      }
      if (u.includes('getdeck')) {
        const slug = new URL(u).searchParams.get('slug') ?? '';
        deckCalls.push(slug);
        return Response.json(deckOf(slug));
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { impl, deckCalls };
  };

  const run = (dir: string, impl: typeof fetch, extra: Partial<Parameters<typeof syncDotgg>[0]> = {}) =>
    syncDotgg({
      cards: index,
      dataDir: path.join(dir, 'dotgg'),
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'dotgg.json'),
      fetchImpl: impl,
      sleepMs: 0,
      ...extra,
    });

  it('backfills pages until a fully-known page, fetching top-cut decklists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dg-'));
    const { impl, deckCalls } = mkFetch(
      [pageOf('t1', 't2'), pageOf('t3')],
      new Map([
        ['t1', detailOf('t1')],
        ['t2', detailOf('t2', 4)], // below participantMin → no lists
      ]),
    );
    const res = await run(dir, impl);
    expect(res.fetched).toBe(1); // t1 only (t2 below participantMin, t3 detail fetch fails → pending)
    expect(res.dataset.tournaments).toHaveLength(1);
    const t = res.dataset.tournaments[0]!;
    expect(t.topCut).toBe(8);
    expect(t.entries).toHaveLength(1); // place 9 excluded by cut
    expect(t.entries[0]!.winRate).toBeCloseTo(10 / 12);
    expect(t.entries[0]!.cards).toEqual([
      { cardId: 1, count: 6 },
      { cardId: 2, count: 4 },
    ]);
    expect(deckCalls).toEqual(['deck-t1-1']);
    const state = JSON.parse(await readFile(path.join(dir, 'dotgg', 'state.json'), 'utf8'));
    expect(Object.keys(state.events).sort()).toEqual(['t1', 't2']);
    await rm(dir, { recursive: true, force: true });
  });

  it('resumes from committed state and event caches without refetching', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dg2-'));
    const { impl } = mkFetch(
      [pageOf('t1', 't2')],
      new Map([
        ['t1', detailOf('t1')],
        ['t2', detailOf('t2')],
      ]),
    );
    await run(dir, impl);
    // second run: everything known → stops after page 1, zero deck fetches
    const { impl: impl2, deckCalls } = mkFetch([pageOf('t1', 't2')], new Map());
    const second = await run(dir, impl2);
    expect(second.fetched).toBe(0);
    expect(second.deckFetches).toBe(0);
    expect(deckCalls).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('respects --max-decks and reports exhaustion mid-corpus', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dg3-'));
    const { impl } = mkFetch(
      [pageOf('t1', 't2')],
      new Map([
        ['t1', detailOf('t1')],
        ['t2', detailOf('t2')],
      ]),
    );
    const res = await run(dir, impl, { maxDeckFetches: 1 });
    expect(res.deckFetches).toBe(1);
    expect(res.exhausted).toBe(true);
    expect(res.dataset.tournaments).toHaveLength(1); // t1 complete, t2 deferred
    // rerun completes the deferred tournament from caches
    const { impl: impl2, deckCalls } = mkFetch(
      [pageOf('t1', 't2')],
      new Map([['t2', detailOf('t2')]]),
    );
    const done = await run(dir, impl2);
    expect(done.exhausted).toBe(false);
    expect(done.dataset.tournaments).toHaveLength(2);
    expect(deckCalls).toEqual(['deck-t2-1']); // only the missing deck is fetched live
    await rm(dir, { recursive: true, force: true });
  });

  it('deepens previously backfilled events when the cut grows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dg5-'));
    const detail = {
      id: 't1',
      name: 'Event t1',
      slug: 't1',
      date: '1700000000',
      players_count: '20',
      standings: [
        { standing_place: '1', standing_record: '10-1-1', player_name: 'A', id: 'd1' },
        { standing_place: '4', standing_record: '8-3-0', player_name: 'B', id: 'd4' },
        { standing_place: '9', standing_record: '6-6-0', player_name: 'C', id: 'd9' },
      ],
    };
    const { impl } = mkFetch([pageOf('t1')], new Map([['t1', detail]]));
    const first = await run(dir, impl, { cut: 2 });
    expect(first.dataset.tournaments[0]!.entries).toHaveLength(1);
    expect(first.dataset.tournaments[0]!.topCut).toBe(2);

    // deepen to top 8: place 4 joins, place 9 still out, only the delta fetched
    const { impl: impl2, deckCalls } = mkFetch([pageOf('t1')], new Map([['t1', detail]]));
    const second = await run(dir, impl2, { cut: 8 });
    expect(second.fetched).toBe(1); // re-processed, not skipped
    expect(second.dataset.tournaments[0]!.entries).toHaveLength(2);
    expect(second.dataset.tournaments[0]!.topCut).toBe(8);
    expect(deckCalls).toEqual(['d4']);
    expect(second.dataset.tournaments[0]!.entries.map((e) => e.standing)).toEqual([1, 4]);

    // same cut again: covered → skipped
    const { impl: impl3 } = mkFetch([pageOf('t1')], new Map([['t1', detail]]));
    const third = await run(dir, impl3, { cut: 8 });
    expect(third.fetched).toBe(0);
    expect(third.skipped).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('marks unparseable tournaments pending instead of failing the run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dg4-'));
    const { impl } = mkFetch([pageOf('t1', 'ok')], new Map([['ok', detailOf('ok')]]));
    const res = await run(dir, impl);
    expect(res.fetched).toBe(1);
    const state = JSON.parse(await readFile(path.join(dir, 'dotgg', 'state.json'), 'utf8'));
    expect(state.pending.map((p: { id: string }) => p.id)).toEqual(['t1']);
    await rm(dir, { recursive: true, force: true });
  });
});
