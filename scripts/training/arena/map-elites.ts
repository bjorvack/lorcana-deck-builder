/**
 * MAP-Elites deck search loop (self-play-league, tasks 4.3/4.4).
 *
 * Each generation takes the archive's elites as parents (generation 0: the
 * league's non-real baseline members, gated through the strict elites pool
 * rules, plus a seeded scatter of random pool decks, so the archive starts
 * populated), produces one mutant per parent with `mutateDeckElites`
 * (legality-guaranteed; a failed mutation falls back to the legal parent),
 * evaluates every mutant against the league via `evaluateCandidateVsLeague`
 * (paired seeds + CRN + SPRT early stop, schedule.ts; referee = the shipped
 * heuristic bot per design D2a), scores fitness as the meta-weighted league
 * score and places the result into its descriptor cell — replacing the elite
 * only when strictly fitter (map-elites-archive.ts). After each generation,
 * newly placed elites fitter than the league (fitness > 0.5) are offered to
 * `promote()` in a fixed order (fitness desc, cell key asc); near-duplicates
 * are pruned by card-list distance and the updated league is persisted.
 *
 * Artifacts (design D3, run-state next to the league files):
 *   archive: scripts/training/data/arena/selfplay/archive-<commit8>-<seed>.json
 *            (or the --archive path; deterministic serialization)
 *   summary: <archive path>.summary.json — per-generation stats plus wall
 *            time. The summary is operational (contains wall-clock time);
 *            only the archive is held to the byte-identical contract.
 *
 * Determinism (task 4.4): seeded `mulberry32` only — mutant RNG seeds derive
 * from master seed + generation + index, scatter seeds from master seed +
 * generation, and league game seed bases from schedule.ts's memberSeedBase.
 * The three ranges are disjoint (mutant ≥ master+1_000_003, scatter ≥
 * master+2_000_003, member bases master+idx·1000). Re-running with identical
 * seeds and engine commit reproduces a byte-identical archive; promotions are
 * processed in a fixed order so the league evolves identically too.
 *
 * Parallelism (design D7): per-candidate child `tsx` processes following the
 * batch.ts/evolve.ts spawn pattern — a dynamic worker pool of `--parallel`
 * children, each evaluating ONE candidate against the league snapshot written
 * to a chunk file and returning a small JSON part; the parent merges parts in
 * candidate order (never completion order), places them, saves the archive.
 * Part directories are per-invocation (`.parts-<pid>-<generation>`) so
 * concurrent runs never delete each other's parts.
 *
 * Usage:
 *   npx tsx scripts/training/arena/map-elites.ts --league <league.json> \
 *     [--generations 2] [--population 8] [--games-per-member 8] \
 *     [--batch-size 8] [--seed 20261121] [--parallel 1] \
 *     [--archive <path>] [--twin-paired]
 *
 * The updated league is persisted back to the --league path whenever a
 * promotion lands. --twin-paired additionally evaluates each mutant's parent
 * on the same seed bases (schedule.ts twin mode) and only offers mutants that
 * beat their own parent on the paired seeds for promotion.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Card } from '../../../src/data/types';
import { mulberry32 } from '../prng';
import {
  type League,
  legalSelfPlayIdentities,
  loadLeague,
  promote,
  randomLegalDeck,
} from './league';
import {
  archivePath,
  type ElitesArchive,
  emptyArchive,
  place,
  stableStringify,
} from './map-elites-archive';
import { describeDeck, descriptorCell } from './map-elites-descriptors';
import {
  elitesDeckProblems,
  type LegalPool,
  mutateDeckElites,
} from './map-elites-mutation';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_REFEREE,
  evaluateCandidateVsLeague,
} from './schedule';
import { buildSelfPlayPool } from './selfplay-pool';

const execFileAsync = promisify(execFile);

export const DEFAULT_GENERATIONS = 2;
export const DEFAULT_POPULATION = 8;
export const DEFAULT_GAMES_PER_MEMBER = 8;
/** a placed elite is offered to the league only above this league score */
export const PROMOTION_MIN_FITNESS = 0.5;

/** mutant rng seeds: disjoint from the league game seed bases (master + idx·1000) */
const MUTANT_SEED_OFFSET = 1_000_003;
const MUTANT_SEED_GENERATION_STRIDE = 10_007;
const MUTANT_SEED_INDEX_STRIDE = 101;
/** scatter rng seeds: likewise disjoint */
const SCATTER_SEED_OFFSET = 2_000_003;
const SCATTER_ATTEMPTS_PER_PARENT = 50;
const SCATTER_BASE_ATTEMPTS = 100;

