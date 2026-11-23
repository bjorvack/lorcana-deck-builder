/**
 * Restricted-conditioning stratum runner (learned-deck-generator, task 1.5;
 * design D1c): MAP-Elites-style search inside declared-ink and
 * franchise-restricted pools, league-evaluated, kept only above the
 * pre-committed fitness threshold so baseline-quality decks never become
 * imitation targets.
 *
 * PRE-COMMITTED pools (do not deviate): franchise subsets Frozen, Aladdin,
 * Lilo & Stitch; declared-ink pools Ruby/Sapphire and Amethyst/Emerald. Each
 * pool: 2 generations × population 6, games-per-member 8, master seed
 * 20261123 + poolIndex, heuristic referee. Decks enter the corpus only with
 * league fitness strictly above RESTRICTED_MIN_FITNESS (0.45) — a deck at
 * the threshold is excluded.
 *
 * Pool override: the map-elites CLI has no pool flag, so the CLI drives its
 * exported loop core (runMapElitesSearch — imported, never edited) with the
 * filtered legal pool. The shared league file is never touched: promotions
 * stay inside the run's in-memory league copy (no onLeagueChanged), so
 * restricted runs cannot perturb the league other runners evaluate against.
 *
 * Honest coverage: a pool with fewer than RESTRICTED_MIN_POOL_IDENTITIES
 * legal identities is not searched at all; a search yielding fewer than
 * RESTRICTED_MIN_PASSING_DECKS threshold-passing decks drops out of the
 * corpus. Both drops are recorded in the run stats with their reason.
 *
 * Evaluation goes through map-elites' `--eval-chunk` child mode (see
 * chunk-eval.ts) — the parent stays engine-free and the arena disk cache
 * gives game-level resume across re-invocations.
 *
 * Usage:
 *   npx tsx scripts/training/generator/restricted.ts \
 *     --league <league.json> [--archive <archive.json> ...] \
 *     [--seed-base 20261123] [--generations 2] [--population 6] \
 *     [--games-per-member 8] [--parallel 3] [--out-dir <dir>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../../src/data/types';
import type { League } from '../arena/league';
import {
  type CandidateEvaluation,
  type CandidateEvaluator,
  runMapElitesSearch,
  writeArchiveFile,
} from '../arena/map-elites';
import type { ElitesArchive } from '../arena/map-elites-archive';
import type { LegalPool, PoolEntry } from '../arena/map-elites-mutation';
import { DEFAULT_REFEREE } from '../arena/schedule';
import { type EvalChunkRequest, evaluateChunks } from './chunk-eval';
import {
  buildCorpus,
  loadCorpusArchive,
  RESTRICTED_MIN_FITNESS,
  type RestrictedDeckInput,
  sortDeckRecord,
  stableDeckKey,
  stableStringify,
} from './corpus';

// ---- pre-committed parameters (task 1.5) ----

export const RESTRICTED_SEED_BASE = 20261123;
export const RESTRICTED_GENERATIONS = 2;
export const RESTRICTED_POPULATION = 6;
export const RESTRICTED_GAMES_PER_MEMBER = 8;
export const RESTRICTED_BATCH_SIZE = 8;
export const RESTRICTED_PARALLEL = 3;
/** a pool below this many legal identities is not searched (thin-pool drop) */
export const RESTRICTED_MIN_POOL_IDENTITIES = 40;
/** a search under this many threshold-passing decks drops out of the corpus */
export const RESTRICTED_MIN_PASSING_DECKS = 3;

export interface RestrictedPoolSpec {
  /** corpus condition tag, e.g. `franchise:Frozen` */
  condition: string;
  /** artifact/file slug, e.g. `franchise-frozen` */
  slug: string;
  kind: 'franchise' | 'inks';
  /** franchise name (kind 'franchise') */
  franchise?: string;
  /** declared ink pair (kind 'inks') */
  inks?: [string, string];
}

