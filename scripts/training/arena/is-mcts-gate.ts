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
 * describes it. Pairs whose two seat games are both cached are never
 * re-simulated; only missing pairs play.
 *
 * Resume (AGENTS.md contract): killed runs leave their per-worker part
 * files on disk (`.parts-<pid>-<commit8>-i<iters>-g<games>-s<seedBase>/`)
 * instead of deleting them; the next invocation sweeps those directories
 * at startup, merges every parseable game into the matching per-config
 * cache (deduped by pair+seat, corrupt lines skipped) and deletes the
 * swept dirs. The directory name carries the full cache config, so parts
 * always land in their own era/flag-set cache. Parts of live processes
 * are never touched (concurrent runs keep theirs). Re-invoking with the
 * same flags then re-simulates only pairs the killed run never finished.
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
  readdirSync,
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

// ---- resume: per-config caches + orphaned-part sweep (AGENTS.md contract) ----

/** the cache/part config a gate run is keyed by (engine era + flag set) */
export interface GateRunConfig {
  commit8: string;
  iterations: number;
  games: number;
  seedBase: number;
}

export function gateCacheName(config: GateRunConfig): string {
  return `games-${config.commit8}-i${config.iterations}-g${config.games}-s${config.seedBase}.jsonl`;
}

export function gatePartsDirName(pid: number, config: GateRunConfig): string {
  return `.parts-${pid}-${config.commit8}-i${config.iterations}-g${config.games}-s${config.seedBase}`;
}

const GATE_PARTS_DIR_PATTERN =
  /^\.parts-(\d+)-([0-9a-f]{8})-i(\d+)-g(\d+)-s(\d+)$/;
const GATE_PART_FILE_PATTERN = /^gate-\d+\.jsonl$/;

/** parse one cache/part line; null when the line is not a usable game */
function parseGateGame(line: string): GateGame | null {
  try {
    const game = JSON.parse(line) as GateGame;
    if (
      typeof game.pair !== 'number' ||
      (game.seat !== 'p1' && game.seat !== 'p2') ||
      typeof game.seed !== 'string' ||
      (game.winner !== null && game.winner !== 'p1' && game.winner !== 'p2')
    ) {
      return null;
    }
    return game;
  } catch {
    return null;
  }
}

/** read every parseable game line from a cache file ([] when absent) */
export function readGateCacheLines(cachePath: string): GateGame[] {
  if (!existsSync(cachePath)) return [];
  const games: GateGame[] = [];
  for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const game = parseGateGame(line);
    if (game) games.push(game);
  }
  return games;
}

/**
 * Canonical cache order + dedupe. The two games of a pair share one seed
 * string (`<seedBase>-<pair>`), so the game identity is (pair, seat) —
 * deduping by seed alone would collapse the seat swap. Existing lines win:
 * merging never duplicates or drops cached records.
 */