export function mutantSeedFor(
  masterSeed: number,
  generation: number,
  index: number,
): number {
  return (
    (masterSeed +
      MUTANT_SEED_OFFSET +
      generation * MUTANT_SEED_GENERATION_STRIDE +
      index * MUTANT_SEED_INDEX_STRIDE) >>>
    0
  );
}

export function scatterSeedFor(masterSeed: number, generation: number): number {
  return (
    (masterSeed +
      SCATTER_SEED_OFFSET +
      generation * MUTANT_SEED_GENERATION_STRIDE) >>>
    0
  );
}

// ---- search core: pure orchestration, the evaluator is injected ----

export interface SearchCandidate {
  index: number;
  /** deck to evaluate (the mutant, or the parent when mutation failed) */
  deck: Record<string, number>;
  /** the deck this candidate was mutated from (twin-paired evaluation) */
  parentDeck: Record<string, number>;
  parentOrigin: string;
  generation: number;
}

export interface CandidateEvaluation {
  index: number;
  /** fitness = meta-weighted league score (schedule.ts/league-score.ts) */
  fitness: number;
  /** games the fitness was measured over */
  games: number;
  /** twin-paired mode: the parent's score on the same seed bases */
  twinFitness?: number;
  twinGames?: number;
}

/** plays all candidates of one generation against the given league snapshot */
export type CandidateEvaluator = (
  candidates: SearchCandidate[],
  league: League,
  generation: number,
) => Promise<CandidateEvaluation[]>;

export interface SearchParent {
  deck: Record<string, number>;
  origin: string;
}

export interface PromotionRecord {
  generation: number;
  cellKey: string;
  fitness: number;
  promoted: boolean;
  /** twin-paired mode: the parent's paired score */
  twinFitness?: number;
  /** set when rejected */
  reason?: 'near-duplicate';
  nearestId?: string;
  distance?: number;
}

export interface GenerationSummary {
  generation: number;
  parents: number;
  candidates: number;
  /** best candidate fitness this generation */
  best: number;
  /** nearest-rank median candidate fitness this generation */
  median: number;
  /** games simulated for this generation's candidates (twin games included) */
  games: number;
  cellsOccupied: number;
  placements: number;
  promotions: number;
  promotionsDetail: PromotionRecord[];
  parentOrigins: string[];
}

export interface SearchTotals {
  candidates: number;
  games: number;
  promotions: number;
}

export interface SearchRunResult {
  archive: ElitesArchive;
  /** the league after this run's promotions (caller input is never mutated) */
  league: League;
  generations: GenerationSummary[];
  totals: SearchTotals;
}

export interface MapElitesSearchOptions {
  league: League;
  pool: LegalPool;
  cards: readonly Card[];
  masterSeed: number;
  generations?: number;
  population?: number;
  gamesPerMember?: number;
  twinPaired?: boolean;
  evaluate: CandidateEvaluator;
  /** called whenever a promotion changed the league (persist the file) */
  onLeagueChanged?: (
    league: League,
    generation: number,
  ) => Promise<void> | void;
  /** called after each generation's placements (persist the archive) */
  onArchiveUpdated?: (
    archive: ElitesArchive,
    generation: number,
  ) => Promise<void> | void;
}

interface PlacedEntry {
  cellKey: string;
  fitness: number;
  deck: Record<string, number>;
  twinFitness?: number;
}

/**
 * Generation-0 parents: league baseline members (never 'real' — held-out
 * decks are opponents only) that clear the strict pool gate, then a seeded
 * scatter of random pool decks. Later generations: the archive's elites in
 * cell-key order, cycled when there are fewer elites than the population.
 */
