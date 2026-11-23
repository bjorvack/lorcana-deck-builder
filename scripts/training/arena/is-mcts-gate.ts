/**
 * IS-MCTS gate (self-play-league tasks 2.2 + 2.3): paired-seed games of the
 * IS-MCTS evaluator vs the shipped heuristic bot from BOTH seats.
 *
 * Usage:
 *   npx tsx scripts/training/arena/is-mcts-gate.ts --games 1000 \
 *     [--iterations 150] [--parallel 8] [--seeds 500] [--seed-base 1]
 *
 * Pairing: seed pair p uses seed `<seedBase>-<p>` for two mirrored games —
 * game 2p plays IS-MCTS as p1 on panel decks (i, j), game 2p+1 plays IS-MCTS
 * as p2 on the same seed with the deck order swapped. Both games of a pair
 * therefore share identical shuffles across the seat swap.
 *
 * Parallelism follows the rank-gate.ts pattern: the parent spawns `tsx`
 * child processes with --worker-index/--worker-count/--part, then merges
 * the part files and deletes them.
 *
 * Caching: a dedicated JSONL under scripts/training/data/arena/is-mcts/
 * (games-<commit8>-i<iterations>-g<games>-s<seedBase>.jsonl) instead of the
 * run.ts cache: the run.ts key covers ONE deck pair + ONE strategy pair +
 * one seed base, while a gate spans many panel pairs with seat-swapped
 * strategy pairs and per-pair seeds — there is no single run.ts key that
 * describes it. If the JSONL already holds >= games results, simulation is
 * skipped; otherwise it is replayed in full (no partial merges).
 *
 * Verdict (task 2.3): PASS iff the bootstrap 95% win-rate CI lower bound is
 * above 0.5 (Wilson CI from ab.ts reported alongside). PASS → the evaluator
 * may referee league games; FAIL → the heuristic bot remains referee and the
 * verdict is recorded for ROADMAP.md. Exit code 1 on FAIL.
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
import { createRecordCardCatalog } from '@tcg/shared/cards/catalog';
import { buildCanonicalRegistry } from '../canonical';
import { mulberry32 } from '../prng';
import { proportionStats } from './ab';
import { buildCardMap, type CardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import { hashSeed, isMctsStrategy, type SimCardsMaps } from './is-mcts';
import { deterministicCardsMaps, playGame, strategyById } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;
const OUT_DIR = resolve(ARENA_DIR, '..', 'data', 'arena', 'is-mcts');
const REFEREE_ID = 'best-deck-aware-lore-race';

interface GateArgs {
  games: number;
  iterations: number;
  parallel: number;
  seedBase: number;
  workerIndex: number;
  workerCount: number;
  part: string | null;
}

function parseArgs(argv: string[]): GateArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // --seeds counts seed PAIRS (2 games each); --games counts games directly
  const gamesFlag = get('--games');
  const seedsFlag = get('--seeds');
  const games = gamesFlag
    ? Math.max(2, 2 * Math.ceil(Number(gamesFlag) / 2))
    : seedsFlag
      ? Math.max(1, Number(seedsFlag)) * 2
      : 1_000;
  return {
    games,
    iterations: Math.max(1, Number(get('--iterations') ?? 150)),
    parallel: Math.max(1, Number(get('--parallel') ?? 8)),
    seedBase: Number(get('--seed-base') ?? 1),
    workerIndex: Number(get('--worker-index') ?? 0),
    workerCount: Number(get('--worker-count') ?? 1),
    part: get('--part') ? resolve(get('--part')!) : null,
  };
}

/** one game outcome from the IS-MCTS perspective */
export interface GateGame {
  pair: number;
  seat: 'p1' | 'p2';
  winner: string | null;
  seed: string;
}

export interface GateVerdict {
  games: number;
  pairs: number;
  seedBase: number;
  iterations: number;
  engineCommit: string;
  seats: {
    p1: { games: number; wins: number };
    p2: { games: number; wins: number };
  };
  wins: number;
  winRate: number;
  /** primary gate statistic: bootstrap 95% CI on the win rate */
  ci: { method: string; low: number; high: number };
  /** cross-check: Wilson score interval (ab.ts proportionStats) */
  wilson: { low: number; high: number };
  verdict: 'PASS' | 'FAIL';
  /** the referee after this verdict (heuristic bot unless the gate passes) */
  referee: string;
  timestamp: string;
}

/**
 * Seeded bootstrap percentile CI on a mean (10,000 resamples by default).
 * Deterministic for a fixed seed — no Math.random in training paths.
 */
