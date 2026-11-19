import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CardIndex,
  type LHDataset,
  type LHEntry,
  type LHTournament,
  mapCards,
} from './lorcanahunter';

/**
 * TEMPORARY Lorcanahunter backfill via the public website — while the OAuth
 * application (LH_CLIENT_ID/SECRET) is unapproved. Writes the exact same
 * per-event cache + dataset schema as the API adapter (scripts/sources/
 * lorcanahunter.ts), so the official incremental sync seeds from these events
 * (seedStateFromDataset) and never re-fetches them once approved.
 *
 * Scraped surfaces (all public, server-rendered):
 * - listing:  /en/past-events?decklists=with&page=N  → tournament links
 * - detail:   /tournament/{id}/{slug}                → JSON-LD metadata +
 *                                                      standings table rows
 * - deck:     .../player/{playerId}/deck             → data-deck-export-
 *                                                      cards-value JSON
 *                                                      [{name, quantity}]
 *
 * Politeness: strictly sequential, delay between requests, honest UA, CORE
 * events only (the trainer's format), resume-safe via event caches.
 *
 * CLI: npx tsx scripts/sources/lorcanahunter-scrape.ts [--pages 0] [--limit 100] [--max-events 9999] [--delay 400]
 *      (--pages 0 crawls the listing until exhausted; cached events are skipped)
 */

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SITE = 'https://lorcanahunter.com';
const UA =
  'lorcana-deck-builder-initial-backfill/0.1 (one-off backfill while API access is pending)';

const args = process.argv.slice(2);
const flag = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  // 0 is a meaningful value (--pages 0 = crawl until exhausted); NaN falls back
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : def;
};
const PAGES = flag('pages', 2); // 0 → loop listing pages until no new events appear
const MAX_EVENTS = flag('max-events', 25);
const DELAY_MS = flag('delay', 350);
const LISTING_LIMIT = flag('limit', 25);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

interface ListingTarget {
  id: number;
  slug: string;
}

async function listingTargets(page: number): Promise<ListingTarget[]> {
  const html = await get(
    `${SITE}/en/past-events?country=&format=&viewMode=blocks&page=${page}&limit=${LISTING_LIMIT}&decklists=with`,
  );
  const seen = new Set<number>();
  const out: ListingTarget[] = [];
  for (const m of html.matchAll(/href="\/tournament\/(\d+)\/([a-z0-9-]+)"/gi)) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, slug: m[2]! });
  }
  return out;
}

interface StandingRow {
  standing: number;
  player: string;
  wins: number;
  losses: number;
  draws: number;
  /** full deck-page path (query params included, entities decoded) */
  deckHref: string | null;
}

/** parse the detail page: metadata + standings rows (deck link = submitted decklist) */
export function parseDetail(html: string): {
  name: string;
  date: string;
  playerCount: number;
  format: 'CORE' | 'INFINITY' | null;
  rows: StandingRow[];
} {
  const ldld = /"startDate":"(\d{4}-\d{2}-\d{2})/.exec(html)?.[1] ?? '';
  const playerCount = Number(
    /"maximumAttendeeCapacity":(\d+)/.exec(html)?.[1] ?? 0,
  );
  const name = /<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1]?.trim() ?? '';
  const format =
    (/>\s*(CORE|INFINITY)\s*</.exec(html)?.[1] as 'CORE' | 'INFINITY' | null) ??
    null;

  const tableMatch = /<table[^>]*>[\s\S]*?<\/table>/.exec(
    html.slice(html.indexOf('id="players"')),
  );
  const rows: StandingRow[] = [];
  if (tableMatch) {
    for (const rowHtml of tableMatch[0].matchAll(
      /<tr[^>]*>([\s\S]*?)<\/tr>/g,
    )) {
      const row = rowHtml[1]!;
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
        (c) => c[1]!,
      );
      if (cells.length < 3) continue; // header row
      const standing = Number(/#(\d+)/.exec(cells[0]!)?.[1] ?? 0);
      if (!standing) continue;
      const wld =
        /(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/.exec(
          cells[0]!.replace(/<[^>]+>/g, ' '),
        ) ?? // some layouts keep W-L-D in the player cell
        /(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/.exec(
          cells[2]!.replace(/<[^>]+>/g, ' '),
        );
      if (!wld) continue;
      const anchor = /<a[^>]*>([^<]+)<\/a>/.exec(cells[0]!)?.[1] ?? '';
      const player = (anchor || cells[0]!.replace(/<[^>]+>/g, ' '))
        .replace(/#\d+\s*/, '')
        .trim();
      // the deck link carries its own (deck-entry) id and query params — use the full URL
      const deckHref = /href="([^"]*\/player\/\d+\/deck[^"]*)"/.exec(row)?.[1];
      rows.push({
        standing,
        player,
        wins: Number(wld[1]),
        losses: Number(wld[2]),
        draws: Number(wld[3]),
        deckHref: deckHref ? decodeEntities(deckHref) : null,
      });
    }
  }
  return { name, date: ldld, playerCount, format, rows };
}

/** deck page (full path with query params) → { name, quantity }[] from the embedded export payload */
async function parseDeckUrl(
  deckHref: string,
): Promise<{ name: string; quantity: number }[]> {
  const html = await get(`${SITE}${deckHref}`);
  const attr = /data-deck-export-cards-value="([^"]*)"/.exec(html)?.[1];
  if (!attr) return [];
  return JSON.parse(decodeEntities(attr)) as {
    name: string;
    quantity: number;
  }[];
}