export function selectParents(opts: {
  archive: ElitesArchive;
  league: League;
  pool: LegalPool;
  cards: readonly Card[];
  masterSeed: number;
  generation: number;
  population: number;
}): SearchParent[] {
  const eliteKeys = Object.keys(opts.archive.cells).sort();
  if (opts.generation > 0 && eliteKeys.length > 0) {
    const parents: SearchParent[] = [];
    for (let i = 0; i < opts.population; i++) {
      const cellKey = eliteKeys[i % eliteKeys.length]!;
      parents.push({
        deck: opts.archive.cells[cellKey]!.deck,
        origin: `archive:${cellKey}`,
      });
    }
    return parents;
  }
  const parents: SearchParent[] = [];
  for (const member of opts.league.members) {
    if (member.kind === 'real') continue;
    if (parents.length >= opts.population) break;
    if (elitesDeckProblems(member.deck, opts.pool, opts.cards).length === 0) {
      parents.push({ deck: member.deck, origin: `league:${member.id}` });
    }
  }
  const rng = mulberry32(scatterSeedFor(opts.masterSeed, opts.generation));
  const maxAttempts =
    opts.population * SCATTER_ATTEMPTS_PER_PARENT + SCATTER_BASE_ATTEMPTS;
  let scatterIndex = 0;
  for (
    let attempt = 0;
    attempt < maxAttempts && parents.length < opts.population;
    attempt++
  ) {
    const deck = randomLegalDeck(opts.pool, rng);
    if (!deck) continue;
    // the seeder's gate is lenient on dual-ink cards; the archive gate is not
    if (elitesDeckProblems(deck.cards, opts.pool, opts.cards).length > 0)
      continue;
    parents.push({ deck: deck.cards, origin: `scatter:${scatterIndex}` });
    scatterIndex++;
  }
  return parents;
}

export interface PromotionOffer {
  cellKey: string;
  fitness: number;
  deck: Record<string, number>;
  twinFitness?: number;
}

/**
 * Fixed promotion order: fitness descending, then cell key ascending. Only
 * placed elites fitter than the league are offered; with twin-paired mode a
 * mutant must also beat its parent's paired score.
 */
export function selectPromotionOffers(
  placed: PromotionOffer[],
  opts: { twinPaired?: boolean; minFitness?: number } = {},
): PromotionOffer[] {
  const minFitness = opts.minFitness ?? PROMOTION_MIN_FITNESS;
  return placed
    .filter((entry) => entry.fitness > minFitness)
    .filter((entry) =>
      opts.twinPaired
        ? entry.twinFitness !== undefined && entry.fitness > entry.twinFitness
        : true,
    )
    .sort(
      (a, b) =>
        b.fitness - a.fitness ||
        (a.cellKey < b.cellKey ? -1 : a.cellKey > b.cellKey ? 1 : 0),
    );
}

/** nearest-rank median (same convention as archiveStats) */
const medianOf = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(0.5 * (sorted.length - 1))]!;
};

/**
 * The search loop. Deterministic given (league, pool, cards, master seed,
 * generations, population, games per member, batch size, evaluator): no
 * wall-clock enters the archive, no Math.random anywhere.
 */
