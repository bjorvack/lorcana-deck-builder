/**
 * Arena matchup batch (M2): round-robin AI-vs-AI games over the deck panel.
 * Produces the matchup matrix the generator A/B work compares against.
 *
 * Usage: npx tsx scripts/training/arena/batch.ts [--games 8] [--parallel 4]
 *        [--decks 12] [--seed-base 1000]
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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import { type GameRecord, playGame } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;
const DATA_DIR = resolve(ARENA_DIR, '..', 'data', 'arena');
const PANEL_DIR = join(ARENA_DIR, 'panel');
// fair-information strategies on both seats: an oracle seat would make the
// matchup matrix measure information asymmetry, not deck quality
const STRATEGIES: [string, string] = [
  'best-deck-aware-lore-race',
  'best-deck-aware-lore-race',
];

interface PanelDeck {
  file: string;
  cards: Record<string, number>;
  winRate: number;
  source: string;
}

export interface MatchupRow {
  a: string;
  b: string;
  games: number;
  winsA: number;
  winsB: number;
  incomplete: number;
}

export interface MatchupMatrix {
  engineCommit: string;
  mapFormat: number;
  strategies: [string, string];
  gamesPerPair: number;
  decks: Array<{ file: string; winRate: number; source: string }>;
  matchups: MatchupRow[];
}

/** Aggregate game records into a matchup row (extracted for tests). */
export function aggregateMatchup(
  a: string,
  b: string,
  records: GameRecord[],
): MatchupRow {
  return {
    a,
    b,
    games: records.length,
    winsA: records.filter((r) => r.winner === 'p1').length,
    winsB: records.filter((r) => r.winner === 'p2').length,
    incomplete: records.filter((r) => r.incomplete).length,
  };
}

/** pair (i, j) list over n decks, deterministic order */
export function pairList(n: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  return pairs;
}

/** pair seed base: spaced so per-pair seed ranges never overlap */
export function pairSeedBase(seedBase: number, pairIndex: number): number {
  return seedBase + pairIndex * 1000;
}

function loadPanel(maxDecks: number): PanelDeck[] {
  const manifest = JSON.parse(
    readFileSync(join(PANEL_DIR, 'panel.json'), 'utf8'),
  ) as {
    decks: PanelDeck[];
  };
  return manifest.decks.slice(0, maxDecks);
}

async function playPairs(
  decks: PanelDeck[],
  opts: {
    games: number;
    seedBase: number;
    workerIndex: number;
    workerCount: number;
    trace: boolean;
  },
): Promise<GameRecord[]> {
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
  const pairs = pairList(decks.length);
  const records: GameRecord[] = [];
  for (let p = opts.workerIndex; p < pairs.length; p += opts.workerCount) {
    const [i, j] = pairs[p]!;
    const base = pairSeedBase(opts.seedBase, p);
    for (let g = 0; g < opts.games; g++) {
      records.push(
        playGame({
          catalog,
          cardMap,
          deckA: decks[i]!.cards,
          deckB: decks[j]!.cards,
          strategyA: STRATEGIES[0],
          strategyB: STRATEGIES[1],
          seed: `${base}-${g}`,
          trace: opts.trace,
        }),
      );
    }
  }
  return records;
}

interface Args {
  games: number;
  maxDecks: number;
  seedBase: number;
  parallel: number;
  workerIndex: number;
  workerCount: number;
  part: string | null;
  trace: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    games: Number(get('--games') ?? 8),
    maxDecks: Number(get('--decks') ?? 12),
    seedBase: Number(get('--seed-base') ?? 1000),
    parallel: Math.max(1, Number(get('--parallel') ?? 1)),
    workerIndex: Number(get('--worker-index') ?? 0),
    workerCount: Number(get('--worker-count') ?? 1),
    part: get('--part') ? resolve(get('--part')!) : null,
    trace: argv.includes('--trace'),
    out: get('--out') ? resolve(get('--out')!) : null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const decks = loadPanel(args.maxDecks);
  if (decks.length < 2) throw new Error('panel too small for a matchup batch');

