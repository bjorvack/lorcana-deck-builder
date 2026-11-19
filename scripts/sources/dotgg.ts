import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSyncState,
  markPending,
  PENDING_MAX_ATTEMPTS,
  recordEvent,
  retryablePending,
  type SyncState,
  saveSyncState,
} from './sync-state';
import { type CardIndex, normalize } from './topdeck';

/**
 * DotGG (lorcana.gg) source adapter — deep historical tournament corpus.
 *
 * The public docs omit the tournaments endpoints; they exist anyway:
 *   GET /cgfw/gettournaments?game=lorcana&page=N   — 30/page, newest first
 *   GET /cgfw/gettournament?game=lorcana&slug=...  — full standings (Limitless-sourced)
 *   GET /cgfw/getdeck?game=lorcana&slug=<deckId>   — card list keyed by "SET-NUM" ids
 *
 * Rate limit: 1 req/s documented. Decklists are NOT embedded in standings —
 * each is one getdeck call, so the backfill is budgeted (--limit / --max-decks)
 * and resumable: raw pages/tournaments/decks are cached in .data-cache, events
 * land as immutable caches in the committed events dir (git = CI persistence).
 * The event-cache skip is cut-aware: a later `--cut 0` run deepens a top-8
 * backfill, live-fetching only standings beyond the stored cut.
 *
 * Archetype ids on decks cannot be resolved (getarchetypes is not allowlisted
 * for lorcana), so ink-color pairs are the usable grouping. The tournament cut
 * size is not exposed; we fetch the top `cut` standings and record that as
 * topCut, matching what the dataset actually contains.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const CACHE_DIR = path.join(ROOT, '.data-cache', 'dotgg');
const API = 'https://api.dotgg.gg/cgfw';

/** documented limit: 1 request per second */
export const RATE_LIMIT_MS = 1000;

export interface DotggEntry {
  player: string | null;
  standing: number | null;
  winRate: number | null;
  cards: { cardId: number; count: number }[];
  unmatched: string[];
}

export interface DotggTournament {
  eventId: string;
  name: string;
  date: string;
  playerCount: number;
  topCut: number;
  entries: DotggEntry[];
}

export interface DotggDataset {
  source: 'dotgg';
  fetchedOn: string;
  tournaments: DotggTournament[];
}

interface DotggTournamentSummary {
  /** numeric id — only on the detail response; page summaries are keyed by slug */
  id?: string;
  name: string;
  slug: string;
  date: string;
  players_count?: string;
}

interface DotggStanding {
  standing_place?: string;
  standing_record?: string;
  player_name?: string;
  /** deck id/slug — absent when the player has no public list */
  id?: string;
  slug?: string;
}

interface DotggTournamentDetail extends DotggTournamentSummary {
  standings?: DotggStanding[];
}

interface DotggDeck {
  id?: string;
  slug?: string;
  deck?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// fetchers

async function getJson<T>(
  url: string,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`dotgg ${res.status}: ${url}`);
  const body = await res.text();
  if (body.trim() === '' || body.trim() === '"[]"') return null;
  return JSON.parse(body) as T;
}

