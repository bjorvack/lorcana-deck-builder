import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authedFetch,
  ensureToken,
  fetchTournamentDataset,
  type LHConfig,
  loadTokenState,
  mapCards,
  sync,
  type TokenState,
} from './lorcanahunter';
import type { CardIndex } from './shared';

type FetchLike = typeof fetch;

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

/** fixture fetch: canned responses keyed by url patterns, recording every request url */
const fixtureFetch = (
  handlers: {
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
  }[],
  log?: string[],
): FetchLike => {
  const impl: FetchLike = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (log) log.push(url);
    for (const h of handlers)
      if (h.match(url, init)) return h.respond(url, init);
    throw new Error(`no fixture handler for ${url}`);
  };
  return impl;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const tokenBody = () => ({
  access_token: 'at-2',
  refresh_token: 'rt-2',
  expires_in: 86400,
  scope: 'tournaments:read decks:read',
});

describe('lorcanahunter token flow', () => {
  it('obtains, persists and reuses the token; refreshes exactly once on 401', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh-'));
    const statePath = path.join(dir, 'token.json');
    let tokenCalls = 0;
    let dataCalls = 0;
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath,
      fetchImpl: fixtureFetch([
        {
          match: (url) => url.includes('/api/oauth/token'),
          respond: () => {
            tokenCalls++;
            return jsonResponse(tokenBody());
          },
        },
        {
          match: (url) => url.includes('/api/v1/tournaments/7/archetype-test'),
          respond: (_url, init) => {
            const auth = (init?.headers as Record<string, string>)
              ?.Authorization;
            if (auth === 'Bearer at-1') {
              dataCalls++;
              return jsonResponse({ error: 'invalid_token' }, 401);
            }
            return jsonResponse({ ok: true });
          },
        },
      ]),
    };
    // seed an expired state holding the OLD access token at-1
    const stale: TokenState = {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 3_600_000,
    };
    await writeFile(statePath, JSON.stringify(stale));

    const res = await authedFetch(
      cfg,
      'https://lorcanahunter.com/api/v1/tournaments/7/archetype-test',
    );
    expect(res.ok).toBe(true);
    expect(dataCalls).toBe(1); // one 401, one successful retry
    expect(tokenCalls).toBe(1); // one refresh
    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    expect(persisted.refreshToken).toBe('rt-2'); // rotated pair saved atomically
    await rm(dir, { recursive: true, force: true });
  });

  it('ensureToken uses the cached state when still valid', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh2-'));
    const statePath = path.join(dir, 'token.json');
    let calls = 0;
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath,
      fetchImpl: fixtureFetch([
        {
          match: (url) => url.includes('/api/oauth/token'),
          respond: () => {
            calls++;
            return jsonResponse(tokenBody());
          },
        },
      ]),
    };
    await writeFile(
      statePath,
      JSON.stringify({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() + 9_000_000,
      }),
    );
    const t = await ensureToken(cfg);
    expect(t.accessToken).toBe('a');
    expect(calls).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('loadTokenState returns null for missing files', async () => {
    expect(await loadTokenState('/nonexistent/token.json')).toBeNull();
  });
});

describe('lorcanahunter card mapping', () => {
  it('maps by setCode-number with name fallback', () => {
    const r = mapCards(
      [
        {
          quantity: 4,
          card: { setCode: '1', number: 2, name: 'Ariel - Spectacular Singer' },
        },
        {
          quantity: 3,
          card: {
            setCode: '11',
            number: 29,
            name: 'Wrong Name But Right Code',
          },
        },
        {
          quantity: 2,
          card: { setCode: '99', number: 1, name: 'Unknown Card' },
        },
      ],
      index,
    );
    expect(r.cards).toEqual([
      { cardId: 1, count: 4 },
      { cardId: 2, count: 3 },
    ]);
    expect(r.unmatched).toEqual(['2x Unknown Card (99-1)']);
  });
});

