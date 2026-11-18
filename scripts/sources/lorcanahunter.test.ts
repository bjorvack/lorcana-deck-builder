import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  authedFetch,
  backfill,
  ensureToken,
  loadTokenState,
  mapCards,
  obtainToken,
  type LHConfig,
  type TokenState,
} from './lorcanahunter';
import type { CardIndex } from './topdeck';

type FetchLike = typeof fetch;

const index: CardIndex[] = [
  { id: 1, fullName: 'Ariel - Spectacular Singer', setCode: '1', collectorNumber: '2' },
  { id: 2, fullName: 'Strength of a Raging Fire', setCode: '11', collectorNumber: '29' },
];

/** fixture fetch: sequence of canned responses keyed by method+url patterns */
const fixtureFetch = (handlers: { match: (url: string, init?: RequestInit) => boolean; respond: (url: string, init?: RequestInit) => Response | Promise<Response> }[]): FetchLike => {
  const impl: FetchLike = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const h of handlers) if (h.match(url, init)) return h.respond(url, init);
    throw new Error(`no fixture handler for ${url}`);
  };
  return impl;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const tokenBody = () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 86400, scope: 'tournaments:read decks:read' });

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
            const auth = (init?.headers as Record<string, string>)?.Authorization;
            if (auth === 'Bearer at-1') {
              dataCalls++;
              return jsonResponse({ error: 'invalid_token' }, 401);
            }
            return jsonResponse({ ok: true });
          },
        },
      ]),
    };
    // first obtain persists the pair atomically
    const first = await obtainToken({ ...cfg, fetchImpl: fixtureFetch([{ match: () => true, respond: () => jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 86400 }) }]) });
    await import('node:fs/promises').then((fs) => fs.writeFile(statePath, JSON.stringify(first)));
    // seed an expired-ish state with the OLD access token at-1
    const stale: TokenState = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000 };
    await import('node:fs/promises').then((fs) => fs.writeFile(statePath, JSON.stringify(stale)));

    const res = await authedFetch(cfg, 'https://lorcanahunter.com/api/v1/tournaments/7/archetype-test');
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
    await import('node:fs/promises').then((fs) => fs.writeFile(statePath, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 9_000_000 })));
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
        { quantity: 4, card: { setCode: '1', number: 2, name: 'Ariel - Spectacular Singer' } },
        { quantity: 3, card: { setCode: '11', number: 29, name: 'Wrong Name But Right Code' } },
        { quantity: 2, card: { setCode: '99', number: 1, name: 'Unknown Card' } },
      ],
      index
    );
    expect(r.cards).toEqual([
      { cardId: 1, count: 4 },
      { cardId: 2, count: 3 },
    ]);
    expect(r.unmatched).toEqual(['2x Unknown Card (99-1)']);
  });
});

describe('lorcanahunter backfill', () => {
  it('paginates tournaments and decklists, computes win rates, skips private lists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lh3-'));
    const statePath = path.join(dir, 'token.json');
    const cfg: LHConfig = {
      clientId: 'id',
      clientSecret: 'secret',
      statePath,
      fetchImpl: fixtureFetch([
        { match: (url) => url.includes('/api/oauth/token'), respond: () => jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 86400 }) },
        {
          match: (url) => url.includes('/api/v1/tournaments?'),
          respond: () =>
            jsonResponse({
              data: [
                { id: 7, name: 'DLC Test', date: '2026-11-01', playerCount: 100, decklistsAvailable: true },
                { id: 8, name: 'Private Event', date: '2026-10-20', playerCount: 40, decklistsAvailable: false },
              ],
              hasMore: false,
              total: 2,
              count: 2,
              page: 1,
              limit: 100,
            }),
        },
        {
          match: (url) => url.includes('/api/v1/tournaments/7/decklists'),
          respond: () =>
            jsonResponse({
              tournament: { id: 7 },
              data: [
                {
                  player: { name: 'Alice' },
                  standing: 1,
                  wins: 9,
                  losses: 2,
                  deck: { cards: [{ quantity: 4, card: { setCode: '1', number: 2, name: 'Ariel - Spectacular Singer' } }] },
                },
                { player: { name: 'Bob' }, standing: 2, wins: 6, losses: 5, deck: null },
              ],
              hasMore: false,
              total: 2,
              count: 2,
              page: 1,
              limit: 100,
            }),
        },
        {
          match: (url) => url.includes('/api/v1/tournaments/8/decklists'),
          respond: () => jsonResponse({ error: 'decklists_private' }, 403),
        },
      ]),
    };
    const ds = await backfill(cfg, index, {
      cacheDir: path.join(dir, 'cache'),
      datasetPath: path.join(dir, 'lorcanahunter.json'),
    });
    expect(ds.tournaments).toHaveLength(1);
    expect(ds.tournaments[0]!.entries).toHaveLength(1); // Bob has no deck object → dropped
    expect(ds.tournaments[0]!.entries[0]!.winRate).toBeCloseTo(9 / 11);
    expect(ds.tournaments[0]!.entries[0]!.cards).toEqual([{ cardId: 1, count: 4 }]);
    const persisted = JSON.parse(await readFile(path.join(dir, 'lorcanahunter.json'), 'utf8'));
    expect(persisted.source).toBe('lorcanahunter');
    await rm(dir, { recursive: true, force: true });
  });
});