export async function runMapElitesSearch(
  opts: MapElitesSearchOptions,
): Promise<SearchRunResult> {
  const generations = opts.generations ?? DEFAULT_GENERATIONS;
  const population = opts.population ?? DEFAULT_POPULATION;
  const gamesPerMember = opts.gamesPerMember ?? DEFAULT_GAMES_PER_MEMBER;
  const twinPaired = opts.twinPaired ?? false;
  if (!Number.isInteger(generations) || generations < 1)
    throw new Error(
      `generations must be a positive integer (got ${generations})`,
    );
  if (!Number.isInteger(population) || population < 1)
    throw new Error(
      `population must be a positive integer (got ${population})`,
    );
  if (!Number.isInteger(gamesPerMember) || gamesPerMember < 1)
    throw new Error(
      `gamesPerMember must be a positive integer (got ${gamesPerMember})`,
    );

  let league = opts.league;
  let archive = emptyArchive(
    league.format,
    league.engineCommit,
    opts.masterSeed,
  );
  const summaries: GenerationSummary[] = [];
  let totalCandidates = 0;
  let totalGames = 0;
  let totalPromotions = 0;

  for (let generation = 0; generation < generations; generation++) {
    const parents = selectParents({
      archive,
      league,
      pool: opts.pool,
      cards: opts.cards,
      masterSeed: opts.masterSeed,
      generation,
      population,
    });
    if (parents.length === 0) {
      throw new Error(
        'no legal parents available — the league has no gate-clearing ' +
          'baseline members and the pool yielded no random-legal deck',
      );
    }

    const candidates: SearchCandidate[] = [];
    for (const [index, parent] of parents.entries()) {
      const rng = mulberry32(mutantSeedFor(opts.masterSeed, generation, index));
      const mutated = mutateDeckElites(parent.deck, opts.pool, opts.cards, rng);
      // a failed mutation falls back to the parent — gate-legal by
      // construction, so the archive only ever sees legal decks
      candidates.push({
        index,
        deck: mutated ?? parent.deck,
        parentDeck: parent.deck,
        parentOrigin: parent.origin,
        generation,
      });
    }

    const evaluations = await opts.evaluate(candidates, league, generation);
    const byIndex = new Map(evaluations.map((entry) => [entry.index, entry]));
    const placed: PlacedEntry[] = [];
    let generationGames = 0;
    for (const candidate of candidates) {
      const evaluation = byIndex.get(candidate.index);
      if (!evaluation) {
        throw new Error(
          `evaluator returned no result for candidate ${candidate.index} (generation ${generation})`,
        );
      }
      generationGames += evaluation.games + (evaluation.twinGames ?? 0);
      const descriptor = describeDeck(candidate.deck, opts.cards);
      const cellKey = descriptorCell(descriptor);
      const result = place(archive, cellKey, {
        descriptor,
        deck: candidate.deck,
        fitness: evaluation.fitness,
        games: evaluation.games,
        updatedOn: generation,
      });
      archive = result.archive;
      if (result.placed) {
        placed.push({
          cellKey,
          fitness: evaluation.fitness,
          deck: candidate.deck,
          ...(evaluation.twinFitness !== undefined
            ? { twinFitness: evaluation.twinFitness }
            : {}),
        });
      }
    }

    const offers = selectPromotionOffers(placed, { twinPaired });
    const promotionsDetail: PromotionRecord[] = [];
    for (const offer of offers) {
      const result = promote(league, offer.deck, offer.fitness, {
        origin: `map-elites:gen-${generation}:${offer.cellKey}`,
      });
      promotionsDetail.push({
        generation,
        cellKey: offer.cellKey,
        fitness: offer.fitness,
        ...(offer.twinFitness !== undefined
          ? { twinFitness: offer.twinFitness }
          : {}),
        promoted: result.promoted,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.nearestId !== undefined
          ? { nearestId: result.nearestId }
          : {}),
        ...(result.distance !== undefined ? { distance: result.distance } : {}),
      });
      if (result.promoted) league = result.league;
    }
    const promotions = promotionsDetail.filter(
      (entry) => entry.promoted,
    ).length;
    if (promotions > 0) await opts.onLeagueChanged?.(league, generation);
    await opts.onArchiveUpdated?.(archive, generation);

    const fitnessValues = candidates.map(
      (candidate) => byIndex.get(candidate.index)!.fitness,
    );
    summaries.push({
      generation,
      parents: parents.length,
      candidates: candidates.length,
      best: Math.max(...fitnessValues),
      median: medianOf(fitnessValues),
      games: generationGames,
      cellsOccupied: Object.keys(archive.cells).length,
      placements: placed.length,
      promotions,
      promotionsDetail,
      parentOrigins: parents.map((parent) => parent.origin),
    });
    totalCandidates += candidates.length;
    totalGames += generationGames;
    totalPromotions += promotions;
  }

  return {
    archive,
    league,
    generations: summaries,
    totals: {
      candidates: totalCandidates,
      games: totalGames,
      promotions: totalPromotions,
    },
  };
}

// ---- CLI: parent + per-candidate child processes ----

interface EvalChunk {
  index: number;
  deck: Record<string, number>;
  parentDeck: Record<string, number>;
  /** league snapshot this candidate is evaluated against */
  league: League;
  masterSeed: number;
  gamesPerMember: number;
  batchSize: number;
  referee: string;
  twinPaired: boolean;
}

interface ChildPart {
  index: number;
  fitness: number;
  games: number;
  twin?: { fitness: number; games: number };
}

interface ChildEvaluatorDeps {
  parallel: number;
  masterSeed: number;
  gamesPerMember: number;
  batchSize: number;
  referee: string;
  twinPaired: boolean;
  /** directory the per-invocation part directories live in */
  workDir: string;
}

/**
 * Per-candidate child-process evaluator (batch.ts/evolve.ts spawn pattern):
 * a dynamic pool of `--parallel` tsx children, each evaluating one candidate
 * against the league snapshot from a chunk file and writing a small JSON
 * part. Parts are merged in candidate order — never completion order — so
 * the merge is deterministic. Per-invocation part dir (pid + generation):
 * concurrent runs must not delete each other's parts.
 */