export async function fetchPage(
  page: number,
  fetchImpl: typeof fetch,
): Promise<DotggTournamentSummary[]> {
  const data = await getJson<DotggTournamentSummary[] | string>(
    `${API}/gettournaments?game=lorcana&page=${page}`,
    fetchImpl,
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchTournament(
  slug: string,
  fetchImpl: typeof fetch,
): Promise<DotggTournamentDetail> {
  const data = await getJson<DotggTournamentDetail>(
    `${API}/gettournament?game=lorcana&slug=${encodeURIComponent(slug)}`,
    fetchImpl,
  );
  if (!data || typeof data !== 'object' || !('standings' in data)) {
    throw new Error(`dotgg: no tournament detail for ${slug}`);
  }
  return data;
}

export async function fetchDeck(
  deckId: string,
  fetchImpl: typeof fetch,
): Promise<DotggDeck> {
  const data = await getJson<DotggDeck>(
    `${API}/getdeck?game=lorcana&slug=${encodeURIComponent(deckId)}`,
    fetchImpl,
  );
  if (!data || typeof data !== 'object' || !('deck' in data)) {
    throw new Error(`dotgg: no deck for ${deckId}`);
  }
  return data;
}

interface DotggCardRecord {
  id?: string;
  displayName?: string | null;
}

/** current card-data version — keys the raw card-DB cache so new sets invalidate it */
export async function fetchDataVersion(
  fetchImpl: typeof fetch,
): Promise<number | null> {
  const res = await fetchImpl('https://butterfly.dotgg.gg/?game=lorcana');
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

export async function fetchDotggCards(
  fetchImpl: typeof fetch,
): Promise<DotggCardRecord[]> {
  const data = await getJson<DotggCardRecord[] | string>(
    `${API}/getcards?game=lorcana`,
    fetchImpl,
  );
  return Array.isArray(data) ? data : [];
}

/**
 * dot.gg promo ids (P1/D23/…) use their own numbering, unresolvable by code —
 * but their displayName matches a snapshot fullName, and train.ts canonicalizes
 * prints by name anyway, so any print id of that name is identity-correct.
 */
export function buildIdPremap(
  dotggCards: DotggCardRecord[],
  cards: CardIndex[],
): Map<string, number> {
  const byName = new Map<string, number>();
  for (const c of cards) {
    const key = normalize(c.fullName);
    if (!byName.has(key)) byName.set(key, c.id);
  }
  const premap = new Map<string, number>();
  for (const card of dotggCards) {
    if (!card.id || !card.displayName) continue;
    const id = byName.get(normalize(card.displayName));
    if (id !== undefined) premap.set(normalizeCode(card.id), id);
  }
  return premap;
}

// ---------------------------------------------------------------------------
// mapping

/** zero-strip numeric segments so "002-201" matches snapshot code "2-201" ("Q1"/"P2" stay as-is) */
export function normalizeCode(code: string): string {
  const dash = code.indexOf('-');
  const strip = (s: string): string => s.replace(/^0+(?=\d)/, '').toLowerCase();
  if (dash === -1) return strip(code);
  return `${strip(code.slice(0, dash))}-${strip(code.slice(dash + 1))}`;
}

/** "10-1-1" → 10/12; empty/malformed → null (train drops win-rate-less rows) */
export function parseRecord(record: string | undefined): number | null {
  if (!record) return null;
  const parts = record
    .trim()
    .split('-')
    .map((p) => parseInt(p, 10));
  if (parts.length < 2 || parts.some((p) => Number.isNaN(p))) return null;
  const wins = parts[0]!;
  const total = parts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return wins / total;
}

export interface MappedDeck {
  cards: { cardId: number; count: number }[];
  unmatched: string[];
}

/** dot.gg deck ids are "SET-NUM" strings; the premap resolves promo ids by name. Unmapped ids land in unmatched (train drops < 55 mapped) */
export function mapDeck(
  deck: Record<string, string>,
  cards: CardIndex[],
  premap?: Map<string, number>,
): MappedDeck {
  const byCode = new Map<string, number>();
  const out = new Map<number, number>();
  const unmatched: string[] = [];
  for (const c of cards)
    byCode.set(normalizeCode(`${c.setCode}-${c.collectorNumber}`), c.id);
  for (const [code, rawCount] of Object.entries(deck)) {
    if (code === 'undefined') continue; // dot.gg serialization bug: a card with no id
    const count = parseInt(rawCount, 10);
    if (!Number.isFinite(count) || count <= 0) continue;
    const id =
      byCode.get(normalizeCode(code)) ?? premap?.get(normalizeCode(code));
    if (id === undefined) {
      unmatched.push(`${count}x ${code}`);
      continue;
    }
    out.set(id, (out.get(id) ?? 0) + count);
  }
  return {
    cards: [...out].map(([cardId, count]) => ({ cardId, count })),
    unmatched,
  };
}

const toIsoDate = (unixSeconds: string | number): string =>
  new Date(parseInt(String(unixSeconds), 10) * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// sync

export interface SyncDotggOptions {
  cards: CardIndex[];
  dataDir?: string;
  cacheDir?: string;
  datasetPath?: string;
  /** fetch decklists for standings with place ≤ cut (0 = all); default 8 */
  cut?: number;
  /** skip tournaments with fewer players; default 8 (topdeck parity) */
  participantMin?: number;
  full?: boolean;
  /** stop after this many new tournaments processed this run (chunked backfill) */
  limitTournaments?: number;
  /** stop after this many live deck fetches this run (chunked backfill) */
  maxDeckFetches?: number;
  fetchImpl?: typeof fetch;
  /** rate-limit pause between live fetches (tests pass 0) */
  sleepMs?: number;
  log?: (msg: string) => void;
}

export interface SyncDotggResult {
  dataset: DotggDataset;
  state: SyncState;
  fetched: number;
  skipped: number;
  deckFetches: number;
  unmatched: number;
  exhausted: boolean;
}

export async function syncDotgg(
  opts: SyncDotggOptions,
): Promise<SyncDotggResult> {
  const dataDir =
    opts.dataDir ?? path.join(ROOT, 'scripts', 'training', 'data', 'dotgg');
  const eventsDir = path.join(dataDir, 'events');
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const datasetPath =
    opts.datasetPath ?? path.join(dataDir, '..', 'dotgg.json');
  const cut = opts.cut ?? 8;
  const participantMin = opts.participantMin ?? 8;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepMs = opts.sleepMs ?? RATE_LIMIT_MS;
  const log = opts.log ?? (() => {});
  await mkdir(cacheDir, { recursive: true });
  await mkdir(eventsDir, { recursive: true });

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));
  /** cache-or-fetch at the documented 1 req/s; raw caches are the backfill's resume layer */
  const cachedJson = async <T>(
    file: string,
    fetcher: () => Promise<T>,
  ): Promise<T> => {
    try {
      return JSON.parse(await readFile(path.join(cacheDir, file), 'utf8')) as T;
    } catch {
      const data = await fetcher();
      await writeFile(path.join(cacheDir, file), JSON.stringify(data));
      if (sleepMs > 0) await sleep(sleepMs);
      return data;
    }
  };

  // promo-id premap: one card-DB fetch per run (data-version-keyed cache); on
  // failure the sync degrades to code-only mapping
  let premap: Map<string, number> | undefined;
  try {
    const version = await fetchDataVersion(fetchImpl);
    const dotggCards = await cachedJson(
      version !== null ? `cards-${version}.json` : 'cards.json',
      () => fetchDotggCards(fetchImpl),
    );
    premap = buildIdPremap(dotggCards, opts.cards);
    log(`premap: ${premap.size} dotgg ids resolvable by name`);
  } catch (err) {
    log(
      `premap unavailable (${err instanceof Error ? err.message : String(err)}) — code-only mapping`,
    );
  }

  const loaded = opts.full ? null : await loadSyncState(dataDir);
  const state: SyncState = loaded ?? {
    lastSyncedAt: '',
    lastEventDate: '',
    pending: [],
    events: {},
  };
  const known = new Set(Object.keys(state.events));
  const exhaustedPending = (id: string): boolean =>
    (state.pending.find((p) => p.id === id)?.attempts ?? 0) >=
    PENDING_MAX_ATTEMPTS;

  const readEventCache = async (
    slug: string,
  ): Promise<DotggTournament | null> => {
    try {
      return JSON.parse(
        await readFile(path.join(eventsDir, `event-${slug}.json`), 'utf8'),
      ) as DotggTournament;
    } catch {
      return null;
    }
  };
  /** does this event's stored cut already include everything the requested cut would fetch? */
  const coversCut = (e: DotggTournament, requested: number): boolean =>
    e.topCut === 0 || (requested > 0 && e.topCut >= requested);

  // phase 1 — enumerate listing pages (newest first) until a full page is fully
  // covered. Page summaries carry no id — the slug is the stable listing-time key.
  // Known events are re-queued only for deepening (stored cut < requested cut).
  const queue: DotggTournamentSummary[] = [];
  let skipped = 0;
  for (let page = 1; ; page++) {
    const list = await cachedJson(`page-${page}.json`, () =>
      fetchPage(page, fetchImpl),
    );
    if (list.length === 0) break;
    const fresh: DotggTournamentSummary[] = [];
    for (const t of list) {
      if (known.has(t.slug)) {
        const cachedEvent = await readEventCache(t.slug);
        // known events without a cache (participantMin skips) stay done
        if (cachedEvent === null || coversCut(cachedEvent, cut)) {
          skipped++;
          continue;
        }
      } else if (exhaustedPending(t.slug)) {
        continue;
      }
      fresh.push(t);
    }
    queue.push(...fresh);
    if (fresh.length === 0) break;
    log(`page ${page}: ${fresh.length}/${list.length} new`);
  }
  // failed tournaments live in state.pending with their slug — retry them even
  // when they sit deep in the listing past the incremental stop point
  const queuedSlugs = new Set(queue.map((t) => t.slug));
  for (const p of retryablePending(state)) {
    if (!queuedSlugs.has(p.id))
      queue.push({
        name: p.id,
        slug: p.id,
        date: state.events[p.id]?.date ?? '',
      });
  }

  // phase 2 — per tournament: standings → decklists → immutable event cache
  let fetched = 0;
  let deckFetches = 0;
  let unmatched = 0;
  let exhausted = false;
  const decksToFetch = opts.maxDeckFetches ?? Number.POSITIVE_INFINITY;
  const toProcess =
    opts.limitTournaments !== undefined
      ? queue.slice(0, opts.limitTournaments)
      : queue;

  for (const summary of toProcess) {
    const eventCache = path.join(eventsDir, `event-${summary.slug}.json`);
    const cachedEvent = await readEventCache(summary.slug);
    // skip only when the cached cut covers the requested one, so a later run can
    // deepen a top-8 backfill (--cut 0 / 16): re-processing re-reads cached raw
    // decks and live-fetches only the delta
    if (cachedEvent !== null && coversCut(cachedEvent, cut)) {
      recordEvent(state, summary.slug, {
        date: cachedEvent.date,
        decklistCount: cachedEvent.entries.length,
        complete: true,
      });
      skipped++;
      continue;
    }
    if (deckFetches >= decksToFetch) {
      exhausted = true;
      break;
    }

    try {
      const detail = await cachedJson(`tour-${summary.slug}.json`, () =>
        fetchTournament(summary.slug, fetchImpl),
      );
      const standings = detail.standings ?? [];
      const playerCount =
        parseInt(detail.players_count ?? '', 10) || standings.length;
      if (playerCount < participantMin) {
        recordEvent(state, summary.slug, {
          date: toIsoDate(detail.date),
          decklistCount: 0,
          complete: true,
        });
        skipped++;
        continue;
      }

      const entries: DotggEntry[] = [];
      for (const s of standings) {
        const place = parseInt(s.standing_place ?? '', 10);
        if (cut > 0 && (Number.isNaN(place) || place > cut)) continue;
        const deckId = s.id ?? s.slug;
        if (!deckId) continue;
        const raw = await cachedJson(`deck-${deckId}.json`, () => {
          deckFetches++;
          return fetchDeck(deckId, fetchImpl);
        });
        const mapped = mapDeck(raw.deck ?? {}, opts.cards, premap);
        unmatched += mapped.unmatched.length;
        entries.push({
          player: s.player_name ?? null,
          standing: Number.isNaN(place) ? null : place,
          winRate: parseRecord(s.standing_record),
          cards: mapped.cards,
          unmatched: mapped.unmatched,
        });
      }

      const tournament: DotggTournament = {
        eventId: detail.id ?? summary.slug,
        name: detail.name,
        date: toIsoDate(detail.date),
        playerCount,
        topCut: cut,
        entries,
      };
      await writeFile(eventCache, JSON.stringify(tournament));
      recordEvent(state, summary.slug, {
        date: tournament.date,
        decklistCount: entries.length,
        complete: true,
      });
      fetched++;
      log(
        `${fetched}/${toProcess.length} ${tournament.date} ${tournament.name}: ${entries.length} lists ` +
          `(${deckFetches} deck fetches)`,
      );
    } catch (err) {
      markPending(state, summary.slug, 'incomplete');
      log(
        `failed ${summary.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // phase 3 — rebuild the dataset from every committed event cache
  const tournaments: DotggTournament[] = [];
  for (const f of (await readdir(eventsDir)).filter(
    (f) => f.startsWith('event-') && f.endsWith('.json'),
  )) {
    try {
      tournaments.push(
        JSON.parse(
          await readFile(path.join(eventsDir, f), 'utf8'),
        ) as DotggTournament,
      );
    } catch {
      /* skip unreadable cache */
    }
  }
  tournaments.sort((a, b) => a.date.localeCompare(b.date));
  const dataset: DotggDataset = {
    source: 'dotgg',
    fetchedOn: new Date().toISOString(),
    tournaments,
  };
  await mkdir(path.dirname(datasetPath), { recursive: true });
  await writeFile(datasetPath, JSON.stringify(dataset));
  state.lastSyncedAt = new Date().toISOString();
  await saveSyncState(dataDir, state);

  return {
    dataset,
    state,
    fetched,
    skipped,
    deckFetches,
    unmatched,
    exhausted,
  };
}

// CLI entry: npx tsx scripts/sources/dotgg.ts [--full] [--cut N] [--limit N] [--max-decks N]
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arg = (name: string): number | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    const inline = i !== -1 ? process.argv[i + 1] : undefined;
    return inline !== undefined ? parseInt(inline, 10) : undefined;
  };
  const cardsFile = path.join(ROOT, 'public', 'data', 'cards.min.json');
  const raw = JSON.parse(await readFile(cardsFile, 'utf8')) as {
    cards: CardIndex[];
  };
  const cards: CardIndex[] = raw.cards.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    setCode: c.setCode,
    collectorNumber: (c as unknown as { collectorNumber: string })
      .collectorNumber,
  }));
  const { dataset, fetched, skipped, deckFetches, unmatched, exhausted } =
    await syncDotgg({
      cards,
      full: process.argv.includes('--full'),
      // full depth by default — the backfill era is over, new events should land
      // complete so no re-deepen pass is ever needed
      cut: arg('cut') ?? 0,
      limitTournaments: arg('limit'),
      maxDeckFetches: arg('max-decks'),
      log: (m) => console.log(m),
    });
  console.log(
    `${process.argv.includes('--full') ? '(full) ' : ''}${fetched} fetched, ${skipped} skipped, ${deckFetches} deck fetches${exhausted ? ', BUDGET EXHAUSTED — rerun to continue' : ''}`,
  );
  const lists = dataset.tournaments.flatMap((t) => t.entries);
  const cardsTotal = lists.reduce(
    (s, e) => s + e.cards.reduce((x, c) => x + c.count, 0),
    0,
  );
  console.log(
    `dotgg: ${dataset.tournaments.length} tournaments, ${lists.length} decklists, ${cardsTotal} mapped cards, ${unmatched} unmatched ids`,
  );
}