export function mergeGateGames(
  existing: GateGame[],
  incoming: GateGame[],
): GateGame[] {
  const seen = new Set<string>();
  const merged: GateGame[] = [];
  for (const game of [...existing, ...incoming]) {
    const key = `${game.pair}:${game.seat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(game);
  }
  return merged.sort(
    (x, y) =>
      x.pair - y.pair || (x.seat < y.seat ? -1 : x.seat > y.seat ? 1 : 0),
  );
}

/** pairs with at least one seat not yet cached, in play order */
export function remainingPairs(cached: GateGame[], pairs: number): number[] {
  const seats = new Map<number, Set<'p1' | 'p2'>>();
  for (const game of cached) {
    let set = seats.get(game.pair);
    if (!set) {
      set = new Set();
      seats.set(game.pair, set);
    }
    set.add(game.seat);
  }
  const remaining: number[] = [];
  for (let pair = 0; pair < pairs; pair++) {
    const set = seats.get(pair);
    if (!set?.has('p1') || !set.has('p2')) remaining.push(pair);
  }
  return remaining;
}

/** ESRCH-free liveness probe: EPERM means the pid exists but is not ours */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface GateSweepResult {
  /** game records newly merged into caches */
  mergedGames: number;
  /** orphaned part directories removed */
  sweptDirs: number;
}

export interface SweepGatePartsOptions {
  /** injectable for tests; defaults to a kill(2) probe */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Merge orphaned `.parts-*` directories from killed runs into their
 * per-config JSONL caches (the directory name carries the full cache key),
 * then delete the swept directories. Directories of live processes are
 * never touched (concurrent runs keep their parts); lines that fail to
 * parse are skipped. Re-sweeping the same games is a no-op (dedupe by
 * pair+seat).
 */
export function sweepOrphanedGateParts(
  outDir: string,
  opts: SweepGatePartsOptions = {},
): GateSweepResult {
  const isProcessAlive = opts.isProcessAlive ?? processAlive;
  const result: GateSweepResult = { mergedGames: 0, sweptDirs: 0 };
  if (!existsSync(outDir)) return result;
  for (const entry of readdirSync(outDir).sort()) {
    const match = GATE_PARTS_DIR_PATTERN.exec(entry);
    if (!match) continue;
    const partDir = join(outDir, entry);
    const pid = Number(match[1]);
    if (pid === process.pid || isProcessAlive(pid)) continue;
    const config: GateRunConfig = {
      commit8: match[2]!,
      iterations: Number(match[3]),
      games: Number(match[4]),
      seedBase: Number(match[5]),
    };
    const incoming: GateGame[] = [];
    for (const file of readdirSync(partDir).sort()) {
      if (!GATE_PART_FILE_PATTERN.test(file)) continue;
      for (const line of readFileSync(join(partDir, file), 'utf8').split(
        '\n',
      )) {
        if (!line.trim()) continue;
        const game = parseGateGame(line);
        if (game) incoming.push(game);
      }
    }
    const cachePath = join(outDir, gateCacheName(config));
    const existing = readGateCacheLines(cachePath);
    const merged = mergeGateGames(existing, incoming);
    if (merged.length > existing.length) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        cachePath,
        `${merged.map((game) => JSON.stringify(game)).join('\n')}\n`,
      );
    }
    result.mergedGames += merged.length - existing.length;
    result.sweptDirs += 1;
    rmSync(partDir, { recursive: true, force: true });
  }
  return result;
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

/**
 * Play the given pairs (inline when sequential, else the rank-gate worker
 * spawn pattern) and return their games. Parts stay on disk when the spawn
 * fails or the run is killed — the next invocation's startup sweep merges
 * them (AGENTS.md: leftover parts work is never discarded).
 */
async function simulatePairs(
  pairList: number[],
  args: GateArgs,
  loaded: Loaded,
): Promise<GateGame[]> {
  const results: GateGame[] = [];
  if (pairList.length === 0) return results;
  const workers = Math.max(1, Math.min(args.parallel, pairList.length));
  if (workers === 1) {
    for (const pair of pairList) results.push(...playPair(pair, args, loaded));
    return results;
  }
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const self = fileURLToPath(import.meta.url);
  const partDir = join(
    OUT_DIR,
    gatePartsDirName(process.pid, {
      commit8: loaded.catalog.engineCommit.slice(0, 8),
      iterations: args.iterations,
      games: args.games,
      seedBase: args.seedBase,
    }),
  );
  mkdirSync(partDir, { recursive: true });
  const parts: string[] = [];
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
  for (const part of parts) {
    if (!existsSync(part)) continue;
    for (const line of readFileSync(part, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const game = parseGateGame(line);
      if (game) results.push(game);
    }
  }
  rmSync(partDir, { recursive: true, force: true });
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pairs = args.games / 2;

  // ---- worker mode: play my slice of the not-yet-cached pairs ----
  if (args.workerCount > 1 && args.part) {
    const loaded = await load();
    // the parent merged orphaned parts into the cache before spawning, so
    // the worker derives the same remaining-pair list deterministically
    const config: GateRunConfig = {
      commit8: loaded.catalog.engineCommit.slice(0, 8),
      iterations: args.iterations,
      games: args.games,
      seedBase: args.seedBase,
    };
    const cached = readGateCacheLines(join(OUT_DIR, gateCacheName(config)));
    const remaining = remainingPairs(cached, pairs);
    const lines: string[] = [];
    mkdirSync(resolve(args.part, '..'), { recursive: true });
    for (const [index, pair] of remaining.entries()) {
      if (index % args.workerCount !== args.workerIndex) continue;
      for (const game of playPair(pair, args, loaded)) {
        lines.push(JSON.stringify(game));
      }
      // flush per pair: a kill mid-slice must not lose finished pairs
      // (the parent's sweep dedupes by pair+seat, so re-merging is safe)
      writeFileSync(args.part, lines.join('\n') + (lines.length ? '\n' : ''));
    }
    return;
  }

  // ---- parent mode ----
  const loaded = await load();
  const config: GateRunConfig = {
    commit8: loaded.catalog.engineCommit.slice(0, 8),
    iterations: args.iterations,
    games: args.games,
    seedBase: args.seedBase,
  };
  const cachePath = join(OUT_DIR, gateCacheName(config));

  // resume (AGENTS.md): merge orphaned parts from killed runs into the
  // caches BEFORE the cache check, so their finished pairs replay nothing
  const sweep = sweepOrphanedGateParts(OUT_DIR);
  if (sweep.sweptDirs > 0) {
    console.error(
      `resume: merged ${sweep.mergedGames} orphaned game(s) from ` +
        `${sweep.sweptDirs} interrupted-run part dir(s)`,
    );
  }

  const cached = readGateCacheLines(cachePath).filter(
    (game) => game.pair < pairs,
  );
  const remaining = remainingPairs(cached, pairs);
  let results: GateGame[] = cached;

  if (remaining.length === 0) {
    console.error(`cache hit: ${cachePath} (${results.length} games)`);
  } else {
    const started = Date.now();
    const fresh = await simulatePairs(remaining, args, loaded);
    // merge + persist the full cache; existing lines are never duplicated
    const merged = mergeGateGames(cached, fresh);
    results = merged;
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      `${merged.map((game) => JSON.stringify(game)).join('\n')}\n`,
    );
    const seconds = (Date.now() - started) / 1000;
    console.error(
      `simulated ${fresh.length} games in ${seconds.toFixed(1)}s (${(fresh.length / seconds).toFixed(2)} games/s)`,
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
