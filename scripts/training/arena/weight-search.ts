/**
 * M3 stage A: hill-climb a tunable strategy's genome against the shipped
 * bot over the deck panel.
 *
 * Usage:
 *   npx tsx scripts/training/arena/weight-search.ts \
 *     [--iterations 8] [--mutants 6] [--games-per-eval 24] \
 *     [--gate-games 128] [--parallel 6] [--sigma 0.25] [--seed 20261120]
 *
 * Fitness: win rate of the genome strategy vs the shipped
 * best-deck-aware-lore-race bot over the panel (seeded pairs, seat-balanced).
 * Mutant evaluations run as parallel child processes (one mutant per child,
 * seed-split games inside). The final gate replays the best genome vs shipped
 * on a fresh seed range; PASS = CI low > 0.5. Results land in
 * scripts/training/data/arena/weight-search/.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildCanonicalRegistry } from '../canonical';
import { mulberry32 } from '../prng';
import { proportionStats } from './ab';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import { playGame, strategyById } from './play';
import {
  genomeToVector,
  NEUTRAL_GENOME,
  tunableStrategy,
  vectorToGenome,
} from './tunable-strategy';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;
const OUT_DIR = resolve(ARENA_DIR, '..', 'data', 'arena', 'weight-search');

interface Args {
  iterations: number;
  mutants: number;
  gamesPerEval: number;
  gateGames: number;
  parallel: number;
  sigma: number;
  seed: number;
  evalGenomePath: string | null;
  part: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    iterations: Number(get('--iterations') ?? 8),
    mutants: Number(get('--mutants') ?? 6),
    gamesPerEval: Number(get('--games-per-eval') ?? 24),
    gateGames: Number(get('--gate-games') ?? 128),
    parallel: Math.max(1, Number(get('--parallel') ?? 6)),
    sigma: Number(get('--sigma') ?? 0.25),
    seed: Number(get('--seed') ?? 20261120),
    evalGenomePath: get('--eval-genome')
      ? resolve(get('--eval-genome')!)
      : null,
    part: get('--part') ? resolve(get('--part')!) : null,
  };
}

/** gaussian mutation via Box–Muller on the seeded PRNG */
export function mutate(
  genome: number[],
  rng: () => number,
  sigma: number,
): number[] {
  const gaussian = (): number => {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return genome.map((g) => g + gaussian() * sigma);
}

interface PlayContext {
  cardMap: ReturnType<typeof buildCardMap>;
  catalog: Awaited<ReturnType<typeof loadEngineCatalog>>;
  panel: Array<Record<string, number>>;
  baselineStrategy: ReturnType<typeof strategyById>;
}

async function buildContext(): Promise<PlayContext> {
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
  const manifest = JSON.parse(
    readFileSync(join(ARENA_DIR, 'panel', 'panel.json'), 'utf8'),
  ) as { decks: Array<{ cards: Record<string, number> }> };
  return {
    cardMap,
    catalog,
    panel: manifest.decks.map((d) => d.cards),
    baselineStrategy: strategyById(
      'best-deck-aware-lore-race',
    ) as unknown as PlayContext['baselineStrategy'],
  };
}

/**
 * One fitness evaluation: the genome strategy vs the shipped bot over
 * `games` seeded panel matchups (seat-balanced by parity). Deterministic per
 * (genome, seedBase).
 */
export function evaluateGenome(
  ctx: PlayContext,
  genome: number[],
  games: number,
  seedBase: number,
): { wins: number; games: number } {
  const strategy = tunableStrategy(
    ctx.baselineStrategy as unknown as Parameters<typeof tunableStrategy>[0],
    vectorToGenome(genome),
  ) as unknown as ReturnType<typeof strategyById>;
  const rng = mulberry32(seedBase);
  let wins = 0;
  for (let g = 0; g < games; g++) {
    const i = Math.floor(rng() * ctx.panel.length);
    let j = Math.floor(rng() * (ctx.panel.length - 1));
    if (j >= i) j += 1;
    const even = g % 2 === 0;
    const record = playGame({
      catalog: ctx.catalog,
      cardMap: ctx.cardMap,
      deckA: even ? ctx.panel[i]! : ctx.panel[j]!,
      deckB: even ? ctx.panel[j]! : ctx.panel[i]!,
      strategyA: (even ? strategy : ctx.baselineStrategy) as never,
      strategyB: (even ? ctx.baselineStrategy : strategy) as never,
      seed: `ws-${seedBase}-${g}`,
    });
    wins += record.winner === (even ? 'p1' : 'p2') ? 1 : 0;
  }
  return { wins, games };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ---- eval mode (child): score one genome, write the tally, exit ----
  if (args.evalGenomePath && args.part) {
    const genome = JSON.parse(
      readFileSync(args.evalGenomePath, 'utf8'),
    ) as number[];
    const ctx = await buildContext();
    const fitness = evaluateGenome(ctx, genome, args.gamesPerEval, args.seed);
    mkdirSync(dirname(args.part), { recursive: true });
    writeFileSync(args.part, `${JSON.stringify(fitness)}\n`);
    return;
  }

  const ctx = await buildContext();
  if (ctx.panel.length < 2)
    throw new Error('panel missing — run arena:panel first');

  const incumbent = genomeToVector(NEUTRAL_GENOME);
  const incumbentFitness = evaluateGenome(
    ctx,
    incumbent,
    args.gamesPerEval,
    args.seed,
  );
  console.error(
    `incumbent (shipped ordering): ${incumbentFitness.wins}/${incumbentFitness.games}`,
  );

  let best: { genome: number[]; wins: number; games: number } = {
    genome: incumbent,
    ...incumbentFitness,
  };
  const history: Array<{ iteration: number; bestWins: number; games: number }> =
    [];

  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const self = fileURLToPath(import.meta.url);
  const searchRng = mulberry32(args.seed + 1);

  for (let iteration = 1; iteration <= args.iterations; iteration++) {
    const mutantGenomes = Array.from({ length: args.mutants }, () =>
      mutate(best.genome, searchRng, args.sigma),
    );
    const fitnessResults = await Promise.all(
      mutantGenomes.map(async (genome, m) => {
        const seedBase = args.seed + iteration * 1000 + m;
        if (args.parallel === 1) {
          return {
            genome,
            ...evaluateGenome(ctx, genome, args.gamesPerEval, seedBase),
          };
        }
        const genomePath = join(OUT_DIR, `.genome-${iteration}-${m}.json`);
        const part = join(OUT_DIR, `.fit-${iteration}-${m}.json`);
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(genomePath, JSON.stringify(genome));
        try {
          await execFileAsync(process.execPath, [
            tsxCli,
            self,
            '--eval-genome',
            genomePath,
            '--games-per-eval',
            String(args.gamesPerEval),
            '--seed',
            String(seedBase),
            '--part',
            part,
          ]);
          return {
            genome,
            ...(JSON.parse(readFileSync(part, 'utf8')) as {
              wins: number;
              games: number;
            }),
          };
        } finally {
          rmSync(part, { force: true });
          rmSync(genomePath, { force: true });
        }
      }),
    );
    for (const result of fitnessResults) {
      if (result.wins > best.wins)
        best = {
          genome: result.genome,
          wins: result.wins,
          games: result.games,
        };
    }
    history.push({ iteration, bestWins: best.wins, games: best.games });
    console.error(
      `iteration ${iteration}: best ${best.wins}/${best.games} (${(best.wins / Math.max(1, best.games)).toFixed(3)})`,
    );
  }

  // ---- fresh-seed head-to-head gate: best genome vs shipped ----
  let tunedWins = 0;
  for (let g = 0; g < args.gateGames; g++) {
    tunedWins += evaluateGenome(
      ctx,
      best.genome,
      1,
      args.seed + 100000 + g,
    ).wins;
  }
  const gateStats = proportionStats(tunedWins, args.gateGames);
  const pass = gateStats.ciLow > 0.5; // must be statistically better than shipped

  const result = {
    seed: args.seed,
    iterations: args.iterations,
    mutants: args.mutants,
    gamesPerEval: args.gamesPerEval,
    bestGenome: vectorToGenome(best.genome),
    bestGenomeVector: best.genome,
    fitnessHistory: history,
    gate: {
      games: args.gateGames,
      tunedWins,
      winRate: gateStats.winRate,
      ciLow: gateStats.ciLow,
      ciHigh: gateStats.ciHigh,
      passed: pass,
      metric: 'head_to_head_winrate_ci_low_over_half',
    },
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `search-${Math.abs(args.seed) % 100000}.json`);
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify({ out, gate: result.gate }, null, 1));
  console.error(
    `gate: tuned ${gateStats.winRate} vs shipped (CI [${gateStats.ciLow}, ${gateStats.ciHigh}]) → ${pass ? 'PASS' : 'FAIL'}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