/** the pre-committed pool list; poolIndex = position (master seed offset) */
export const RESTRICTED_POOLS: readonly RestrictedPoolSpec[] = [
  {
    condition: 'franchise:Frozen',
    slug: 'franchise-frozen',
    kind: 'franchise',
    franchise: 'Frozen',
  },
  {
    condition: 'franchise:Aladdin',
    slug: 'franchise-aladdin',
    kind: 'franchise',
    franchise: 'Aladdin',
  },
  {
    condition: 'franchise:Lilo & Stitch',
    slug: 'franchise-lilo-stitch',
    kind: 'franchise',
    franchise: 'Lilo & Stitch',
  },
  {
    condition: 'inks:ruby-sapphire',
    slug: 'inks-ruby-sapphire',
    kind: 'inks',
    inks: ['Ruby', 'Sapphire'],
  },
  {
    condition: 'inks:amethyst-emerald',
    slug: 'inks-amethyst-emerald',
    kind: 'inks',
    inks: ['Amethyst', 'Emerald'],
  },
];

// ---- pool filtering + threshold ----

/**
 * Restrict the legal self-play pool to the conditioning: franchise pools keep
 * identities whose canonical card belongs to the franchise; ink pools keep
 * identities whose inks all sit inside the declared pair (a dual-ink card
 * reaching outside the pair would force a third declared ink).
 */
export function filterLegalPool(
  fullPool: LegalPool,
  spec: RestrictedPoolSpec,
  cardsById: Map<number, Card>,
): LegalPool {
  const out = new Map<number, PoolEntry>();
  for (const [id, entry] of fullPool) {
    if (spec.kind === 'franchise') {
      const card = cardsById.get(id);
      if (!card || card.franchise !== spec.franchise) continue;
    } else if (!entry.inks.every((ink) => spec.inks?.includes(ink))) {
      continue;
    }
    out.set(id, entry);
  }
  return out;
}

/** strict threshold (D1): a deck AT the threshold is excluded */
export function passesRestrictedThreshold(
  fitness: number,
  threshold: number = RESTRICTED_MIN_FITNESS,
): boolean {
  return fitness > threshold;
}

// ---- per-pool run ----

export type RestrictedDropReason =
  | 'thin-pool'
  | 'below-threshold-pass-count'
  | 'search-failed';

export interface RestrictedPoolStats {
  condition: string;
  slug: string;
  poolIndex: number;
  masterSeed: number;
  /** legal identities in the restricted pool */
  poolSize: number;
  /** candidates the search evaluated (generations × population) */
  candidatesEvaluated: number;
  /** games simulated for this pool's candidates */
  games: number;
  /** archive cells the search occupied */
  cells: number;
  /** retained cells above the threshold */
  cellsPassingThreshold: number;
  /** distinct evaluated decks above the threshold (before corpus dedupe) */
  passingDecks: number;
  dropped: boolean;
  reason?: RestrictedDropReason;
  /** set for 'search-failed': the underlying loop-core error */
  error?: string;
}

export interface RestrictedPoolRun {
  stats: RestrictedPoolStats;
  /** threshold-passing decks for the corpus (empty when the pool dropped) */
  decks: RestrictedDeckInput[];
}

interface EvaluatedDeck {
  generation: number;
  index: number;
  deck: Record<string, number>;
  fitness: number;
  games: number;
}

export interface RunRestrictedPoolOptions {
  spec: RestrictedPoolSpec;
  poolIndex: number;
  fullPool: LegalPool;
  cards: readonly Card[];
  league: League;
  masterSeed: number;
  generations?: number;
  population?: number;
  gamesPerMember?: number;
  batchSize?: number;
  threshold?: number;
  evaluate: CandidateEvaluator;
  /** per-pool archive persistence (the league file is never written) */
  archivePath?: string;
}

/**
 * Run one restricted pool through the map-elites loop core with the filtered
 * pool. The caller's league is never mutated (promotions stay inside the
 * search's in-memory copy and are not persisted). Returns the pool's honest
 * coverage stats plus its threshold-passing decks (empty when dropped).
 */
