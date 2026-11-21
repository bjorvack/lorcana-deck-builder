/**
 * Arena deck panel (M2): real meta decks from the tournament corpus, rendered
 * arena-eligible. The panel is the seed population for arena matchup batches —
 * the A/B opponent pool the generator's synergy work will be validated
 * against.
 *
 * Usage: npx tsx scripts/training/arena/panel.ts [--size 16] [--era-days 365]
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../../src/data/types';
import { buildCanonicalRegistry } from '../canonical';
import { buildRows, type Dataset } from '../train';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';

const ARENA_DIR = import.meta.dirname;
const DATA_DIR = path.resolve(ARENA_DIR, '..', 'data');

export interface PanelDeck {
  file: string;
  signature: string;
  source: string;
  eventId: string;
  date: string;
  winRate: number;
  player: string;
  /** identity id → count */
  cards: Record<string, number>;
  inks: string[];
}

export interface PanelOptions {
  size?: number;
  /** events older than this many days before the newest event are ignored */
  eraDays?: number;
  outDir?: string;
  dataDir?: string;
}

export interface PanelResult {
  decks: PanelDeck[];
  considered: number;
  droppedReasons: Record<string, number>;
}

/** deck signature: sorted identity:count pairs — dedupes re-entries of a list */
export function deckSignature(cards: Record<string, number>): string {
  return createHash('sha256')
    .update(
      Object.entries(cards)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([id, count]) => `${id}:${count}`)
        .join(','),
    )
    .digest('hex')
    .slice(0, 16);
}

export function buildPanel(
  rows: ReturnType<typeof buildRows>['rows'],
  cards: Card[],
  opts: { size?: number; eraDays?: number } = {},
): PanelResult {
  const size = opts.size ?? 16;
  const eraDays = opts.eraDays ?? 365;
  const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
  const byId = new Map(cards.map((c) => [c.id, c]));

  // recent era only: the panel should represent the meta the generator will
  // ship against, not accumulated history
  const newest = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const cutoff = new Date(newest);
  cutoff.setUTCDate(cutoff.getUTCDate() - eraDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const era = rows.filter((r) => r.date >= cutoffIso);
  const ranked = [...era].sort(
    (a, b) => b.winRate - a.winRate || b.date.localeCompare(a.date),
  );

  const droppedReasons: Record<string, number> = {};
  const seen = new Set<string>();
  const decks: PanelDeck[] = [];
  for (const row of ranked) {
    if (decks.length >= size) break;
    const drop = (reason: string): void => {
      droppedReasons[reason] = (droppedReasons[reason] ?? 0) + 1;
    };

    // canonicalize + merge copies across prints of a card
    const identityCounts: Record<string, number> = {};
    let unmappedPrint = false;
    for (const [printId, count] of row.counts) {
      const identity = alias.get(printId);
      if (identity === undefined) {
        unmappedPrint = true;
        break;
      }
      identityCounts[String(identity)] =
        (identityCounts[String(identity)] ?? 0) + count;
    }
    if (unmappedPrint) {
      drop('unmapped-print');
      continue;
    }

    const total = Object.values(identityCounts).reduce((a, b) => a + b, 0);
    if (total !== 60) {
      drop(`card-count-${total}`);
      continue;
    }

    const inks = new Set<string>();
    let coreLegal = true;
    let copiesOk = true;
    for (const [identity, count] of Object.entries(identityCounts)) {
      const canonical = canonicalByGroup.get(
        byId.get(Number(identity))?.groupKey ?? '',
      );
      const card = byId.get(Number(identity));
      const resolved = canonical ?? card;
      if (!resolved) {
        drop('unknown-card');
        coreLegal = false;
        break;
      }
      if (!resolved.formats.core) {
        coreLegal = false;
        break;
      }
      if (
        typeof resolved.maxCopies === 'number' &&
        count > resolved.maxCopies
      ) {
        copiesOk = false;
        break;
      }
      for (const ink of resolved.inks) inks.add(ink);
    }
    if (!coreLegal) {
      drop('not-core-legal');
      continue;
    }
    if (!copiesOk) {
      drop('copy-limit');
      continue;
    }
    if (inks.size > 2) {
      drop('too-many-inks');
      continue;
    }

    const signature = deckSignature(identityCounts);
    if (seen.has(signature)) {
      drop('duplicate');
      continue;
    }
    seen.add(signature);

    decks.push({
      file: `panel-${String(decks.length + 1).padStart(2, '0')}.txt`,
      signature,
      source: row.source,
      eventId: row.eventId,
      date: row.date,
      winRate: Math.round(row.winRate * 1000) / 1000,
      player:
        row.standing === 1
          ? 'champion'
          : `standing-${row.standing ?? 'unknown'}`,
      cards: identityCounts,
      inks: [...inks].sort(),
    });
  }

  return { decks, considered: ranked.length, droppedReasons };
}

/** write the panel as plain-text decks + manifest; returns the manifest path */
export async function writePanel(
  result: PanelResult,
  cards: Card[],
  outDir = path.join(ARENA_DIR, 'panel'),
): Promise<string> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  mkdir(outDir, { recursive: true });
  for (const deck of result.decks) {
    const lines = Object.entries(deck.cards)
      .map(([identity, count]) => ({ card: byId.get(Number(identity)), count }))
      .filter((e): e is { card: Card; count: number } => e.card !== undefined)
      .sort(
        (a, b) =>
          b.count - a.count || a.card.fullName.localeCompare(b.card.fullName),
      )
      .map((e) => `${e.count}x ${e.card.fullName}`);
    await writeFile(path.join(outDir, deck.file), `${lines.join('\n')}\n`);
  }
  const manifestPath = path.join(outDir, 'panel.json');
  await writeFile(manifestPath, `${JSON.stringify(result, null, 1)}\n`);
  return manifestPath;
}

/** load the merged tournament corpus the same way train.ts does */
export async function loadCorpus(
  dataDir = DATA_DIR,
): Promise<ReturnType<typeof buildRows>['rows']> {
  if (!existsSync(dataDir)) throw new Error(`no dataset dir at ${dataDir}`);
  const files = (await readdir(dataDir))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const datasets: Dataset[] = [];
  for (const f of files) {
    datasets.push(
      JSON.parse(await readFile(path.join(dataDir, f), 'utf8')) as Dataset,
    );
  }
  return buildRows(datasets).rows;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cards = loadCards();
  const rows = await loadCorpus();
  const catalog = await loadEngineCatalog();
  const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
  const cardMap = buildCardMap({
    cards,
    alias,
    canonicalByGroup,
    engineById: catalog.byId,
    engineCommit: catalog.engineCommit,
  });

  const result = buildPanel(rows, cards, {
    size: Number(get('--size') ?? 16),
    eraDays: Number(get('--era-days') ?? 365),
  });
  // a panel deck is only useful if every identity maps into the engine
  result.decks = result.decks.filter((deck) =>
    Object.keys(deck.cards).every((identity) => cardMap.byIdentity[identity]),
  );
  const manifestPath = await writePanel(result, cards);
  console.log(
    JSON.stringify(
      {
        manifest: manifestPath,
        panel: result.decks.length,
        considered: result.considered,
        droppedReasons: result.droppedReasons,
        engineCoverage: cardMap.coverage.mapped,
      },
      null,
      1,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
