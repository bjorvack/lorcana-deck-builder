import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CardIndex,
  normalize,
  readEventCache,
  retryAfterMs,
  writeEventCache,
} from './shared';
import {
  loadSyncState,
  markPending,
  recordEvent,
  retryablePending,
  type SyncState,
  saveSyncState,
  windowStart,
} from './sync-state';

export type { CardIndex } from './shared';
export { normalize } from './shared';

/**
 * TopDeck.gg source adapter — the interim tournament corpus while the
 * Lorcanahunter application is pending. Produces the same normalized dataset
 * shape the Lorcanahunter adapter will emit, so the training script is
 * source-agnostic:
 *
 *   { source, fetchedOn, tournaments: [{ eventId, name, date, format,
 *       playerCount, topCut, entries: [{ player, standing, winRate,
 *       cards: [{ cardId, count }], unmatched }] }] }
 *
 * TopDeck decklists are text ("4 Card Name (11-29)"); the parenthetical is the
 * collector code, which maps directly onto the card snapshot — more reliable
 * than name matching. Rate limits: 5 req/min on the bulk search endpoint.
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const CACHE_DIR = path.join(ROOT, '.data-cache', 'topdeck');
const API = 'https://topdeck.gg/api/v2/tournaments';

export interface TopdeckEntry {
  player: string | null;
  standing: number | null;
  winRate: number | null;
  cards: { cardId: number; count: number }[];
  unmatched: string[];
}

export interface TopdeckTournament {
  eventId: string;
  name: string;
  date: string;
  playerCount: number;
  topCut: number;
  entries: TopdeckEntry[];
}

export interface TopdeckDataset {
  source: 'topdeck';
  fetchedOn: string;
  tournaments: TopdeckTournament[];
}

export interface ParsedDecklist {
  cards: { cardId: number; count: number }[];
  unmatched: { name: string; code: string | null; count: number }[];
}

/** parse "4 Card Name (11-29)" lines against the normalized card snapshot */
export function parseDecklist(
  list: string,
  cards: CardIndex[],
): ParsedDecklist {
  const byCode = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const c of cards) {
    byCode.set(`${c.setCode}-${c.collectorNumber}`, c.id);
    byName.set(normalize(c.fullName), c.id);
  }
  const out = new Map<number, number>();
  const unmatched: ParsedDecklist['unmatched'] = [];
  for (const line of list.split(/\\n|\n/)) {
    const m = line.trim().match(/^(\d+)x? (.+?)(?: \((\d+-\d+)\))?$/);
    if (!m) continue;
    const count = parseInt(m[1]!, 10);
    const name = m[2]!;
    const code = m[3] ?? null;
    let id = code ? byCode.get(code) : undefined;
    if (id === undefined) id = byName.get(normalize(name));
    if (id === undefined) {
      unmatched.push({ name, code, count });
      continue;
    }
    out.set(id, (out.get(id) ?? 0) + count);
  }
  return {
    cards: [...out].map(([cardId, count]) => ({ cardId, count })),
    unmatched,
  };
}