describe('lorcanahunter incremental sync', () => {
  it('seeds from the committed dataset, fetches only the window, and no-ops when nothing changed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh3-'));
    const dataDir = path.join(dir, 'lorcanahunter');
    const datasetPath = path.join(dir, 'lorcanahunter.json');
    const statePath = path.join(dir, 'token.json');
    const urls: string[] = [];
    let decklistCalls = 0;
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath,
      fetchImpl: fixtureFetch(
        [
          {
            match: (url) => url.includes('/api/oauth/token'),
            respond: () =>
              jsonResponse({
                access_token: 'at',
                refresh_token: 'rt',
                expires_in: 86400,
              }),
          },
          {
            match: (url) => {
              const isListing = url.includes('/api/v1/tournaments?');
              if (isListing) urls.push(url);
              return isListing;
            },
            respond: (url) => {
              if (url.includes('dateFrom=2026-11-13')) {
                // the overlap window catches one new completed event
                return jsonResponse({
                  data: [
                    {
                      id: 9,
                      name: 'New Event',
                      date: '2026-11-28',
                      playerCount: 50,
                      isPast: true,
                      decklistsAvailable: true,
                    },
                  ],
                  hasMore: false,
                  total: 1,
                  count: 1,
                  page: 1,
                  limit: 100,
                });
              }
              return jsonResponse({
                data: [],
                hasMore: false,
                total: 0,
                count: 0,
                page: 1,
                limit: 100,
              });
            },
          },
          {
            match: (url) => url.includes('/api/v1/tournaments/9/decklists'),
            respond: () => {
              decklistCalls++;
              return jsonResponse({
                tournament: { id: 9 },
                data: [
                  {
                    player: { name: 'Alice' },
                    standing: 1,
                    wins: 9,
                    losses: 2,
                    deck: {
                      cards: [
                        {
                          quantity: 4,
                          card: {
                            setCode: '1',
                            number: 2,
                            name: 'Ariel - Spectacular Singer',
                          },
                        },
                      ],
                    },
                  },
                ],
                hasMore: false,
                total: 1,
                count: 1,
                page: 1,
                limit: 100,
              });
            },
          },
        ],
        urls,
      ),
    };

    // committed dataset from a previous full backfill: two known events
    const committed = {
      source: 'lorcanahunter',
      fetchedOn: '2026-11-20T00:00:00Z',
      tournaments: [
        {
          eventId: '7',
          name: 'Old A',
          date: '2026-11-20',
          playerCount: 100,
          topCut: 0,
          entries: [
            {
              player: 'x',
              standing: 1,
              winRate: 0.7,
              cards: [{ cardId: 1, count: 60 }],
              unmatched: [],
            },
          ],
        },
        {
          eventId: '8',
          name: 'Old B',
          date: '2026-11-18',
          playerCount: 80,
          topCut: 0,
          entries: [],
        },
      ],
    };
    await mkdir(dataDir, { recursive: true });
    await writeFile(datasetPath, JSON.stringify(committed));

    // first incremental run: seeds state, fetches only the window's new event
    const first = await sync(cfg, index, { dataDir, datasetPath });
    expect(first.fetched).toBe(1);
    expect(first.dataset.tournaments.map((t) => t.eventId).sort()).toEqual([
      '7',
      '8',
      '9',
    ]); // merged from caches
    expect(urls.some((u) => u.includes('dateFrom=2026-11-13'))).toBe(true); // overlap window, server-side filter
    expect(decklistCalls).toBe(1);
    const state = JSON.parse(
      await readFile(path.join(dataDir, 'state.json'), 'utf8'),
    );
    expect(state.lastEventDate).toBe('2026-11-28');
    expect(state.events['7'].complete).toBe(true); // seeded from the committed dataset

    // second run: nothing new — the listing happens but no decklist calls
    urls.length = 0;
    decklistCalls = 0;
    const second = await sync(cfg, index, { dataDir, datasetPath });
    expect(second.fetched).toBe(0);
    expect(decklistCalls).toBe(0);
  });

  it('marks private and in-progress events pending and skips their decklists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh4-'));
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath: path.join(dir, 'token.json'),
      fetchImpl: fixtureFetch([
        {
          match: (url) => url.includes('/api/oauth/token'),
          respond: () =>
            jsonResponse({
              access_token: 'at',
              refresh_token: 'rt',
              expires_in: 86400,
            }),
        },
        {
          match: (url) => url.includes('/api/v1/tournaments?'),
          respond: () =>
            jsonResponse({
              data: [
                {
                  id: 30,
                  name: 'Running Now',
                  date: '2026-11-25',
                  playerCount: 40,
                  isPast: false,
                  decklistsAvailable: false,
                },
                {
                  id: 31,
                  name: 'Not Public Yet',
                  date: '2026-11-24',
                  playerCount: 40,
                  isPast: true,
                  decklistsAvailable: false,
                },
              ],
              hasMore: false,
              total: 2,
              count: 2,
              page: 1,
              limit: 100,
            }),
        },
        {
          match: (url) => url.includes('decklists'),
          respond: () => jsonResponse({ error: 'decklists_private' }, 403),
        },
      ]),
    };
    const ds = await sync(cfg, index, {
      dataDir: path.join(dir, 'lh'),
      datasetPath: path.join(dir, 'lorcanahunter.json'),
      dateFrom: '2026-11-01',
    });
    expect(ds.dataset.tournaments).toHaveLength(0);
    expect(ds.state.pending.map((p) => [p.id, p.reason])).toEqual([
      ['30', 'in-progress'],
      ['31', 'private'],
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it('uses an existing event cache instead of refetching a pending event', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh-cache-'));
    const dataDir = path.join(dir, 'lh');
    await mkdir(path.join(dataDir, 'events'), { recursive: true });
    const cached = {
      eventId: '7',
      name: 'Cached Event',
      date: '2026-11-01',
      playerCount: 20,
      topCut: 0,
      entries: [],
    };
    await writeFile(
      path.join(dataDir, 'events', 'event-7.json'),
      JSON.stringify(cached),
    );
    await writeFile(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        lastSyncedAt: '',
        lastEventDate: '2026-11-20',
        events: {
          '7': { date: '2026-11-01', decklistCount: 0, complete: false },
        },
        pending: [{ id: '7', reason: 'incomplete', attempts: 1 }],
      }),
    );
    const urls: string[] = [];
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath: path.join(dir, 'token.json'),
      fetchImpl: fixtureFetch(
        [
          {
            match: (url) => url.includes('/api/oauth/token'),
            respond: () => jsonResponse(tokenBody()),
          },
          {
            match: (url) => url.includes('/api/v1/tournaments?'),
            respond: () => jsonResponse({ data: [], hasMore: false, total: 0 }),
          },
        ],
        urls,
      ),
    };
    const result = await sync(cfg, index, {
      dataDir,
      datasetPath: path.join(dir, 'lorcanahunter.json'),
      dateFrom: '2026-11-20',
    });
    expect(result.fetched).toBe(0);
    expect(result.dataset.tournaments).toEqual([cached]);
    expect(result.state.events['7']?.complete).toBe(true);
    expect(result.state.pending).toEqual([]);
    expect(urls.some((url) => url.includes('/decklists'))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('retries pending events outside the current listing window', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh-pending-'));
    const dataDir = path.join(dir, 'lh');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        lastSyncedAt: '',
        lastEventDate: '2026-11-20',
        events: {
          '7': { date: '2026-11-01', decklistCount: 0, complete: false },
        },
        pending: [{ id: '7', reason: 'incomplete', attempts: 1 }],
      }),
    );
    let decklistCalls = 0;
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath: path.join(dir, 'token.json'),
      fetchImpl: fixtureFetch([
        {
          match: (url) => url.includes('/api/oauth/token'),
          respond: () => jsonResponse(tokenBody()),
        },
        {
          match: (url) => url.includes('/api/v1/tournaments?'),
          respond: () => jsonResponse({ data: [], hasMore: false, total: 0 }),
        },
        {
          match: (url) => url.includes('/api/v1/tournaments/7/decklists'),
          respond: () => {
            decklistCalls++;
            return jsonResponse({
              data: [
                {
                  player: { name: 'Alice' },
                  standing: 1,
                  wins: 8,
                  losses: 2,
                  deck: {
                    cards: [
                      {
                        quantity: 4,
                        card: {
                          setCode: '1',
                          number: 2,
                          name: 'Ariel - Spectacular Singer',
                        },
                      },
                    ],
                  },
                },
              ],
              hasMore: false,
            });
          },
        },
      ]),
    };
    const result = await sync(cfg, index, {
      dataDir,
      datasetPath: path.join(dir, 'lorcanahunter.json'),
      dateFrom: '2026-11-20',
    });
    expect(decklistCalls).toBe(1);
    expect(result.fetched).toBe(1);
    expect(result.dataset.tournaments[0]?.entries).toHaveLength(1);
    expect(result.state.events['7']?.complete).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('stops decklist pagination after 200 pages', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh-pages-'));
    const statePath = path.join(dir, 'token.json');
    await writeFile(
      statePath,
      JSON.stringify({
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    let pages = 0;
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath,
      fetchImpl: fixtureFetch([
        {
          match: (url) => url.includes('/decklists'),
          respond: () => {
            pages++;
            return jsonResponse({ data: [], hasMore: true });
          },
        },
      ]),
    };
    await expect(
      fetchTournamentDataset(
        cfg,
        { id: 7, name: 'Looping Event', date: null, playerCount: null },
        index,
      ),
    ).rejects.toThrow('exceeded 200 pages');
    expect(pages).toBe(200);
    await rm(dir, { recursive: true, force: true });
  });
});