export async function runRestrictedPool(
  opts: RunRestrictedPoolOptions,
): Promise<RestrictedPoolRun> {
  const generations = opts.generations ?? RESTRICTED_GENERATIONS;
  const population = opts.population ?? RESTRICTED_POPULATION;
  const gamesPerMember = opts.gamesPerMember ?? RESTRICTED_GAMES_PER_MEMBER;
  const threshold = opts.threshold ?? RESTRICTED_MIN_FITNESS;
  const cardsById = new Map(opts.cards.map((card) => [card.id, card]));
  const pool = filterLegalPool(opts.fullPool, opts.spec, cardsById);
  const baseStats = {
    condition: opts.spec.condition,
    slug: opts.spec.slug,
    poolIndex: opts.poolIndex,
    masterSeed: opts.masterSeed,
    poolSize: pool.size,
  };
  if (pool.size < RESTRICTED_MIN_POOL_IDENTITIES) {
    return {
      stats: {
        ...baseStats,
        candidatesEvaluated: 0,
        games: 0,
        cells: 0,
        cellsPassingThreshold: 0,
        passingDecks: 0,
        dropped: true,
        reason: 'thin-pool',
      },
      decks: [],
    };
  }

  // the evaluator records what the loop actually evaluated — non-placed
  // candidates above the threshold are corpus material too (the corpus
  // builder re-dedupes and re-applies the threshold)
  const evaluated: EvaluatedDeck[] = [];
  const evaluate: CandidateEvaluator = async (
    candidates,
    league,
    generation,
  ) => {
    const evaluations: CandidateEvaluation[] = await opts.evaluate(
      candidates,
      league,
      generation,
    );
    const byIndex = new Map(evaluations.map((entry) => [entry.index, entry]));
    for (const candidate of candidates) {
      const evaluation = byIndex.get(candidate.index);
      if (!evaluation) {
        throw new Error(
          `evaluator returned no result for candidate ${candidate.index} ` +
            `(pool ${opts.spec.condition}, generation ${generation})`,
        );
      }
      evaluated.push({
        generation,
        index: candidate.index,
        deck: sortDeckRecord(candidate.deck),
        fitness: evaluation.fitness,
        games: evaluation.games,
      });
    }
    return evaluations;
  };

  let result: Awaited<ReturnType<typeof runMapElitesSearch>>;
  try {
    result = await runMapElitesSearch({
      league: opts.league,
      pool,
      cards: opts.cards,
      masterSeed: opts.masterSeed,
      generations,
      population,
      gamesPerMember,
      evaluate,
      ...(opts.archivePath
        ? {
            onArchiveUpdated: async (archive: ElitesArchive) => {
              await writeArchiveFile(opts.archivePath!, archive);
            },
          }
        : {}),
    });
  } catch (error) {
    // one pool failing (e.g. no gate-clearing parents in a thin franchise)
    // must not sink the pools behind it — record the coverage honestly
    return {
      stats: {
        ...baseStats,
        candidatesEvaluated: evaluated.length,
        games: 0,
        cells: 0,
        cellsPassingThreshold: 0,
        passingDecks: 0,
        dropped: true,
        reason: 'search-failed',
        error: error instanceof Error ? error.message : String(error),
      },
      decks: [],
    };
  }

  const cells = Object.values(result.archive.cells);
  const cellsPassing = cells.filter((cell) =>
    passesRestrictedThreshold(cell.fitness, threshold),
  );
  const passing = evaluated.filter((entry) =>
    passesRestrictedThreshold(entry.fitness, threshold),
  );
  // first occurrence per composition (generation asc, index asc) — repeated
  // evaluations of an identical deck (mutation fallbacks) keep one entry
  const seen = new Set<string>();
  const decks: RestrictedDeckInput[] = [];
  for (const entry of passing) {
    const key = stableDeckKey(entry.deck);
    if (seen.has(key)) continue;
    seen.add(key);
    decks.push({
      condition: opts.spec.condition,
      deckId: `gen-${entry.generation}-cand-${entry.index}`,
      deck: entry.deck,
      fitness: entry.fitness,
    });
  }

  const stats: RestrictedPoolStats = {
    ...baseStats,
    candidatesEvaluated: evaluated.length,
    games: result.totals.games,
    cells: cells.length,
    cellsPassingThreshold: cellsPassing.length,
    passingDecks: decks.length,
    dropped: false,
  };
  if (decks.length < RESTRICTED_MIN_PASSING_DECKS) {
    return {
      stats: { ...stats, dropped: true, reason: 'below-threshold-pass-count' },
      decks: [],
    };
  }
  return { stats, decks };
}