function makeChildEvaluator(deps: ChildEvaluatorDeps): CandidateEvaluator {
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const self = fileURLToPath(import.meta.url);
  return async (candidates, league, generation) => {
    const partDir = join(deps.workDir, `.parts-${process.pid}-${generation}`);
    mkdirSync(partDir, { recursive: true });
    let next = 0;
    const runWorker = async (): Promise<void> => {
      while (next < candidates.length) {
        const candidate = candidates[next++]!;
        const chunkPath = join(partDir, `chunk-${candidate.index}.json`);
        const partPath = join(partDir, `part-${candidate.index}.json`);
        const chunk: EvalChunk = {
          index: candidate.index,
          deck: candidate.deck,
          parentDeck: candidate.parentDeck,
          league,
          masterSeed: deps.masterSeed,
          gamesPerMember: deps.gamesPerMember,
          batchSize: deps.batchSize,
          referee: deps.referee,
          twinPaired: deps.twinPaired,
        };
        writeFileSync(chunkPath, JSON.stringify(chunk));
        await execFileAsync(process.execPath, [
          tsxCli,
          self,
          '--eval-chunk',
          chunkPath,
          '--part',
          partPath,
        ]);
      }
    };
    const workers = Math.max(1, Math.min(deps.parallel, candidates.length));
    try {
      await Promise.all(Array.from({ length: workers }, () => runWorker()));
      const evaluations: CandidateEvaluation[] = [];
      for (const candidate of candidates) {
        const partPath = join(partDir, `part-${candidate.index}.json`);
        if (!existsSync(partPath)) {
          throw new Error(
            `map-elites child for candidate ${candidate.index} wrote no part (${partPath})`,
          );
        }
        const part = JSON.parse(readFileSync(partPath, 'utf8')) as ChildPart;
        if (part.index !== candidate.index) {
          throw new Error(
            `map-elites part ${partPath} carries index ${part.index}, expected ${candidate.index}`,
          );
        }
        evaluations.push({
          index: part.index,
          fitness: part.fitness,
          games: part.games,
          ...(part.twin
            ? { twinFitness: part.twin.fitness, twinGames: part.twin.games }
            : {}),
        });
      }
      return evaluations;
    } finally {
      rmSync(partDir, { recursive: true, force: true });
    }
  };
}

/** child mode: evaluate one candidate against the chunk's league snapshot */
async function runChild(chunkPath: string, partPath: string): Promise<void> {
  // heavy imports stay lazy: the test import graph must stay engine-free
  const { buildCanonicalRegistry } = await import('../canonical');
  const { buildCardMap } = await import('./card-map');
  const { loadCards } = await import('./cards');
  const { loadEngineCatalog } = await import('./engine-cards');
  const { cachedBatchPlayer } = await import('./evaluate-candidate');
  const chunk = JSON.parse(readFileSync(chunkPath, 'utf8')) as EvalChunk;
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
  const play = cachedBatchPlayer({
    catalog,
    cardMap,
    engineCommit: catalog.engineCommit,
    mapFormat: cardMap.format,
    referee: chunk.referee,
  });
  const evaluation = evaluateCandidateVsLeague(chunk.deck, chunk.league, {
    play,
    masterSeed: chunk.masterSeed,
    gamesPerMember: chunk.gamesPerMember,
    batchSize: chunk.batchSize,
    referee: chunk.referee,
    ...(chunk.twinPaired ? { twinDeck: chunk.parentDeck } : {}),
  });
  const games = evaluation.results.reduce(
    (sum, member) => sum + member.games,
    0,
  );
  const part: ChildPart = {
    index: chunk.index,
    fitness: evaluation.score.score,
    games,
    ...(chunk.twinPaired && evaluation.twin
      ? {
          twin: {
            fitness: evaluation.twin.score.score,
            games: evaluation.twin.results.reduce(
              (sum, member) => sum + member.games,
              0,
            ),
          },
        }
      : {}),
  };
  mkdirSync(dirname(partPath), { recursive: true });
  writeFileSync(partPath, JSON.stringify(part));
}

/** archive serialization identical to saveArchive, at an exact path */
export async function writeArchiveFile(
  filePath: string,
  archive: ElitesArchive,
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${stableStringify(archive)}\n`);
  return filePath;
}

/** league serialization identical to saveLeague, at an exact path */
export async function writeLeagueFile(
  filePath: string,
  league: League,
): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(league, null, 1)}\n`);
  return filePath;
}