export function bootstrapCi(
  samples: number[],
  opts: { resamples?: number; seed?: number } = {},
): { low: number; high: number } {
  if (samples.length === 0) return { low: 0, high: 0 };
  const resamples = opts.resamples ?? 10_000;
  const rng = mulberry32(opts.seed ?? hashSeed(`bootstrap:${samples.length}`));
  const games = samples.length;
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < games; i++) sum += samples[Math.floor(rng() * games)]!;
    means.push(sum / games);
  }
  means.sort((a, b) => a - b);
  return {
    low: means[Math.floor(0.025 * resamples)]!,
    high: means[Math.ceil(0.975 * resamples) - 1]!,
  };
}

/**
 * Gate verdict (task 2.3): PASS iff the bootstrap 95% CI lower bound of the
 * evaluator's win rate is above 0.5. On FAIL the heuristic bot remains the
 * league referee.
 */
export function evaluateGate(
  games: GateGame[],
  config: {
    iterations: number;
    seedBase: number;
    engineCommit: string;
    bootstrapResamples?: number;
    bootstrapSeed?: number;
    timestamp?: string;
  },
): GateVerdict {
  const winsOf = (seat: 'p1' | 'p2'): number =>
    games.filter((game) => game.seat === seat && game.winner === seat).length;
  const wins = games.filter((game) => game.winner === game.seat).length;
  const samples = games.map((game) => (game.winner === game.seat ? 1 : 0));
  const ci = bootstrapCi(samples, {
    resamples: config.bootstrapResamples,
    seed: config.bootstrapSeed,
  });
  const wilson = proportionStats(wins, games.length);
  const pass = ci.low > 0.5;
  return {
    games: games.length,
    pairs: games.length / 2,
    seedBase: config.seedBase,
    iterations: config.iterations,
    engineCommit: config.engineCommit,
    seats: {
      p1: {
        games: games.filter((g) => g.seat === 'p1').length,
        wins: winsOf('p1'),
      },
      p2: {
        games: games.filter((g) => g.seat === 'p2').length,
        wins: winsOf('p2'),
      },
    },
    wins,
    winRate: wilson.winRate,
    ci: {
      method: `bootstrap-${config.bootstrapResamples ?? 10_000}`,
      low: Math.round(ci.low * 1000) / 1000,
      high: Math.round(ci.high * 1000) / 1000,
    },
    wilson: { low: wilson.ciLow, high: wilson.ciHigh },
    verdict: pass ? 'PASS' : 'FAIL',
    referee: pass ? 'is-mcts' : REFEREE_ID,
    timestamp: config.timestamp ?? new Date().toISOString(),
  };
}

/** deterministic panel pairing per seed pair (rank-gate's formula, no seat parity) */
export function pairSetup(
  pair: number,
  panelCount: number,
): { a: number; b: number } {
  const i = pair % panelCount;
  let j = (pair + 3) % panelCount;
  if (j === i) j = (j + 1) % panelCount;
  return { a: i, b: j };
}

/** identity counts → engine card counts (play.ts's toEngine, locally) */
function toEngineDeck(
  cards: Record<string, number>,
  cardMap: CardMap,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(cards).map(([identity, count]) => {
      const entry = cardMap.byIdentity[identity];
      if (!entry) throw new Error(`identity ${identity} has no engine mapping`);
      return [entry.engineId, count];
    }),
  );
}

interface Loaded {
  catalog: Awaited<ReturnType<typeof loadEngineCatalog>>;
  cardCatalog: unknown;
  cardMap: CardMap;
  panel: Array<{ cards: Record<string, number> }>;
  base: Parameters<typeof isMctsStrategy>[0];
}

async function load(): Promise<Loaded> {
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
    ) as { decks: Array<{ cards: Record<string, number> }> }
  ).decks;
  if (panel.length < 2)
    throw new Error('panel missing — run arena:panel first');
  return {
    catalog,
    cardCatalog: createRecordCardCatalog('lorcana:cards', catalog.byId),
    cardMap,
    panel,
    // the shim's strategy type returns `unknown` summaries; is-mcts consumes
    // them structurally (same cast pattern rank-gate.ts uses)
    base: strategyById(REFEREE_ID) as unknown as Loaded['base'],
  };
}