/** run the pre-committed pools sequentially; each pool's stats are recorded */
export async function runRestrictedPools(opts: {
  specs: readonly RestrictedPoolSpec[];
  fullPool: LegalPool;
  cards: readonly Card[];
  league: League;
  seedBase: number;
  evaluate: (spec: RestrictedPoolSpec, poolIndex: number) => CandidateEvaluator;
  archivePathFor?: (spec: RestrictedPoolSpec) => string | undefined;
  generations?: number;
  population?: number;
  gamesPerMember?: number;
  threshold?: number;
}): Promise<RestrictedPoolRun[]> {
  const runs: RestrictedPoolRun[] = [];
  for (const [poolIndex, spec] of opts.specs.entries()) {
    runs.push(
      await runRestrictedPool({
        spec,
        poolIndex,
        fullPool: opts.fullPool,
        cards: opts.cards,
        league: opts.league,
        masterSeed: opts.seedBase + poolIndex,
        generations: opts.generations,
        population: opts.population,
        gamesPerMember: opts.gamesPerMember,
        threshold: opts.threshold,
        evaluate: opts.evaluate(spec, poolIndex),
        ...(opts.archivePathFor
          ? { archivePath: opts.archivePathFor(spec) }
          : {}),
      }),
    );
  }
  return runs;
}

// ---- CLI ----

export interface RestrictedRunReport {
  stratum: 'restricted';
  engineCommit: string;
  seedBase: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  threshold: number;
  referee: string;
  pools: RestrictedPoolStats[];
  decks: RestrictedDeckInput[];
  totals: {
    poolsRun: number;
    poolsDropped: number;
    candidatesEvaluated: number;
    games: number;
    corpusDecks: number;
  };
  corpusOut: string;
  corpusStats?: ReturnType<typeof buildCorpus>['stats'];
  wallMs: number;
}

interface RestrictedArgs {
  leaguePath: string;
  archivePaths: string[];
  seedBase: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  batchSize: number;
  parallel: number;
  threshold: number;
  outDir: string;
}

const DEFAULT_OUT_DIR = resolve(import.meta.dirname, '..', 'data', 'generator');

function parseRestrictedArgs(argv: string[]): RestrictedArgs {
  const archivePaths: string[] = [];
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--archive') archivePaths.push(resolve(argv[++i]!));
  }
  const leaguePath = get('--league') ? resolve(get('--league')!) : '';
  if (!leaguePath) throw new Error('--league <file> is required');
  const outDir = get('--out-dir')
    ? resolve(get('--out-dir')!)
    : DEFAULT_OUT_DIR;
  return {
    leaguePath,
    archivePaths,
    seedBase: Number(get('--seed-base') ?? RESTRICTED_SEED_BASE),
    generations: Number(get('--generations') ?? RESTRICTED_GENERATIONS),
    population: Number(get('--population') ?? RESTRICTED_POPULATION),
    gamesPerMember: Number(
      get('--games-per-member') ?? RESTRICTED_GAMES_PER_MEMBER,
    ),
    batchSize: Number(get('--batch-size') ?? RESTRICTED_BATCH_SIZE),
    parallel: Math.max(1, Number(get('--parallel') ?? RESTRICTED_PARALLEL)),
    threshold: Number(get('--threshold') ?? RESTRICTED_MIN_FITNESS),
    outDir,
  };
}

