/**
 * Arena batch runner: play N seeded AI-vs-AI games between two decks.
 *
 * Usage:
 *   npx tsx scripts/training/arena/run.ts \
 *     --deck scripts/training/arena/fixtures/deck-a.txt \
 *     --opponent scripts/training/arena/fixtures/deck-b.txt \
 *     --games 20 [--seed-base 1] [--strategies deck-aware-lore-race,best-deck-aware-lore-race] \
 *     [--parallel 4] [--out <path>]
 *
 * Records cache under scripts/training/data/arena/<engineCommit>/… keyed by
 * (deck pair, strategy pair, seed base, game count). A changed engine commit
 * never reads older eras. Records are deterministic per seed: same inputs →
 * byte-identical lines.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Card } from '../../../src/data/types';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap, type CardMap } from './card-map';
import { loadCards } from './cards';
import { deckProblems, ineligibleIdentities, prepareDeck } from './deck-io';
import { type EngineCatalog, loadEngineCatalog } from './engine-cards';
import { type GameRecord, playGame, strategyById } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DATA = resolve(import.meta.dirname, '..', 'data', 'arena');
const FORMAT_VERSION = 'arena-1';

interface Args {
  deck: string;
  opponent: string;
  games: number;
  seedBase: number;
  strategies: [string, string];
  parallel: number;
  out: string | null;
  workerIndex: number;
  workerCount: number;
  part: string | null;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const strategies = (
    get('--strategies') ?? 'deck-aware-lore-race,best-deck-aware-lore-race'
  ).split(',');
  const args: Args = {
    deck: resolve(get('--deck') ?? ''),
    opponent: resolve(get('--opponent') ?? get('--deck') ?? ''),
    games: Number(get('--games') ?? 20),
    seedBase: Number(get('--seed-base') ?? 1),
    strategies: [strategies[0]!, strategies[1] ?? strategies[0]!],
    parallel: Number(get('--parallel') ?? 1),
    out: get('--out') ? resolve(get('--out')!) : null,
    workerIndex: Number(get('--worker-index') ?? 0),
    workerCount: Number(get('--worker-count') ?? 1),
    part: get('--part') ? resolve(get('--part')!) : null,
    quiet: argv.includes('--quiet'),
  };
  if (!args.deck) throw new Error('--deck <file> is required');
  strategyById(args.strategies[0]!);
  strategyById(args.strategies[1]!);
  return args;
}

interface Prepared {
  cards: Card[];
  catalog: EngineCatalog;
  cardMap: CardMap;
  deckA: { cards: Record<string, number>; title: string };
  deckB: { cards: Record<string, number>; title: string };
}

async function prepare(args: Args): Promise<Prepared> {
  const cards = loadCards();
  const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
  const catalog = await loadEngineCatalog();
  const cardMap = buildCardMap({
    cards,
    alias,
    canonicalByGroup,
    engineById: catalog.byId,
    engineCommit: catalog.engineCommit,
  });
  const deckA = prepareDeck(args.deck, cards, alias);
  const deckB = prepareDeck(args.opponent, cards, alias);
  for (const [label, path, deck] of [
    ['deck A', args.deck, deckA],
    ['deck B', args.opponent, deckB],
  ] as const) {
    const problems = deckProblems(deck, cardMap, cards);
    if (problems.length > 0)
      throw new Error(
        `${label} (${path}) is not arena-legal:\n  ${problems.map((p) => `${p.kind}: ${p.detail}`).join('\n  ')}`,
      );
    const missing = ineligibleIdentities(deck, cardMap, cards);
    if (missing.length > 0)
      throw new Error(
        `${label} (${path}) contains cards the engine cannot play — bump the vendor to include them:\n  ` +
          missing.map((m) => `${m.name} [${m.reason}]`).join('\n  '),
      );
  }
  return { cards, catalog, cardMap, deckA, deckB };
}

export function cachePathFor(input: {
  engineCommit: string;
  mapFormat: number;
  deckA: Record<string, number>;
  deckB: Record<string, number>;
  strategies: [string, string];
  seedBase: number;
  games: number;
}): string {
  const hash = (value: unknown): string =>
    createHash('sha256')
      .update(JSON.stringify(value))
      .digest('hex')
      .slice(0, 12);
  // mapFormat keys the pair hash: a remapped identity must never silently
  // reuse records played under the previous resolution
  const pairHash = hash([input.deckA, input.deckB, input.mapFormat]);
  return join(
    ARENA_DATA,
    input.engineCommit.slice(0, 8),
    pairHash,
    `${input.strategies[0]}__${input.strategies[1]}`,
    `${FORMAT_VERSION}-${input.seedBase}-${input.games}.jsonl`,
  );
}

function seedFor(args: Args, game: number): string {
  // game index alone determines the seed, independent of --parallel layout
  return `${args.seedBase}-${game}`;
}

async function runSlice(
  args: Args,
  workerIndex: number,
  workerCount: number,
): Promise<GameRecord[]> {
  const prepared = await prepare(args);
  const records: GameRecord[] = [];
  for (let game = workerIndex; game < args.games; game += workerCount) {
    records.push(
      playGame({
        catalog: prepared.catalog,
        cardMap: prepared.cardMap,
        deckA: prepared.deckA.cards,
        deckB: prepared.deckB.cards,
        strategyA: args.strategies[0]!,
        strategyB: args.strategies[1]!,
        seed: seedFor(args, game),
      }),
    );
  }
  if (!args.quiet) {
    const wins = records.filter((r) => r.winner === 'p1').length;
    const incomplete = records.filter((r) => r.incomplete).length;
    console.error(
      `worker ${workerIndex}: ${records.length} games — deckA wins ${wins}, incomplete ${incomplete}`,
    );
  }
  return records;
}

function writePart(records: GameRecord[], part: string): string {
  mkdirSync(dirname(part), { recursive: true });
  writeFileSync(
    part,
    records.map((r) => JSON.stringify(r)).join('\n') +
      (records.length ? '\n' : ''),
  );
  return part;
}

async function runWorker(args: Args): Promise<void> {
  const records = await runSlice(args, args.workerIndex, args.workerCount);
  records.sort((a, b) => (a.seed < b.seed ? -1 : 1));
  writePart(records, args.part ?? `part-${args.workerIndex}.jsonl`);
}

function cleanup(parts: string[]): void {
  for (const part of parts) rmSync(part, { force: true });
}

async function runParent(args: Args): Promise<void> {
  const prepared = await prepare(args);
  const out =
    args.out ??
    cachePathFor({
      engineCommit: prepared.catalog.engineCommit,
      mapFormat: prepared.cardMap.format,
      deckA: prepared.deckA.cards,
      deckB: prepared.deckB.cards,
      strategies: args.strategies,
      seedBase: args.seedBase,
      games: args.games,
    });
  if (existsSync(out)) {
    const lines = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length >= args.games) {
      if (!args.quiet)
        console.error(`cache hit: ${out} (${lines.length} records)`);
      return;
    }
  }

  const workers = Math.max(1, Math.min(args.parallel, args.games));
  const parts: string[] = [];
  try {
    if (workers === 1) {
      const records = await runSlice(args, 0, 1);
      records.sort((a, b) => (a.seed < b.seed ? -1 : 1));
      parts.push(writePart(records, join(dirname(out), '.part-0')));
    } else {
      const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
      const base = [
        resolve(import.meta.dirname, 'run.ts'),
        '--deck',
        args.deck,
        '--opponent',
        args.opponent,
        '--games',
        String(args.games),
        '--seed-base',
        String(args.seedBase),
        '--strategies',
        args.strategies.join(','),
        '--worker-count',
        String(workers),
        '--quiet',
      ];
      await Promise.all(
        Array.from({ length: workers }, (_, i) => {
          const part = join(dirname(out), `.part-${i}`);
          parts.push(part);
          return execFileAsync(process.execPath, [
            tsxCli,
            ...base,
            '--worker-index',
            String(i),
            '--part',
            part,
          ]);
        }),
      );
    }
  } catch (error) {
    cleanup(parts);
    throw error;
  }

  const all: GameRecord[] = [];
  for (const part of parts) {
    if (!existsSync(part)) continue;
    for (const line of readFileSync(part, 'utf8').split('\n')) {
      if (line.trim()) all.push(JSON.parse(line) as GameRecord);
    }
  }
  all.sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0));
  const trimmed = all.slice(0, args.games);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    trimmed.map((r) => JSON.stringify(r)).join('\n') +
      (trimmed.length ? '\n' : ''),
  );
  cleanup(parts);

  const winsA = trimmed.filter((r) => r.winner === 'p1').length;
  const winsB = trimmed.filter((r) => r.winner === 'p2').length;
  const incomplete = trimmed.filter((r) => r.incomplete).length;
  console.log(
    JSON.stringify(
      { out, games: trimmed.length, winsA, winsB, incomplete },
      null,
      1,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2));
  await (args.workerCount > 1 && args.part ? runWorker(args) : runParent(args));
}