/** play one pair (two mirrored games) and return both outcomes */
function playPair(pair: number, args: GateArgs, loaded: Loaded): GateGame[] {
  const { catalog, cardCatalog, cardMap, panel, base } = loaded;
  const { a, b } = pairSetup(pair, panel.length);
  const seed = `${args.seedBase}-${pair}`;
  const out: GateGame[] = [];
  for (const mirror of [0, 1] as const) {
    const seat = mirror === 0 ? 'p1' : 'p2';
    const deckA = mirror === 0 ? panel[a]!.cards : panel[b]!.cards;
    const deckB = mirror === 0 ? panel[b]!.cards : panel[a]!.cards;
    // the evaluator's simulator needs the same deterministic cardsMaps the
    // engine will build (identical inputs → identical re-keyed instances)
    const cardsMaps: SimCardsMaps = deterministicCardsMaps(
      [
        { owner: 'p1', cards: toEngineDeck(deckA, cardMap) },
        { owner: 'p2', cards: toEngineDeck(deckB, cardMap) },
      ],
      catalog.byId,
    ) as unknown as SimCardsMaps;
    const evaluator = isMctsStrategy(base, {
      seed,
      iterations: args.iterations,
      cardsMaps,
      cardCatalog,
    });
    const record = playGame({
      catalog,
      cardMap,
      deckA,
      deckB,
      strategyA: seat === 'p1' ? evaluator : REFEREE_ID,
      strategyB: seat === 'p2' ? evaluator : REFEREE_ID,
      seed,
    });
    out.push({ pair, seat, winner: record.winner, seed });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pairs = args.games / 2;

  // ---- worker mode: play my pair slice, write JSONL part ----
  if (args.workerCount > 1 && args.part) {
    const loaded = await load();
    const lines: string[] = [];
    for (let pair = args.workerIndex; pair < pairs; pair += args.workerCount) {
      for (const game of playPair(pair, args, loaded)) {
        lines.push(JSON.stringify(game));
      }
    }
    mkdirSync(resolve(args.part, '..'), { recursive: true });
    writeFileSync(args.part, lines.join('\n') + (lines.length ? '\n' : ''));
    return;
  }

  // ---- parent mode ----
  const loaded = await load();
  const cachePath = join(
    OUT_DIR,
    `games-${loaded.catalog.engineCommit.slice(0, 8)}-i${args.iterations}-g${args.games}-s${args.seedBase}.jsonl`,
  );

  let results: GateGame[] = [];
  if (existsSync(cachePath)) {
    const lines = readFileSync(cachePath, 'utf8').split('\n').filter(Boolean);
    if (lines.length >= args.games) {
      results = lines
        .slice(0, args.games)
        .map((line) => JSON.parse(line) as GateGame);
      console.error(`cache hit: ${cachePath} (${results.length} games)`);
    }
  }

  if (results.length === 0) {
    const started = Date.now();
    const workers = Math.max(1, Math.min(args.parallel, pairs));
    if (workers === 1) {
      for (let pair = 0; pair < pairs; pair++) {
        results.push(...playPair(pair, args, loaded));
      }
    } else {
      const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
      const self = fileURLToPath(import.meta.url);
      const partDir = join(OUT_DIR, `.parts-${process.pid}`);
      mkdirSync(partDir, { recursive: true });
      const parts: string[] = [];
      try {
        await Promise.all(
          Array.from({ length: workers }, (_, w) => {
            const part = join(partDir, `gate-${w}.jsonl`);
            parts.push(part);
            return execFileAsync(process.execPath, [
              tsxCli,
              self,
              '--games',
              String(args.games),
              '--iterations',
              String(args.iterations),
              '--parallel',
              String(workers),
              '--seed-base',
              String(args.seedBase),
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
          if (line.trim()) results.push(JSON.parse(line) as GateGame);
        }
        rmSync(part, { force: true });
      }
      rmSync(partDir, { recursive: true, force: true });
    }
    results.sort((x, y) => x.pair - y.pair || (x.seat < y.seat ? -1 : 1));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      `${results.map((game) => JSON.stringify(game)).join('\n')}\n`,
    );
    const seconds = (Date.now() - started) / 1000;
    console.error(
      `simulated ${results.length} games in ${seconds.toFixed(1)}s (${(results.length / seconds).toFixed(2)} games/s)`,
    );
  }

  const verdict = evaluateGate(results, {
    iterations: args.iterations,
    seedBase: args.seedBase,
    engineCommit: loaded.catalog.engineCommit,
  });
  const verdictPath = join(OUT_DIR, `verdict-i${args.iterations}.json`);
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 1)}\n`);
  console.log(JSON.stringify(verdict, null, 1));
  console.error(
    `gate: is-mcts(i${args.iterations}) ${verdict.winRate} vs ${REFEREE_ID} ` +
      `(bootstrap CI [${verdict.ci.low}, ${verdict.ci.high}], wilson [${verdict.wilson.low}, ${verdict.wilson.high}]) → ${verdict.verdict}`,
  );
  console.error(`verdict written: ${verdictPath}`);
  if (verdict.verdict === 'FAIL') process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