export async function runRestrictedCli(
  args: RestrictedArgs,
): Promise<RestrictedRunReport> {
  // heavy imports stay lazy: the test import graph must stay engine-free
  const { loadCards } = await import('../arena/cards');
  const { buildCanonicalRegistry } = await import('../canonical');
  const { buildCardMap } = await import('../arena/card-map');
  const { loadEngineCatalog } = await import('../arena/engine-cards');
  const { legalSelfPlayIdentities, loadLeague } = await import(
    '../arena/league'
  );
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
  const league = await loadLeague(args.leaguePath);
  if (league.engineCommit.slice(0, 8) !== catalog.engineCommit.slice(0, 8)) {
    throw new Error(
      `league era ${league.engineCommit.slice(0, 8)} ≠ engine era ${catalog.engineCommit.slice(0, 8)}`,
    );
  }
  const fullPool = legalSelfPlayIdentities(cards, cardMap);
  const archives = args.archivePaths.map((path) => loadCorpusArchive(path));

  const archiveDir = resolve(args.outDir, 'restricted');
  const started = Date.now();
  const runs = await runRestrictedPools({
    specs: RESTRICTED_POOLS,
    fullPool,
    cards,
    league,
    seedBase: args.seedBase,
    generations: args.generations,
    population: args.population,
    gamesPerMember: args.gamesPerMember,
    threshold: args.threshold,
    archivePathFor: (spec) => resolve(archiveDir, `${spec.slug}.archive.json`),
    evaluate: (spec, poolIndex) => {
      const masterSeed = args.seedBase + poolIndex;
      return async (candidates, poolLeague, generation) => {
        // single-candidate chunks: the pool league snapshot (with the run's
        // in-memory promotions) rides along; twin mode stays off
        const requests: EvalChunkRequest[] = candidates.map((candidate) => ({
          index: candidate.index,
          deck: candidate.deck,
          parentDeck: candidate.deck,
          league: poolLeague,
          masterSeed,
          gamesPerMember: args.gamesPerMember,
          batchSize: args.batchSize,
          referee: DEFAULT_REFEREE,
          twinPaired: false,
        }));
        const parts = await evaluateChunks(requests, {
          parallel: args.parallel,
          workDir: args.outDir,
          label: `restricted-${spec.slug}-gen${generation}`,
        });
        return parts.map((part) => ({
          index: part.index,
          fitness: part.fitness,
          games: part.games,
        }));
      };
    },
  });
  const wallMs = Date.now() - started;

  const decks = runs.flatMap((run) => run.decks);
  let corpusStats: RestrictedRunReport['corpusStats'];
  let corpusOut = '';
  if (archives.length > 0) {
    const { corpus, stats } = buildCorpus({
      archives,
      league: {
        format: league.format,
        engineCommit: league.engineCommit,
        members: league.members.map(({ id, kind, deck }) => ({
          id,
          kind,
          deck,
        })),
      },
      restrictedDecks: decks,
      restrictedThreshold: args.threshold,
    });
    corpusOut = resolve(
      args.outDir,
      `restricted-corpus-${league.engineCommit.slice(0, 8)}.json`,
    );
    mkdirSync(dirname(corpusOut), { recursive: true });
    writeFileSync(corpusOut, `${stableStringify(corpus)}\n`);
    corpusStats = stats;
  }

  const report: RestrictedRunReport = {
    stratum: 'restricted',
    engineCommit: league.engineCommit,
    seedBase: args.seedBase,
    generations: args.generations,
    population: args.population,
    gamesPerMember: args.gamesPerMember,
    threshold: args.threshold,
    referee: DEFAULT_REFEREE,
    pools: runs.map((run) => run.stats),
    decks,
    totals: {
      poolsRun: runs.length,
      poolsDropped: runs.filter((run) => run.stats.dropped).length,
      candidatesEvaluated: runs.reduce(
        (sum, run) => sum + run.stats.candidatesEvaluated,
        0,
      ),
      games: runs.reduce((sum, run) => sum + run.stats.games, 0),
      corpusDecks: decks.length,
    },
    corpusOut,
    ...(corpusStats ? { corpusStats } : {}),
    wallMs,
  };
  const reportPath = resolve(
    args.outDir,
    `restricted-${league.engineCommit.slice(0, 8)}.json`,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

async function main(): Promise<void> {
  const report = await runRestrictedCli(
    parseRestrictedArgs(process.argv.slice(2)),
  );
  console.log(JSON.stringify(report, null, 1));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