async function main(): Promise<void> {
  const snap = JSON.parse(
    await readFile(path.join(ROOT, 'public', 'data', 'cards.min.json'), 'utf8'),
  ) as {
    cards: CardIndex[];
  };
  const eventsDir = path.join(
    ROOT,
    'scripts',
    'training',
    'data',
    'lorcanahunter',
    'events',
  );
  await mkdir(eventsDir, { recursive: true });

  // listing pages → deduped tournament targets (newest first);
  // PAGES=0 loops until a page yields nothing new (end of the archive)
  const targets: ListingTarget[] = [];
  const seenListings = new Set<number>();
  for (let p = 1; PAGES === 0 || p <= PAGES; p++) {
    const page = await listingTargets(p);
    const fresh = page.filter((t) => !seenListings.has(t.id));
    console.log(
      `listing page ${p}: ${page.length} events (${fresh.length} new)`,
    );
    if (fresh.length === 0) break;
    for (const t of fresh) seenListings.add(t.id);
    targets.push(...fresh);
    await sleep(DELAY_MS);
  }

  let done = 0;
  let scraped = 0;
  let lists = 0;
  const unmatchedNames = new Map<string, number>();
  for (const t of targets) {
    if (done >= MAX_EVENTS) break;
    done++;
    const cacheFile = path.join(eventsDir, `event-${t.id}.json`);
    if (
      await readFile(cacheFile, 'utf8').then(
        () => true,
        () => false,
      )
    ) {
      console.log(`event ${t.id}: cached, skip`);
      continue;
    }
    const slugPath = `/tournament/${t.id}/${t.slug}`;
    let detail: ReturnType<typeof parseDetail>;
    try {
      detail = parseDetail(await get(`${SITE}${slugPath}`));
    } catch (err) {
      console.warn(
        `event ${t.id}: detail fetch failed — ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    await sleep(DELAY_MS);
    if (detail.format !== 'CORE' || !detail.date) {
      console.log(`event ${t.id}: skip (${detail.format ?? 'unknown format'})`);
      continue;
    }

    const entries: LHEntry[] = [];
    for (const row of detail.rows) {
      if (!row.deckHref) continue; // no public decklist
      let cards: { name: string; quantity: number }[];
      try {
        cards = await parseDeckUrl(row.deckHref);
      } catch (err) {
        console.warn(
          `event ${t.id} player ${row.player}: deck fetch failed — ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      await sleep(DELAY_MS);
      const mapped = mapCards(
        cards.map((c) => ({ quantity: c.quantity, card: { name: c.name } })),
        snap.cards,
      );
      for (const u of mapped.unmatched)
        unmatchedNames.set(u, (unmatchedNames.get(u) ?? 0) + 1);
      const matches = row.wins + row.losses + row.draws;
      entries.push({
        player: row.player,
        standing: row.standing,
        // draws count half — the standings expose W-L-D, not game wins
        winRate: matches > 0 ? (row.wins + row.draws / 2) / matches : null,
        cards: mapped.cards,
        unmatched: mapped.unmatched,
      });
      lists++;
    }

    const tournament: LHTournament = {
      eventId: String(t.id),
      name: detail.name || t.slug,
      date: detail.date,
      playerCount: detail.playerCount,
      topCut: 0, // not exposed on the site — same limitation as the API adapter
      entries,
    };
    await writeFile(cacheFile, JSON.stringify(tournament));
    scraped++;
    console.log(
      `event ${t.id}: ${entries.length}/${detail.rows.length} lists (${detail.date})`,
    );
  }

  // rebuild the dataset from all event caches (matches the API adapter's output)
  const dataset: LHDataset = {
    source: 'lorcanahunter',
    fetchedOn: new Date().toISOString(),
    tournaments: [],
  };
  for (const f of (await readdir(eventsDir)).filter((f) =>
    f.endsWith('.json'),
  )) {
    dataset.tournaments.push(
      JSON.parse(
        await readFile(path.join(eventsDir, f), 'utf8'),
      ) as LHTournament,
    );
  }
  dataset.tournaments.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(
    path.join(ROOT, 'scripts', 'training', 'data', 'lorcanahunter.json'),
    JSON.stringify(dataset),
  );

  const topUnmatched = [...unmatchedNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log(
    `\nlorcanahunter-scrape: ${scraped} new events this run, ${lists} decklists, ` +
      `${dataset.tournaments.length} events total, ${lists || dataset.tournaments.reduce((s, t) => s + t.entries.length, 0)} lists total`,
  );
  if (topUnmatched.length)
    console.log(
      'top unmatched cards:',
      topUnmatched.map(([n, c]) => `${c}× ${n}`).join(' · '),
    );
}

// CLI entry only — importing this module must never start a crawl
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
