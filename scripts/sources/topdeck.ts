import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
export function parseDecklist(list: string, cards: CardIndex[]): ParsedDecklist {
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
  return { cards: [...out].map(([cardId, count]) => ({ cardId, count })), unmatched };
}

export const normalize = (s: string): string =>
  s.toLowerCase().replace(/[\u2019]/g, "'").replace(/[\u2010\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();

export interface CardIndex {
  id: number;
  fullName: string;
  setCode: string;
  collectorNumber: string;
}

/** fetch one date window of Lorcana Core Constructed tournaments (with standings + decklists) */
export async function fetchWindow(
  apiKey: string,
  start: number,
  end: number,
  participantMin: number
): Promise<unknown[]> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      game: 'Lorcana',
      format: 'Core Constructed',
      start,
      end,
      participantMin,
      columns: ['name', 'decklist', 'wins', 'losses', 'winRate'],
    }),
  });
  if (res.status === 429) {
    const retry = parseInt(res.headers.get('Retry-After') ?? '15', 10) * 1000;
    await new Promise((r) => setTimeout(r, retry));
    return fetchWindow(apiKey, start, end, participantMin);
  }
  if (!res.ok) throw new Error(`topdeck ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as unknown[];
  return Array.isArray(data) ? data : [];
}

/** windowed backfill: caches raw windows, then builds the normalized dataset */
export async function backfill(opts: {
  apiKey: string;
  cards: CardIndex[];
  days?: number;
  windowDays?: number;
  participantMin?: number;
  cacheDir?: string;
  datasetPath?: string;
}): Promise<TopdeckDataset> {
  const days = opts.days ?? 730;
  const windowDays = opts.windowDays ?? 30;
  const participantMin = opts.participantMin ?? 8;
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  await mkdir(cacheDir, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const tournaments = new Map<string, TopdeckTournament>();
  for (let end = now; end > now - days * 86400; end -= windowDays * 86400) {
    const start = Math.max(end - windowDays * 86400, now - days * 86400);
    const cacheFile = path.join(cacheDir, `window-${start}-${end}.json`);
    let raw: unknown[];
    try {
      raw = JSON.parse(await readFile(cacheFile, 'utf8'));
    } catch {
      raw = await fetchWindow(opts.apiKey, start, end, participantMin);
      await writeFile(cacheFile, JSON.stringify(raw));
      await new Promise((r) => setTimeout(r, 13_000)); // 5 req/min
    }
    for (const t of raw as TopdeckRawTournament[]) {
      if (tournaments.has(t.TID)) continue;
      tournaments.set(t.TID, toDatasetTournament(t, opts.cards));
    }
  }

  const dataset: TopdeckDataset = {
    source: 'topdeck',
    fetchedOn: new Date().toISOString(),
    tournaments: [...tournaments.values()],
  };
  if (opts.datasetPath) {
    await mkdir(path.dirname(opts.datasetPath), { recursive: true });
    await writeFile(opts.datasetPath, JSON.stringify(dataset));
  }
  return dataset;
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

export function toDatasetTournament(t: TopdeckRawTournament, cards: CardIndex[]): TopdeckTournament {
  const entries: TopdeckEntry[] = (t.standings ?? [])
    .filter((s) => typeof s.decklist === 'string' && s.decklist.length > 0)
    .map((s) => {
      const parsed = parseDecklist(s.decklist!, cards);
      return {
        player: s.name ?? null,
        standing: s.standing ?? null,
        winRate: s.winRate ?? null,
        cards: parsed.cards,
        unmatched: parsed.unmatched.map((u) => `${u.count}x ${u.name}${u.code ? ` (${u.code})` : ''}`),
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const key = process.env.TOPDECK_API_KEY;
  if (!key) throw new Error('TOPDECK_API_KEY missing (put it in .env)');
  const cardsFile = path.join(ROOT, 'public', 'data', 'cards.min.json');
  const raw = JSON.parse(await readFile(cardsFile, 'utf8')) as { cards: CardIndex[] };
  const cards: CardIndex[] = raw.cards.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    setCode: c.setCode,
    collectorNumber: (c as unknown as { collectorNumber: string }).collectorNumber,
  }));
  const dataset = await backfill({
    apiKey: key,
    cards,
    datasetPath: path.join(ROOT, 'scripts', 'training', 'data', 'topdeck.json'),
  });
  const lists = dataset.tournaments.flatMap((t) => t.entries);
  const cardsTotal = lists.reduce((s, e) => s + e.cards.reduce((x, c) => x + c.count, 0), 0);
  console.log(
    `topdeck: ${dataset.tournaments.length} tournaments, ${lists.length} decklists, ${cardsTotal} mapped cards`
  );
}
