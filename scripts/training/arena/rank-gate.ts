/**
 * M4 gate: learned ranker vs the shipped bot, head-to-head over the panel.
 *
 * Usage:
 *   npx tsx scripts/training/arena/rank-gate.ts --weights <ranker.json> \
 *     [--games 128] [--parallel 8]
 *
 * Work splits by game index across child processes (seeded panel matchups,
 * seat-balanced by parity). PASS = the learned strategy's win-rate CI low
 * > 0.5 (statistically better than the shipped bot).
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildCanonicalRegistry } from '../canonical';
import { proportionStats } from './ab';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import {
  type LearnedStrategyWeights,
  learnedStrategy,
} from './learned-strategy';
import { playGame, strategyById } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;

interface GateArgs {
  weights: string | null;
  games: number;
  parallel: number;
  workerIndex: number;
  workerCount: number;
  part: string | null;
}

function parseArgs(argv: string[]): GateArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    weights: get('--weights') ? resolve(get('--weights')!) : null,
    games: Number(get('--games') ?? 128),
    parallel: Math.max(1, Number(get('--parallel') ?? 8)),
    workerIndex: Number(get('--worker-index') ?? 0),
    workerCount: Number(get('--worker-count') ?? 1),
    part: get('--part') ? resolve(get('--part')!) : null,
  };
}

export function headToHeadTally(
  wins: Array<{ seat: 'p1' | 'p2'; winner: string | null }>,
): { games: number; tunedWins: number } {
  return {
    games: wins.length,
    tunedWins: wins.filter((g) => g.winner === g.seat).length,
  };
}

/** game g's deck pair + seat: deterministic, balanced across the panel */
function gameSetup(
  g: number,
  panelCount: number,
): {
  a: number;
  b: number;
  tunedSeat: 'p1' | 'p2';
} {
  const even = g % 2 === 0;
  const i = g % panelCount;
  let j = (g + 3) % panelCount;
  if (j === i) j = (j + 1) % panelCount;
  return { a: even ? i : j, b: even ? j : i, tunedSeat: even ? 'p1' : 'p2' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.weights || !existsSync(args.weights))
    throw new Error('--weights <ranker.json> is required');
  const learned = JSON.parse(
    readFileSync(args.weights, 'utf8'),
  ) as LearnedStrategyWeights;

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
  const panel = (
    JSON.parse(
      readFileSync(join(ARENA_DIR, 'panel', 'panel.json'), 'utf8'),
    ) as {
      decks: Array<{ cards: Record<string, number> }>;
    }
  ).decks;
  const shipped = strategyById(
    'best-deck-aware-lore-race',
  ) as unknown as Parameters<typeof learnedStrategy>[0];
  const tuned = learnedStrategy(shipped, learned) as unknown as typeof shipped;

  const results: Array<{ seat: 'p1' | 'p2'; winner: string | null }> = [];
  if (args.workerCount > 1 && args.part) {
    // worker mode: play my game slice, write {seat, winner} lines
    for (let g = args.workerIndex; g < args.games; g += args.workerCount) {
      const { a, b, tunedSeat } = gameSetup(g, panel.length);
      const record = playGame({
        catalog,
        cardMap,
        deckA: panel[a]!.cards,
        deckB: panel[b]!.cards,
        strategyA: tunedSeat === 'p1' ? tuned : shipped,
        strategyB: tunedSeat === 'p1' ? shipped : tuned,
        seed: `rg-${g}`,
      });
      results.push({ seat: tunedSeat, winner: record.winner });
    }
    writeFileSync(
      args.part,
      results.map((r) => JSON.stringify(r)).join('\n') +
        (results.length ? '\n' : ''),
    );
    return;
  }

  // parent mode
  const workers = Math.max(1, Math.min(args.parallel, args.games));
  if (workers === 1) {
    for (let g = 0; g < args.games; g++) {
      const { a, b, tunedSeat } = gameSetup(g, panel.length);
      const record = playGame({
        catalog,
        cardMap,
        deckA: panel[a]!.cards,
        deckB: panel[b]!.cards,
        strategyA: tunedSeat === 'p1' ? tuned : shipped,
        strategyB: tunedSeat === 'p1' ? shipped : tuned,
        seed: `rg-${g}`,
      });
      results.push({ seat: tunedSeat, winner: record.winner });
    }
  } else {
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const self = fileURLToPath(import.meta.url);
    const partDir = join(ARENA_DIR, '.gate-parts', String(process.pid));
    mkdirSync(partDir, { recursive: true });
    const parts: string[] = [];
    try {
      await Promise.all(
        Array.from({ length: workers }, (_, w) => {
          const part = join(partDir, `gate-${w}.json`);
          parts.push(part);
          return execFileAsync(process.execPath, [
            tsxCli,
            self,
            '--weights',
            args.weights!,
            '--games',
            String(args.games),
            '--parallel',
            String(workers),
            '--worker-index',
            String(w),
            '--worker-count',
            String(workers),
            '--part',
            part,
          ]);
        }),
      );
    } catch (error) {
      for (const part of parts) rmSync(part, { force: true });
      rmSync(partDir, { recursive: true, force: true });
      throw error;
    }
    for (const part of parts) {
      if (!existsSync(part)) continue;
      for (const line of readFileSync(part, 'utf8').split('\n')) {
        if (line.trim())
          results.push(
            JSON.parse(line) as { seat: 'p1' | 'p2'; winner: string | null },
          );
      }
      rmSync(part, { force: true });
    }
    rmSync(partDir, { recursive: true, force: true });
  }

  const tally = headToHeadTally(results);
  const stats = proportionStats(tally.tunedWins, tally.games);
  const pass = stats.ciLow > 0.5;
  console.log(
    JSON.stringify(
      {
        games: tally.games,
        tunedWins: tally.tunedWins,
        winRate: stats.winRate,
        ciLow: stats.ciLow,
        ciHigh: stats.ciHigh,
        pass,
      },
      null,
      1,
    ),
  );
  console.error(
    `gate: learned ${stats.winRate} vs shipped (CI [${stats.ciLow}, ${stats.ciHigh}]) → ${pass ? 'PASS' : 'FAIL'}`,
  );
  if (!pass) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