  // worker mode: play this worker's pair slice, dump records, exit
  if (args.workerCount > 1 && args.part) {
    const records = await playPairs(decks, {
      games: args.games,
      seedBase: args.seedBase,
      workerIndex: args.workerIndex,
      workerCount: args.workerCount,
      trace: args.trace,
    });
    mkdirSync(dirname(args.part), { recursive: true });
    writeFileSync(
      args.part,
      records.map((r) => JSON.stringify(r)).join('\n') +
        (records.length ? '\n' : ''),
    );
    return;
  }

  // parent mode
  let records: GameRecord[];
  if (args.parallel === 1) {
    records = await playPairs(decks, {
      games: args.games,
      seedBase: args.seedBase,
      workerIndex: 0,
      workerCount: 1,
      trace: args.trace,
    });
  } else {
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const self = fileURLToPath(import.meta.url);
    // per-invocation dir: concurrent batches must not delete each other's parts
    const partDir = join(DATA_DIR, 'matchups', `.parts-${process.pid}`);
    mkdirSync(partDir, { recursive: true });
    const parts: string[] = [];
    try {
      await Promise.all(
        Array.from({ length: args.parallel }, (_, w) => {
          const part = join(partDir, `batch-${w}.jsonl`);
          parts.push(part);
          return execFileAsync(process.execPath, [
            tsxCli,
            self,
            '--games',
            String(args.games),
            '--decks',
            String(args.maxDecks),
            '--seed-base',
            String(args.seedBase),
            '--parallel',
            String(args.parallel),
            '--worker-index',
            String(w),
            '--worker-count',
            String(args.parallel),
            '--part',
            part,
            ...(args.trace ? ['--trace'] : []),
          ]);
        }),
      );
    } catch (error) {
      for (const part of parts) rmSync(part, { force: true });
      rmSync(partDir, { recursive: true, force: true });
      throw error;
    }
    records = [];
    for (const part of parts) {
      if (!existsSync(part)) continue;
      for (const line of readFileSync(part, 'utf8').split('\n')) {
        if (line.trim()) records.push(JSON.parse(line) as GameRecord);
      }
      rmSync(part, { force: true });
    }
    rmSync(partDir, { recursive: true, force: true });
  }

  // regroup records by pair via the seed's base prefix
  const byPair = new Map<number, GameRecord[]>();
  for (const record of records) {
    const base = Number.parseInt(record.seed.split('-')[0] ?? '', 10);
    const pairIndex = (base - args.seedBase) / 1000;
    const list = byPair.get(pairIndex) ?? [];
    list.push(record);
    byPair.set(pairIndex, list);
  }

  const catalog = await loadEngineCatalog();
  const matchups: MatchupRow[] = pairList(decks.length).map(([i, j], p) =>
    aggregateMatchup(decks[i]!.file, decks[j]!.file, byPair.get(p) ?? []),
  );

  const matrix: MatchupMatrix = {
    engineCommit: catalog.engineCommit,
    mapFormat: 2,
    strategies: STRATEGIES,
    gamesPerPair: args.games,
    decks: decks.map((d) => ({
      file: d.file,
      winRate: d.winRate,
      source: d.source,
    })),
    matchups,
  };
  const signature = createHash('sha256')
    .update(
      JSON.stringify([
        matrix.engineCommit,
        matrix.mapFormat,
        decks.length,
        args.games,
        args.seedBase,
        STRATEGIES,
      ]),
    )
    .digest('hex')
    .slice(0, 12);
  const out = join(
    DATA_DIR,
    'matchups',
    catalog.engineCommit.slice(0, 8),
    `${signature}.json`,
  );
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(matrix, null, 1)}\n`);
  if (args.trace) {
    // full game records (with move traces) alongside the matrix — the
    // ranker's training input
    writeFileSync(
      `${out}.traces.jsonl`,
      records.map((r) => JSON.stringify(r)).join('\n') +
        (records.length ? '\n' : ''),
    );
  }

  const totalGames = matchups.reduce((s, m) => s + m.games, 0);
  const incomplete = matchups.reduce((s, m) => s + m.incomplete, 0);
  console.log(
    JSON.stringify(
      {
        out,
        pairs: matchups.length,
        games: totalGames,
        incomplete,
        decks: decks.length,
      },
      null,
      1,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
