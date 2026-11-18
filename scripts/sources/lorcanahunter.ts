import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadSyncState, markPending, recordEvent, retryablePending, saveSyncState, seedFromDataset, windowStart, type SyncState } from './sync-state';

/**
 * Lorcanahunter source adapter — pre-built against the pinned OpenAPI contract
 * (https://lorcanahunter.com/openapi/developer-v1.yaml). Live verification waits
 * for the OAuth2 application approval; everything here is fixture-tested.
 *
 * Contract highlights that shape this code:
 * - OAuth2 client-credentials: POST /api/oauth/token (Basic auth). Access token
 *   24 h, refresh token 90 d — and refresh tokens ROTATE: reusing a consumed
 *   refresh token revokes every token of the application, so the latest
 *   refresh token must be persisted atomically.
 * - 60 req/min, 10k/day; 429 with Retry-After.
 * - Decklists are structured ({setCode, number, count}) and map onto the
 *   snapshot by collector code; organizer-private lists answer
 *   403 decklists_private and are skipped.
 * - Emits the same normalized dataset schema as the TopDeck adapter.
 */

const API = 'https://lorcanahunter.com';

export interface LHConfig {
  clientId: string;
  clientSecret: string;
  /** where the rotating refresh token persists (gitignored) */
  statePath: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

export const loadTokenState = async (statePath: string): Promise<TokenState | null> => {
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as TokenState;
    if (!raw.accessToken || !raw.refreshToken || typeof raw.expiresAt !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
};

/** atomic persist: temp file + rename, so a crash never leaves a half-written token */
export async function saveTokenState(statePath: string, state: TokenState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, statePath);
}

/** exchange client credentials for a fresh token pair (client_credentials grant) */
export async function obtainToken(cfg: LHConfig): Promise<TokenState> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.baseUrl ?? API}/api/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`lorcanahunter token ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

/** rotated refresh: persist the NEW pair before anyone can reuse the old one */
export async function refreshToken(cfg: LHConfig, state: TokenState): Promise<TokenState> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl(`${cfg.baseUrl ?? API}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(state.refreshToken)}`,
  });
  if (!res.ok) {
    // stale/revoked refresh token — fall back to full re-authentication
    const fresh = await obtainToken(cfg);
    await saveTokenState(cfg.statePath, fresh);
    return fresh;
  }
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  const next: TokenState = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  await saveTokenState(cfg.statePath, next);
  return next;
}

/** token resolution order: valid state → rotated refresh → fresh client-credentials */
export async function ensureToken(cfg: LHConfig): Promise<TokenState> {
  const state = await loadTokenState(cfg.statePath);
  if (state && state.expiresAt > Date.now() + 60_000) return state;
  if (state) return refreshToken(cfg, state);
  const fresh = await obtainToken(cfg);
  await saveTokenState(cfg.statePath, fresh);
  return fresh;
}

/** Bearer request that refreshes exactly once on 401 invalid_token */
export async function authedFetch(cfg: LHConfig, url: string, init: RequestInit = {}): Promise<Response> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  let state = await ensureToken(cfg);
  const doFetch = (token: string) =>
    fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  let res = await doFetch(state.accessToken);
  if (res.status === 401) {
    state = await refreshToken(cfg, state);
    res = await doFetch(state.accessToken);
  }
  return res;
}

// ---------- dataset ----------

export interface LHEntry {
  player: string | null;
  standing: number | null;
  winRate: number | null;
  cards: { cardId: number; count: number }[];
  unmatched: string[];
}

export interface LHTournament {
  eventId: string;
  name: string;
  date: string;
  playerCount: number;
  topCut: number;
  entries: LHEntry[];
}

export interface LHDataset {
  source: 'lorcanahunter';
  fetchedOn: string;
  tournaments: LHTournament[];
}

export interface CardIndex {
  id: number;
  fullName: string;
  setCode: string;
  collectorNumber: string;
}

export const normalize = (s: string): string =>
  s.toLowerCase().replace(/[\u2019]/g, "'").replace(/[\u2010\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();

/** map structured LH cards onto the snapshot by setCode-number, name fallback */
export function mapCards(
  cards: { quantity: number; card: { setCode?: string | null; number?: number | null; name?: string | null } | null }[],
  index: CardIndex[]
): { cards: { cardId: number; count: number }[]; unmatched: string[] } {
  const byCode = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const c of index) {
    byCode.set(`${c.setCode}-${c.collectorNumber}`, c.id);
    byName.set(normalize(c.fullName), c.id);
  }
  const out = new Map<number, number>();
  const unmatched: string[] = [];
  for (const entry of cards) {
    const card = entry.card;
    const code = card?.setCode && card?.number != null ? `${card.setCode}-${card.number}` : null;
    let id = code ? byCode.get(code) : undefined;
    if (id === undefined && card?.name) id = byName.get(normalize(card.name));
    if (id === undefined) {
      unmatched.push(`${entry.quantity}x ${card?.name ?? 'unknown'}${code ? ` (${code})` : ''}`);
      continue;
    }
    out.set(id, (out.get(id) ?? 0) + entry.quantity);
  }
  return { cards: [...out].map(([cardId, count]) => ({ cardId, count })), unmatched };
}

const winRateFrom = (wins: number | null, losses: number | null): number | null =>
  wins === null || losses === null || wins + losses === 0 ? null : wins / (wins + losses);

interface RawTournament {
  id: number;
  name: string;
  date: string | null;
  playerCount: number | null;
  isPast?: boolean;
  decklistsAvailable?: boolean;
  standings?: {
    standing?: number | null;
    wins?: number | null;
    losses?: number | null;
    player?: { name?: string | null } | null;
    deck?: { archetype?: { name?: string } | null } | null;
  }[];
}

interface RawDecklistPage {
  tournament?: { id?: number; name?: string; date?: string | null; playerCount?: number | null };
  data?: {
    player?: { name?: string | null } | null;
    standing?: number | null;
    wins?: number | null;
    losses?: number | null;
    deck?: { cards?: { quantity: number; card: { setCode?: string | null; number?: number | null; name?: string | null } | null }[] } | null;
  }[];
  hasMore?: boolean;
}

/**
 * Incremental sync: list tournaments from the overlap window (server-side
 * dateFrom filter — no full enumeration), fetch decklists only for events not
 * already complete in the committed state, retry pending events (in-progress /
 * private / late submissions), and rebuild the dataset from the immutable
 * per-event caches. A missing state file seeds from the existing dataset, so
 * the first incremental run never re-enumerates history.
 */
export async function sync(
  cfg: LHConfig,
  cards: CardIndex[],
  opts: { dataDir?: string; datasetPath?: string; dateFrom?: string; eventType?: string } = {}
): Promise<{ dataset: LHDataset; state: SyncState; fetched: number; skipped: number }> {
  const dataDir = opts.dataDir ?? path.join(ROOT, 'scripts', 'training', 'data', 'lorcanahunter');
  const eventsDir = path.join(dataDir, 'events');
  const datasetPath = opts.datasetPath ?? path.join(dataDir, '..', 'lorcanahunter.json');
  await mkdir(dataDir, { recursive: true });

  const state = (await loadSyncState(dataDir)) ?? (await seedStateFromDataset(dataDir, eventsDir));
  const from = opts.dateFrom ?? windowStart(state);
  const eventsDirReady = eventsDir;

  // 1. list tournaments inside the window (all pages — the API filters server-side)
  const listed = await listTournaments(cfg, { eventType: opts.eventType, dateFrom: from ?? undefined, format: 'core' });
  let fetched = 0;
  let skipped = 0;

  const fetchEvent = async (t: RawTournament): Promise<void> => {
    if (t.isPast === false) {
      markPending(state, String(t.id), 'in-progress');
      skipped++;
      return;
    }
    if (t.decklistsAvailable === false) {
      markPending(state, String(t.id), 'private');
      skipped++;
      return;
    }
    const cacheFile = path.join(eventsDirReady, `event-${t.id}.json`);
    const dataset = await fetchTournamentDataset(cfg, { id: t.id, name: t.name, date: t.date, playerCount: t.playerCount }, cards);
    await mkdir(eventsDirReady, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(dataset));
    recordEvent(state, String(t.id), { date: dataset.date, decklistCount: dataset.entries.length, complete: true });
    fetched++;
  };

  // 2. new events in the window
  for (const t of listed) {
    if (state.events[String(t.id)]?.complete) {
      skipped++;
      continue;
    }
    if (t.isPast === false) {
      markPending(state, String(t.id), 'in-progress');
      skipped++;
      continue;
    }
    await fetchEvent(t);
  }

  // 3. retry pending events (decklists may have been published since)
  for (const p of retryablePending(state)) {
    const t = listed.find((x) => String(x.id) === p.id);
    if (!t) continue;
    await fetchEvent(t);
  }

  // 4. rebuild the dataset from the immutable event caches
  const dataset: LHDataset = { source: 'lorcanahunter', fetchedOn: new Date().toISOString(), tournaments: [] };
  try {
    for (const f of (await readdir(eventsDirReady)).filter((f) => f.endsWith('.json'))) {
      dataset.tournaments.push(JSON.parse(await readFile(path.join(eventsDirReady, f), 'utf8')) as LHTournament);
    }
  } catch {
    /* no events cached yet */
  }
  dataset.tournaments.sort((a, b) => b.date.localeCompare(a.date));
  if (opts.datasetPath) {
    await mkdir(path.dirname(datasetPath), { recursive: true });
    await writeFile(datasetPath, JSON.stringify(dataset));
  }
  state.lastSyncedAt = new Date().toISOString();
  await saveSyncState(dataDir, state);
  return { dataset, state, fetched, skipped };
}

/** seed a fresh state from the committed dataset (first incremental run after a full backfill):
 * every committed tournament becomes an immutable event cache so the merge keeps history */
async function seedStateFromDataset(dataDir: string, eventsDir: string): Promise<SyncState> {
  const datasetPath = path.join(dataDir, '..', 'lorcanahunter.json');
  try {
    const ds = JSON.parse(await readFile(datasetPath, 'utf8')) as LHDataset;
    await mkdir(eventsDir, { recursive: true });
    for (const t of ds.tournaments) {
      await writeFile(path.join(eventsDir, `event-${t.eventId}.json`), JSON.stringify(t));
    }
    return seedFromDataset(ds.fetchedOn, ds.tournaments);
  } catch {
    return { lastSyncedAt: '', lastEventDate: '', pending: [], events: {} };
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export async function fetchTournamentDataset(
  cfg: LHConfig,
  tournament: { id: number; name: string; date: string | null; playerCount: number | null },
  cards: CardIndex[]
): Promise<LHTournament> {
  const entries: LHEntry[] = [];
  let page = 1;
  for (;;) {
    const res = await authedFetch(cfg, `${cfg.baseUrl ?? API}/api/v1/tournaments/${tournament.id}/decklists?page=${page}&limit=100`);
    if (res.status === 403) break; // decklists_private — standings-only event
    if (!res.ok) throw new Error(`lorcanahunter decklists ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as RawDecklistPage;
    for (const d of body.data ?? []) {
      if (!d.deck) continue; // players without a submitted decklist
      const mapped = mapCards(d.deck.cards ?? [], cards);
      entries.push({
        player: d.player?.name ?? null,
        standing: d.standing ?? null,
        winRate: winRateFrom(d.wins ?? null, d.losses ?? null),
        cards: mapped.cards,
        unmatched: mapped.unmatched,
      });
    }
    if (!body.hasMore) break;
    page++;
  }
  return {
    eventId: String(tournament.id),
    name: tournament.name,
    date: tournament.date ?? '',
    playerCount: tournament.playerCount ?? 0,
    // the contract exposes no top-cut size; top-cut-based training targets are
    // unavailable for this source until the artifact schema gains one
    topCut: 0,
    entries,
  };
}