/** fetch one date window of Lorcana Core Constructed tournaments (with standings + decklists) */
export async function fetchWindow(
  apiKey: string,
  start: number,
  end: number,
  participantMin: number,
): Promise<unknown[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game: 'Lorcana',
        format: 'Core Constructed',
        start,
        end,
        participantMin,
        // standing is read from each entry when building the normalized dataset
        columns: ['name', 'standing', 'decklist', 'wins', 'losses', 'winRate'],
      }),
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, retryAfterMs(res, 15_000)));
      continue;
    }
    if (!res.ok) throw new Error(`topdeck ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as unknown[];
    return Array.isArray(data) ? data : [];
  }
  throw new Error('unreachable');
}

/**
 * Incremental sync: fetches only the date windows since the last synced event
 * (minus the overlap), writes new events as immutable per-event caches, and
 * rebuilds the dataset by merging every cache. A missing state seeds from the
 * committed dataset (so the first incremental run never re-fetches history);
 * `--full` resets the state.
 */
export async function syncTopdeck(opts: {
  apiKey: string;
  cards: CardIndex[];
  dataDir?: string;
  cacheDir?: string;
  datasetPath?: string;
  days?: number;
  windowDays?: number;
  participantMin?: number;
  full?: boolean;
  fetchWindowImpl?: typeof fetchWindow;
  /** rate-limit pause between live window fetches (tests pass 0) */
  sleepMs?: number;
}): Promise<{
  dataset: TopdeckDataset;
  state: SyncState;
  fetched: number;
  skipped: number;
}> {
  const dataDir =
    opts.dataDir ?? path.join(ROOT, 'scripts', 'training', 'data', 'topdeck');
  const eventsDir = path.join(dataDir, 'events');
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const datasetPath =
    opts.datasetPath ?? path.join(dataDir, '..', 'topdeck.json');
  const days = opts.days ?? 730;
  const windowDays = opts.windowDays ?? 30;
  const participantMin = opts.participantMin ?? 8;
  const fetchWindows = opts.fetchWindowImpl ?? fetchWindow;
  await mkdir(cacheDir, { recursive: true });
  await mkdir(eventsDir, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const state: SyncState = (!opts.full
    ? await loadSyncState(dataDir)
    : null) ?? {
    lastSyncedAt: '',
    lastEventDate: '',
    pending: [],
    events: {},
  };
  const tournaments = new Map<string, TopdeckTournament>();
  const recordIncomplete = (id: string, date: string, retry: boolean): void => {
    state.events[id] = { date, decklistCount: 0, complete: false };
    if (date > state.lastEventDate) state.lastEventDate = date;
    if (retry || !state.pending.some((p) => p.id === id))
      markPending(state, id, 'incomplete');
  };
  const rememberCachedEvent = (t: TopdeckTournament): void => {
    tournaments.set(t.eventId, t);
    if (t.entries.length === 0) {
      recordIncomplete(t.eventId, t.date, false);
      return;
    }
    recordEvent(state, t.eventId, {
      date: t.date,
      decklistCount: t.entries.length,
      complete: true,
    });
  };

  // repair zero-decklist completions written by older syncs
  for (const [id, info] of Object.entries(state.events)) {
    if (info.complete && info.decklistCount === 0) {
      state.events[id] = { ...info, complete: false };
      if (!state.pending.some((p) => p.id === id))
        markPending(state, id, 'incomplete');
    }
  }

  // seed from the committed dataset + existing event caches (no re-fetch)
  if (!opts.full) {
    try {
      const committed = JSON.parse(
        await readFile(datasetPath, 'utf8'),
      ) as TopdeckDataset;
      for (const t of committed.tournaments) {
        const cacheFile = path.join(eventsDir, `event-${t.eventId}.json`);
        if ((await readEventCache<TopdeckTournament>(cacheFile)) === null)
          await writeEventCache(cacheFile, t);
        rememberCachedEvent(t);
      }
    } catch {
      /* no committed dataset yet */
    }
    for (const f of (await readdir(eventsDir)).filter(
      (f) => f.startsWith('event-') && f.endsWith('.json'),
    )) {
      const cached = await readEventCache<TopdeckTournament>(
        path.join(eventsDir, f),
      );
      if (cached) rememberCachedEvent(cached);
    }
  }

  // listing window: overlap on the newest synced event, or the full range on first run
  const windowStartStr = !opts.full ? windowStart(state) : null;
  const listFrom = windowStartStr
    ? Math.floor(new Date(`${windowStartStr}T00:00:00Z`).getTime() / 1000)
    : now - days * 86400;

  let fetched = 0;
  let skipped = 0;
  const processTournament = async (t: TopdeckRawTournament): Promise<void> => {
    if (tournaments.has(t.TID) && state.events[t.TID]?.complete) {
      skipped++;
      return;
    }
    const datasetT = toDatasetTournament(t, opts.cards);
    await writeEventCache(
      path.join(eventsDir, `event-${t.TID}.json`),
      datasetT,
    );
    tournaments.set(t.TID, datasetT);
    if (datasetT.entries.length === 0) {
      recordIncomplete(t.TID, datasetT.date, true);
    } else {
      recordEvent(state, t.TID, {
        date: datasetT.date,
        decklistCount: datasetT.entries.length,
        complete: true,
      });
    }
    fetched++;
  };
  const hasDecklists = (t: TopdeckRawTournament): boolean =>
    (t.standings ?? []).some(
      (s) => typeof s.decklist === 'string' && s.decklist.length > 0,
    );
  const listedIds = new Set<string>();
  for (let end = now; end > listFrom; end -= windowDays * 86400) {
    const start = Math.max(end - windowDays * 86400, listFrom);
    const cacheFile = path.join(cacheDir, `window-${start}.json`);
    let raw = await readEventCache<TopdeckRawTournament[]>(cacheFile);
    // incomplete listings stay live so late-published decklists are observed
    if (raw?.some((t) => !hasDecklists(t))) raw = null;
    const cacheHit = raw !== null;
    if (raw === null) {
      raw = (await fetchWindows(
        opts.apiKey,
        start,
        end,
        participantMin,
      )) as TopdeckRawTournament[];
      await new Promise((r) => setTimeout(r, opts.sleepMs ?? 13_000)); // 5 req/min
    }
    for (const t of raw) {
      listedIds.add(t.TID);
      await processTournament(t);
    }
    if (!cacheHit && raw.every(hasDecklists))
      await writeFile(cacheFile, JSON.stringify(raw));
  }

  // retry pending events even after they leave the incremental listing window
  for (const p of retryablePending(state)) {
    if (listedIds.has(p.id)) continue;
    const date = state.events[p.id]?.date;
    if (!date) continue;
    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const raw = (await fetchWindows(
      opts.apiKey,
      start,
      start + 2 * 86400,
      participantMin,
    )) as TopdeckRawTournament[];
    await new Promise((r) => setTimeout(r, opts.sleepMs ?? 13_000)); // 5 req/min
    const t = raw.find((t) => t.TID === p.id);
    if (t) await processTournament(t);
  }

  // event caches are authoritative: a crashed dataset write cannot orphan events
  const cachedTournaments: TopdeckTournament[] = [];
  for (const f of (await readdir(eventsDir)).filter(
    (f) => f.startsWith('event-') && f.endsWith('.json'),
  )) {
    const cached = await readEventCache<TopdeckTournament>(
      path.join(eventsDir, f),
    );
    if (cached) cachedTournaments.push(cached);
  }
  const dataset: TopdeckDataset = {
    source: 'topdeck',
    fetchedOn: new Date().toISOString(),
    tournaments: cachedTournaments,
  };
  await mkdir(path.dirname(datasetPath), { recursive: true });
  await writeFile(datasetPath, JSON.stringify(dataset));
  state.lastSyncedAt = new Date().toISOString();
  await saveSyncState(dataDir, state);
  return { dataset, state, fetched, skipped };
}

interface TopdeckRawTournament {
  TID: string;
  tournamentName: string;
  startDate: number;
  topCut: number;
  standings: {
    name?: string;
    standing?: number;
    decklist?: string | null;
    winRate?: number;
  }[];
}

export function toDatasetTournament(
  t: TopdeckRawTournament,
  cards: CardIndex[],
): TopdeckTournament {
  // the API does not return a standing field (verified live 2026-11-20) — the
  // standings array is rank-ordered, so the index is the standing; an explicit
  // field is honored in case the API adds one
  const entries: TopdeckEntry[] = (t.standings ?? [])
    .map((s, index) => ({
      s,
      standing: typeof s.standing === 'number' ? s.standing : index + 1,
    }))
    .filter(({ s }) => typeof s.decklist === 'string' && s.decklist.length > 0)
    .map(({ s, standing }) => {
      const parsed = parseDecklist(s.decklist!, cards);
      return {
        player: s.name ?? null,
        standing,
        winRate: s.winRate ?? null,
        cards: parsed.cards,
        unmatched: parsed.unmatched.map(
          (u) => `${u.count}x ${u.name}${u.code ? ` (${u.code})` : ''}`,
        ),
      };
    });
  return {
    eventId: t.TID,
    name: t.tournamentName,
    date: new Date(t.startDate * 1000).toISOString().slice(0, 10),
    playerCount: (t.standings ?? []).length,
    topCut: t.topCut ?? 0,
    entries,
  };
}

// CLI entry: npx tsx scripts/sources/topdeck.ts
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const key = process.env.TOPDECK_API_KEY;
  if (!key) throw new Error('TOPDECK_API_KEY missing (put it in .env)');
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
  const full = process.argv.includes('--full');
  const { dataset, fetched, skipped } = await syncTopdeck({
    apiKey: key,
    cards,
    datasetPath: path.join(ROOT, 'scripts', 'training', 'data', 'topdeck.json'),
    full,
  });
  console.log(
    full
      ? '(full backfill)'
      : `(incremental: ${fetched} fetched, ${skipped} skipped)`,
  );
  const lists = dataset.tournaments.flatMap((t) => t.entries);
  const cardsTotal = lists.reduce(
    (s, e) => s + e.cards.reduce((x, c) => x + c.count, 0),
    0,
  );
  console.log(
    `topdeck: ${dataset.tournaments.length} tournaments, ${lists.length} decklists, ${cardsTotal} mapped cards`,
  );
}