interface Args {
  league: string;
  generations: number;
  population: number;
  gamesPerMember: number;
  batchSize: number;
  seed: number;
  parallel: number;
  archive: string | null;
  twinPaired: boolean;
  evalChunk: string | null;
  part: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const league = get('--league') ? resolve(get('--league')!) : null;
  const evalChunk = get('--eval-chunk') ? resolve(get('--eval-chunk')!) : null;
  const args: Args = {
    league: league ?? '',
    generations: Number(get('--generations') ?? DEFAULT_GENERATIONS),
    population: Number(get('--population') ?? DEFAULT_POPULATION),
    gamesPerMember: Number(
      get('--games-per-member') ?? DEFAULT_GAMES_PER_MEMBER,
    ),
    batchSize: Number(get('--batch-size') ?? DEFAULT_BATCH_SIZE),
    seed: Number(get('--seed') ?? 20261121),
    parallel: Math.max(1, Number(get('--parallel') ?? 1)),
    archive: get('--archive') ? resolve(get('--archive')!) : null,
    twinPaired: argv.includes('--twin-paired'),
    evalChunk,
    part: get('--part') ? resolve(get('--part')!) : null,
  };
  if (evalChunk) {
    if (!args.part)
      throw new Error('--part <file> is required with --eval-chunk');
    return args;
  }
  if (!args.league) throw new Error('--league <file> is required');
  return args;
}

export interface RunSummary {
  archive: string;
  league: string;
  engineCommit: string;
  seed: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  batchSize: number;
  referee: string;
  twinPaired: boolean;
  perGeneration: GenerationSummary[];
  totals: SearchTotals;
  archiveCells: number;
  wallMs: number;
  gamesPerSecond: number;
}

/** the run summary lives next to the archive: <archive>.summary.json */
export function summaryPathFor(archiveFilePath: string): string {
  return `${archiveFilePath.replace(/\.json$/, '')}.summary.json`;
}

async function runParent(args: Args): Promise<void> {
  // heavy imports stay lazy (same pattern as league.ts main)
  const { buildCanonicalRegistry } = await import('../canonical');
  const { buildCardMap } = await import('./card-map');
  const { loadCards } = await import('./cards');
  const { loadEngineCatalog } = await import('./engine-cards');
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
  const league = await loadLeague(args.league);
  if (league.engineCommit.slice(0, 8) !== catalog.engineCommit.slice(0, 8)) {
    throw new Error(
      `league era ${league.engineCommit.slice(0, 8)} ≠ engine era ${catalog.engineCommit.slice(0, 8)} — reseed the league`,
    );
  }
  // coverage gate: fail loudly before any games when the engine lags
  buildSelfPlayPool(cardMap);
  const pool = legalSelfPlayIdentities(cards, cardMap);

  const outPath = args.archive ?? archivePath(catalog.engineCommit, args.seed);
  const evaluate = makeChildEvaluator({
    parallel: args.parallel,
    masterSeed: args.seed,
    gamesPerMember: args.gamesPerMember,
    batchSize: args.batchSize,
    referee: DEFAULT_REFEREE,
    twinPaired: args.twinPaired,
    workDir: dirname(outPath),
  });

  const started = Date.now();
  const result = await runMapElitesSearch({
    league,
    pool,
    cards,
    masterSeed: args.seed,
    generations: args.generations,
    population: args.population,
    gamesPerMember: args.gamesPerMember,
    twinPaired: args.twinPaired,
    evaluate,
    onLeagueChanged: async (updated) => {
      await writeLeagueFile(args.league, updated);
    },
    onArchiveUpdated: async (archive) => {
      await writeArchiveFile(outPath, archive);
    },
  });
  await writeArchiveFile(outPath, result.archive);
  const wallMs = Date.now() - started;
  const summary: RunSummary = {
    archive: outPath,
    league: args.league,
    engineCommit: catalog.engineCommit,
    seed: args.seed,
    generations: args.generations,
    population: args.population,
    gamesPerMember: args.gamesPerMember,
    batchSize: args.batchSize,
    referee: DEFAULT_REFEREE,
    twinPaired: args.twinPaired,
    perGeneration: result.generations,
    totals: result.totals,
    archiveCells: Object.keys(result.archive.cells).length,
    wallMs,
    gamesPerSecond:
      wallMs > 0
        ? Number((result.totals.games / (wallMs / 1000)).toFixed(3))
        : 0,
  };
  const summaryPath = summaryPathFor(outPath);
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.evalChunk) {
    await runChild(args.evalChunk, args.part!);
    return;
  }
  await runParent(args);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