/** list tournaments (paginated, newest first) within a window */
export async function listTournaments(
  cfg: LHConfig,
  opts: { eventType?: string; dateFrom?: string; dateTo?: string; format?: string; onPage?: (page: number, found: number) => Promise<void> }
): Promise<RawTournament[]> {
  const all: RawTournament[] = [];
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({ page: String(page), limit: '100' });
    if (opts.eventType) q.set('eventType', opts.eventType);
    if (opts.format) q.set('format', opts.format);
    if (opts.dateFrom) q.set('dateFrom', opts.dateFrom);
    if (opts.dateTo) q.set('dateTo', opts.dateTo);
    const res = await authedFetch(cfg, `${cfg.baseUrl ?? API}/api/v1/tournaments?${q}`);
    if (!res.ok) throw new Error(`lorcanahunter tournaments ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: RawTournament[]; hasMore: boolean; total: number };
    all.push(...(body.data ?? []));
    if (opts.onPage) await opts.onPage(page, body.total ?? 0);
    if (!body.hasMore) break;
    page++;
  }
  return all;
}


// CLI entry: npx tsx scripts/sources/lorcanahunter.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const clientId = process.env.LH_CLIENT_ID;
  const clientSecret = process.env.LH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('LH_CLIENT_ID / LH_CLIENT_SECRET missing — the application is not approved yet.');
    process.exit(1);
  }
  if (process.argv.includes('--full')) {
    const { rm } = await import('node:fs/promises');
    await rm(path.join(ROOT, 'scripts', 'training', 'data', 'lorcanahunter', 'state.json'), { force: true });
  }
  const raw = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'cards.min.json'), 'utf8')) as { cards: CardIndex[] };
  const { dataset, fetched, skipped } = await sync(
    { clientId, clientSecret, statePath: path.join(ROOT, '.data-cache', 'lorcanahunter-token.json') },
    raw.cards,
    { datasetPath: path.join(ROOT, 'scripts', 'training', 'data', 'lorcanahunter.json') }
  );
  const lists = dataset.tournaments.flatMap((t) => t.entries);
  console.log(`lorcanahunter: ${fetched} fetched, ${skipped} skipped — ${dataset.tournaments.length} tournaments, ${lists.length} decklists`);
}
