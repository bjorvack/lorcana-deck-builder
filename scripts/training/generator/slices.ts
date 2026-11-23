/**
 * Pool-slice ablation stratum runner (learned-deck-generator, task 1.7;
 * design D1c): 8 seeded random 50% slices of the legal self-play pool,
 * searched with the 1.5 budget (2 generations × population 6, 8 games per
 * member, heuristic referee) and thresholded at strict > 0.45 like all
 * conditioned strata. Purpose: popularity-bias debiasing — with the staples
 * absent, completions must come from the rest, so the model learns per-card
 * utility instead of memorizing full-pool answers.
 *
 * PRE-COMMITTED scope (do not deviate): 8 slices; slice i = seeded random 50%
 * subset of the legal self-play pool (mulberry32, seed 20261123 + 900 + i,
 * each identity drawn independently with p = 0.5 — pool iterated in ascending
 * identity-id order so the draw is deterministic); per slice 2 generations ×
 * population 6, games-per-member 8, threshold strict > 0.45. The ~25% corpus
 * cap lives in enforceSlicePairCap: it reports the actual share and, when
 * slices exceed it, drops lowest-fitness slice decks (deterministic order)
 * until under cap.
 *
 * Mirror of restricted.ts (task 1.5), not a modification of it: same
 * map-elites loop core (runMapElitesSearch — imported, never edited), same
 * chunk-eval child wiring (engine-free parent; the arena disk cache gives
 * game-level resume across re-invocations with identical flags), same
 * shared-league protection (promotions stay inside the run's in-memory league
 * copy, so slice runs cannot perturb the league other runners evaluate
 * against). Unlike restricted pools, slices get no thin-pool or passing-deck
 * floor — the 50% draw of the full pool cannot be thin by construction, and a
 * degenerate draw failing the search is recorded honestly as 'slice-failed'.
 *
 * Corpus wiring without editing corpus.ts: slice decks ride the corpus's
 * 'restricted' stratum under the opaque condition `pool-slice:<i>`; the
 * artifacts here carry `stratum: 'pool-slice'` plus the slice index so the
 * final corpus build can tag and cap them. Pair counts for the cap are
 * estimated with corpus.ts's masking region rule (estimatePairsPerDeck) —
 * the orchestrator recomputes the share from the final corpus at build time.
 *
 * Usage:
 *   npx tsx scripts/training/generator/slices.ts \
 *     --league <league.json> [--corpus <corpus.json> ...] \
 *     [--seed-base 20261123] [--slices 8] [--generations 2] \
 *     [--population 6] [--games-per-member 8] [--parallel 3] \
 *     [--out-dir <dir>]
 *
 * --corpus feeds the cap-share estimate (folded per stratum: the max across
 * files — the artifacts are overlapping cumulative rebuilds); with no corpus
 * inputs the share is computed against slice pairs alone and the report
 * records that honestly.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { mulberry32 } from '../prng';
import { type EvalChunkRequest, evaluateChunks } from './chunk-eval';
import {
  type CorpusStratum,
  MIN_REGION_CARDS,
  REGIONS_PER_SAMPLE,
  RESTRICTED_MIN_FITNESS,
  SAMPLES_PER_DECK,
  STRATUM_ORDER,
  sortDeckRecord,
  stableDeckKey,
  stableStringify,
} from './corpus';
import { passesRestrictedThreshold } from './restricted';

// ---- pre-committed parameters (task 1.7) ----

export const SLICE_SEED_BASE = 20261123;
/** per-slice seed offset from the master seed base (D1c: base + 900 + i) */
export const SLICE_SEED_OFFSET = 900;
export const SLICE_COUNT = 8;
/** each identity is drawn into the slice independently with this probability */
export const SLICE_DRAW_P = 0.5;
export const SLICE_GENERATIONS = 2;
export const SLICE_POPULATION = 6;
export const SLICE_GAMES_PER_MEMBER = 8;
export const SLICE_BATCH_SIZE = 8;
export const SLICE_PARALLEL = 3;
/** same pre-committed threshold as all conditioned strata (D1c) */
export const SLICE_MIN_FITNESS = RESTRICTED_MIN_FITNESS;
/** slice pairs may not exceed this share of corpus pairs (D1c ~25%) */
export const SLICE_PAIR_CAP = 0.25;
/** a 50% Bernoulli draw is checked against poolSize·p ± sigma·√(poolSize·p·(1−p)) */
export const SLICE_SIZE_SIGMA = 3;

export function sliceSeed(
  sliceIndex: number,
  seedBase = SLICE_SEED_BASE,
): number {
  return seedBase + SLICE_SEED_OFFSET + sliceIndex;
}

/** corpus condition tag of a slice, e.g. `pool-slice:3` */
export function sliceCondition(sliceIndex: number): string {
  return `pool-slice:${sliceIndex}`;
}

/** fully-qualified corpus deck id (matches buildCorpus's restricted prefixing) */
export function sliceCorpusDeckId(sliceIndex: number, deckId: string): string {
  return `${sliceCondition(sliceIndex)}:${deckId}`;
}

// ---- slice construction ----

/**
 * The seeded random 50% slice: each pool identity is drawn independently with
 * p = SLICE_DRAW_P. Identities are iterated in ascending id order so the RNG
 * consumption — and therefore the slice — is fully deterministic per seed.
 */
export function buildPoolSlice(
  fullPool: LegalPool,
  sliceIndex: number,
  seedBase = SLICE_SEED_BASE,
): LegalPool {
  const rng = mulberry32(sliceSeed(sliceIndex, seedBase));
  const slice = new Map<number, PoolEntry>();
  for (const id of [...fullPool.keys()].sort((a, b) => a - b)) {
    if (rng() < SLICE_DRAW_P) slice.set(id, fullPool.get(id)!);
  }
  return slice;
}

/** a 50% draw's size check against the binomial ±sigma band */
export function sliceSizeWithinTolerance(
  poolSize: number,
  sliceSize: number,
  sigma = SLICE_SIZE_SIGMA,
): boolean {
  const expected = poolSize * SLICE_DRAW_P;
  const sd = Math.sqrt(poolSize * SLICE_DRAW_P * (1 - SLICE_DRAW_P));
  return Math.abs(sliceSize - expected) <= sigma * sd;
}

// ---- per-slice run ----

export type SliceDropReason = 'slice-failed';

export interface SliceStats {
  sliceIndex: number;
  condition: string;
  seed: number;
  /** legal identities drawn into the slice (recorded per the pre-committed scope) */
  poolSize: number;
  /** poolSize × p — the draw's expected size, for the tolerance check */
  expectedPoolSize: number;
  sizeWithinTolerance: boolean;
  /** candidates the search evaluated (generations × population) */
  candidatesEvaluated: number;
  /** games simulated for this slice's candidates */
  games: number;
  /** archive cells the search occupied */
  cells: number;
  /** retained cells above the threshold */
  cellsPassingThreshold: number;
  /** distinct evaluated decks above the threshold */
  passingDecks: number;
  dropped: boolean;
  reason?: SliceDropReason;
  /** set for 'slice-failed': the underlying error */
  error?: string;
}

export interface SliceDeckCandidate {
  stratum: 'pool-slice';
  sliceIndex: number;
  /** corpus condition tag, `pool-slice:<i>` */
  condition: string;
  /** slice-local deck id, `gen-<g>-cand-<c>` */
  deckId: string;
  deck: Record<string, number>;
  fitness: number;
}

export interface SliceRun {
  stats: SliceStats;
  /** threshold-passing decks (empty when the slice dropped) */
  decks: SliceDeckCandidate[];
}

interface EvaluatedDeck {
  generation: number;
  index: number;
  deck: Record<string, number>;
  fitness: number;
  games: number;
}

export interface RunSliceOptions {
  sliceIndex: number;
  fullPool: LegalPool;
  cards: readonly Card[];
  league: League;
  seedBase: number;
  generations?: number;
  population?: number;
  gamesPerMember?: number;
  threshold?: number;
  evaluate: CandidateEvaluator;
  /** per-slice archive persistence (the league file is never written) */
  archivePath?: string;
}

/**
 * Run one pool slice through the map-elites loop core with the sliced pool.
 * The caller's league is never mutated (promotions stay inside the search's
 * in-memory copy and are not persisted). Returns the slice's honest stats
 * plus its threshold-passing decks. Fail-soft: a thrown search is recorded as
 * an honest 'slice-failed' drop, never propagated.
 */
export async function runSlicePool(opts: RunSliceOptions): Promise<SliceRun> {
  const generations = opts.generations ?? SLICE_GENERATIONS;
  const population = opts.population ?? SLICE_POPULATION;
  const gamesPerMember = opts.gamesPerMember ?? SLICE_GAMES_PER_MEMBER;
  const threshold = opts.threshold ?? SLICE_MIN_FITNESS;
  const pool = buildPoolSlice(opts.fullPool, opts.sliceIndex, opts.seedBase);
  const seed = sliceSeed(opts.sliceIndex, opts.seedBase);
  const baseStats = {
    sliceIndex: opts.sliceIndex,
    condition: sliceCondition(opts.sliceIndex),
    seed,
    poolSize: pool.size,
    expectedPoolSize: opts.fullPool.size * SLICE_DRAW_P,
    sizeWithinTolerance: sliceSizeWithinTolerance(
      opts.fullPool.size,
      pool.size,
    ),
  };

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
            `(slice ${opts.sliceIndex}, generation ${generation})`,
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
      masterSeed: seed,
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
    // one broken slice must not sink the slices behind it — record the
    // coverage honestly (AGENTS.md fail-soft rule)
    return {
      stats: {
        ...baseStats,
        candidatesEvaluated: evaluated.length,
        games: 0,
        cells: 0,
        cellsPassingThreshold: 0,
        passingDecks: 0,
        dropped: true,
        reason: 'slice-failed',
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
  const decks: SliceDeckCandidate[] = [];
  for (const entry of passing) {
    const key = stableDeckKey(entry.deck);
    if (seen.has(key)) continue;
    seen.add(key);
    decks.push({
      stratum: 'pool-slice',
      sliceIndex: opts.sliceIndex,
      condition: sliceCondition(opts.sliceIndex),
      deckId: `gen-${entry.generation}-cand-${entry.index}`,
      deck: entry.deck,
      fitness: entry.fitness,
    });
  }

  return {
    stats: {
      ...baseStats,
      candidatesEvaluated: evaluated.length,
      games: result.totals.games,
      cells: cells.length,
      cellsPassingThreshold: cellsPassing.length,
      passingDecks: decks.length,
      dropped: false,
    },
    decks,
  };
}

/** run the slices sequentially; every slice's stats are recorded */
export async function runSlices(opts: {
  sliceCount: number;
  fullPool: LegalPool;
  cards: readonly Card[];
  league: League;
  seedBase: number;
  generations?: number;
  population?: number;
  gamesPerMember?: number;
  threshold?: number;
  evaluate: (sliceIndex: number) => CandidateEvaluator;
  archivePathFor?: (sliceIndex: number) => string | undefined;
}): Promise<SliceRun[]> {
  const runs: SliceRun[] = [];
  for (let sliceIndex = 0; sliceIndex < opts.sliceCount; sliceIndex++) {
    try {
      runs.push(
        await runSlicePool({
          sliceIndex,
          fullPool: opts.fullPool,
          cards: opts.cards,
          league: opts.league,
          seedBase: opts.seedBase,
          generations: opts.generations,
          population: opts.population,
          gamesPerMember: opts.gamesPerMember,
          threshold: opts.threshold,
          evaluate: opts.evaluate(sliceIndex),
          ...(opts.archivePathFor
            ? { archivePath: opts.archivePathFor(sliceIndex) }
            : {}),
        }),
      );
    } catch (error) {
      // belt-and-braces: runSlicePool is already fail-soft, but an unexpected
      // throw (e.g. an archive write failure) must not sink the remaining
      // slices either
      runs.push({
        stats: {
          sliceIndex,
          condition: sliceCondition(sliceIndex),
          seed: sliceSeed(sliceIndex, opts.seedBase),
          poolSize: 0,
          expectedPoolSize: 0,
          sizeWithinTolerance: false,
          candidatesEvaluated: 0,
          games: 0,
          cells: 0,
          cellsPassingThreshold: 0,
          passingDecks: 0,
          dropped: true,
          reason: 'slice-failed',
          error: error instanceof Error ? error.message : String(error),
        },
        decks: [],
      });
    }
  }
  return runs;
}

// ---- corpus-pair cap (D1c ~25%) ----

/**
 * Corpus pairs one imitation deck yields under corpus.ts's masking rule:
 * samplesPerDeck samples × min(REGIONS_PER_SAMPLE, ⌊cards/8⌋) regions (a
 * deck below MIN_REGION_CARDS yields none). Mirrors maskDeckIntoPairs's
 * region count without duplicating its RNG — the orchestrator recomputes
 * the cap share from the built corpus.
 */
export function estimatePairsPerDeck(
  deck: Record<string, number>,
  samplesPerDeck = SAMPLES_PER_DECK,
): number {
  let total = 0;
  for (const count of Object.values(deck)) {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`malformed deck entry (count ${count})`);
    }
    total += count;
  }
  if (total < MIN_REGION_CARDS) return 0;
  const regions = Math.min(
    REGIONS_PER_SAMPLE,
    Math.floor(total / MIN_REGION_CARDS),
  );
  return samplesPerDeck * regions;
}

export interface SliceCapDeck {
  /** fully-qualified corpus deck id, `pool-slice:<i>:<deckId>` */
  corpusDeckId: string;
  sliceIndex: number;
  deckId: string;
  fitness: number;
  /** corpus pairs this deck contributes (estimatePairsPerDeck) */
  pairs: number;
}

export interface SliceCapResult {
  cap: number;
  /** slicePairs / (slicePairs + otherPairs) before enforcement */
  shareBefore: number;
  /** share after enforcement (≤ cap when enforced) */
  shareAfter: number;
  slicePairsBefore: number;
  slicePairsAfter: number;
  otherPairs: number;
  enforced: boolean;
  /** surviving decks, in the caller's order */
  kept: SliceCapDeck[];
  /** dropped decks in drop order (lowest fitness first, ties deterministic) */
  dropped: Array<Pick<SliceCapDeck, 'corpusDeckId' | 'fitness' | 'pairs'>>;
}

export function slicePairShare(slicePairs: number, otherPairs: number): number {
  const total = slicePairs + otherPairs;
  return total === 0 ? 0 : slicePairs / total;
}

/**
 * Enforce the pre-committed slice-pair cap: while the slice share exceeds
 * `cap`, drop the lowest-fitness slice deck (ties → lower slice index, then
 * lexicographic deckId) and recompute. Pure and deterministic — the input
 * order never affects the outcome.
 */
export function enforceSlicePairCap(
  decks: SliceCapDeck[],
  otherPairs: number,
  cap = SLICE_PAIR_CAP,
): SliceCapResult {
  if (!(cap > 0 && cap <= 1)) {
    throw new Error(`cap must be in (0, 1] (got ${cap})`);
  }
  const dropOrder = [...decks].sort(
    (a, b) =>
      a.fitness - b.fitness ||
      a.sliceIndex - b.sliceIndex ||
      (a.deckId < b.deckId ? -1 : a.deckId > b.deckId ? 1 : 0),
  );
  const slicePairsBefore = decks.reduce((sum, deck) => sum + deck.pairs, 0);
  const shareBefore = slicePairShare(slicePairsBefore, otherPairs);
  const droppedIds = new Set<string>();
  const dropped: SliceCapResult['dropped'] = [];
  let slicePairs = slicePairsBefore;
  if (shareBefore > cap) {
    for (const deck of dropOrder) {
      if (slicePairShare(slicePairs, otherPairs) <= cap) break;
      droppedIds.add(deck.corpusDeckId);
      slicePairs -= deck.pairs;
      dropped.push({
        corpusDeckId: deck.corpusDeckId,
        fitness: deck.fitness,
        pairs: deck.pairs,
      });
    }
  }
  return {
    cap,
    shareBefore,
    shareAfter: slicePairShare(slicePairs, otherPairs),
    slicePairsBefore,
    slicePairsAfter: slicePairs,
    otherPairs,
    enforced: dropped.length > 0,
    kept: decks.filter((deck) => !droppedIds.has(deck.corpusDeckId)),
    dropped,
  };
}

// ---- corpus pair counting (cap inputs from the on-disk strata) ----

export interface CorpusStrataCounts {
  byStratum: Record<CorpusStratum, number>;
  /** restricted pairs whose condition is a slice condition (`pool-slice:*`) */
  poolSlicePairs: number;
}

function emptyStrataCounts(): CorpusStrataCounts {
  return {
    byStratum: Object.fromEntries(
      STRATUM_ORDER.map((stratum) => [stratum, 0]),
    ) as Record<CorpusStratum, number>,
    poolSlicePairs: 0,
  };
}

function isSliceCondition(condition: unknown): boolean {
  return typeof condition === 'string' && condition.startsWith('pool-slice:');
}

/** count a corpus artifact's pairs per stratum (slice pairs carved out) */
export function countCorpusStrata(corpus: {
  pairs: Array<{ stratum: string; condition?: unknown }>;
}): CorpusStrataCounts {
  const counts = emptyStrataCounts();
  for (const pair of corpus.pairs) {
    if (!(STRATUM_ORDER as readonly string[]).includes(pair.stratum)) {
      throw new Error(`corpus carries unknown stratum: ${pair.stratum}`);
    }
    counts.byStratum[pair.stratum as CorpusStratum]++;
    if (pair.stratum === 'pool-slice') {
      counts.poolSlicePairs++;
    } else if (
      pair.stratum === 'restricted' &&
      isSliceCondition(pair.condition)
    ) {
      counts.poolSlicePairs++;
    }
  }
  return counts;
}

/**
 * Fold corpus artifacts into one per-stratum count: per stratum, the maximum
 * across files. The artifacts are overlapping cumulative rebuilds (a later
 * rebuild may not carry an earlier stratum — e.g. the restricted rebuild has
 * no substitution deltas), so "newest file wins" would erase strata a file
 * merely did not measure; the max is the best-known count per stratum. Slice
 * pairs are carved out of the restricted count so `otherPairs` never
 * includes them.
 */
export function foldCorpusStrata(
  counts: CorpusStrataCounts[],
): CorpusStrataCounts {
  const folded = emptyStrataCounts();
  for (const entry of counts) {
    for (const stratum of STRATUM_ORDER) {
      folded.byStratum[stratum] = Math.max(
        folded.byStratum[stratum],
        entry.byStratum[stratum],
      );
    }
    folded.poolSlicePairs = Math.max(
      folded.poolSlicePairs,
      entry.poolSlicePairs,
    );
  }
  return folded;
}

// ---- CLI ----

export interface SliceDeckFile {
  format: string;
  engineCommit: string;
  stratum: 'pool-slice';
  sliceIndex: number;
  condition: string;
  seed: number;
  poolSize: number;
  threshold: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  referee: string;
  dropped: boolean;
  reason?: SliceDropReason;
  error?: string;
  decks: Array<{
    deckId: string;
    deck: Record<string, number>;
    fitness: number;
  }>;
}

export interface SlicesRunReport {
  stratum: 'pool-slice';
  engineCommit: string;
  sliceCount: number;
  seedBase: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  threshold: number;
  referee: string;
  slices: SliceStats[];
  /** post-cap surviving decks — the final build's pool-slice candidates */
  decks: Array<SliceDeckCandidate & { corpusDeckId: string; pairs: number }>;
  totals: {
    slicesRun: number;
    slicesDropped: number;
    candidatesEvaluated: number;
    games: number;
    passingDecks: number;
    decksAfterCap: number;
    decksDroppedByCap: number;
  };
  capResult: SliceCapResult;
  capInputs: {
    corpusFiles: string[];
    strataCounts: Record<CorpusStratum, number>;
    /** every corpus pair that is not a slice pair */
    otherPairs: number;
  };
  wallMs: number;
}

interface SlicesArgs {
  leaguePath: string;
  corpusPaths: string[];
  seedBase: number;
  sliceCount: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  batchSize: number;
  parallel: number;
  threshold: number;
  cap: number;
  outDir: string;
}

const DEFAULT_OUT_DIR = resolve(import.meta.dirname, '..', 'data', 'generator');

function parseSlicesArgs(argv: string[]): SlicesArgs {
  const corpusPaths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') corpusPaths.push(resolve(argv[++i]!));
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const leaguePath = get('--league') ? resolve(get('--league')!) : '';
  if (!leaguePath) throw new Error('--league <file> is required');
  for (const path of corpusPaths) {
    statSync(path);
  }
  return {
    leaguePath,
    corpusPaths: [...corpusPaths].sort(
      (a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs,
    ),
    seedBase: Number(get('--seed-base') ?? SLICE_SEED_BASE),
    sliceCount: Number(get('--slices') ?? SLICE_COUNT),
    generations: Number(get('--generations') ?? SLICE_GENERATIONS),
    population: Number(get('--population') ?? SLICE_POPULATION),
    gamesPerMember: Number(get('--games-per-member') ?? SLICE_GAMES_PER_MEMBER),
    batchSize: Number(get('--batch-size') ?? SLICE_BATCH_SIZE),
    parallel: Math.max(1, Number(get('--parallel') ?? SLICE_PARALLEL)),
    threshold: Number(get('--threshold') ?? SLICE_MIN_FITNESS),
    cap: Number(get('--cap') ?? SLICE_PAIR_CAP),
    outDir: get('--out-dir') ? resolve(get('--out-dir')!) : DEFAULT_OUT_DIR,
  };
}

export async function runSlicesCli(args: SlicesArgs): Promise<SlicesRunReport> {
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

  const slicesDir = resolve(args.outDir, 'slices');
  const started = Date.now();
  const runs = await runSlices({
    sliceCount: args.sliceCount,
    fullPool,
    cards,
    league,
    seedBase: args.seedBase,
    generations: args.generations,
    population: args.population,
    gamesPerMember: args.gamesPerMember,
    threshold: args.threshold,
    archivePathFor: (sliceIndex) =>
      resolve(slicesDir, `slice-${sliceIndex}.archive.json`),
    evaluate: (sliceIndex) => {
      const masterSeed = sliceSeed(sliceIndex, args.seedBase);
      return async (candidates, sliceLeague, generation) => {
        // single-candidate chunks: the slice league snapshot (with the run's
        // in-memory promotions) rides along; twin mode stays off
        const requests: EvalChunkRequest[] = candidates.map((candidate) => ({
          index: candidate.index,
          deck: candidate.deck,
          parentDeck: candidate.deck,
          league: sliceLeague,
          masterSeed,
          gamesPerMember: args.gamesPerMember,
          batchSize: args.batchSize,
          referee: DEFAULT_REFEREE,
          twinPaired: false,
        }));
        const parts = await evaluateChunks(requests, {
          parallel: args.parallel,
          workDir: args.outDir,
          label: `slices-slice-${sliceIndex}-gen${generation}`,
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

  // per-slice deck files: the raw threshold-passers the final build consumes
  mkdirSync(slicesDir, { recursive: true });
  for (const run of runs) {
    const deckFile: SliceDeckFile = {
      format: league.format,
      engineCommit: league.engineCommit,
      stratum: 'pool-slice',
      sliceIndex: run.stats.sliceIndex,
      condition: run.stats.condition,
      seed: run.stats.seed,
      poolSize: run.stats.poolSize,
      threshold: args.threshold,
      generations: args.generations,
      population: args.population,
      gamesPerMember: args.gamesPerMember,
      referee: DEFAULT_REFEREE,
      dropped: run.stats.dropped,
      ...(run.stats.reason ? { reason: run.stats.reason } : {}),
      ...(run.stats.error ? { error: run.stats.error } : {}),
      decks: run.decks.map(({ deckId, deck, fitness }) => ({
        deckId,
        deck,
        fitness,
      })),
    };
    const deckPath = resolve(
      slicesDir,
      `slice-${run.stats.sliceIndex}.decks.json`,
    );
    writeFileSync(deckPath, `${stableStringify(deckFile)}\n`);
  }

  // cap inputs: fold the corpus strata (later files override per stratum)
  // and carve out slice pairs already in the corpora (none on a first build)
  const strataCounts = foldCorpusStrata(
    args.corpusPaths.map((path) =>
      countCorpusStrata(
        JSON.parse(readFileSync(path, 'utf8')) as {
          pairs: Array<{ stratum: string; condition?: unknown }>;
        },
      ),
    ),
  );
  const totalCorpusPairs = STRATUM_ORDER.reduce(
    (sum, stratum) => sum + strataCounts.byStratum[stratum],
    0,
  );
  const otherPairs = totalCorpusPairs - strataCounts.poolSlicePairs;

  const capInputsDecks: Array<[SliceCapDeck, SliceDeckCandidate]> =
    runs.flatMap((run) =>
      run.decks.map((deck) => {
        const capDeck: SliceCapDeck = {
          corpusDeckId: sliceCorpusDeckId(deck.sliceIndex, deck.deckId),
          sliceIndex: deck.sliceIndex,
          deckId: deck.deckId,
          fitness: deck.fitness,
          pairs: estimatePairsPerDeck(deck.deck),
        };
        return [capDeck, deck] as [SliceCapDeck, SliceDeckCandidate];
      }),
    );
  const capDecks = capInputsDecks.map(([capDeck]) => capDeck);
  const candidateByCorpusId = new Map(
    capInputsDecks.map(([capDeck, deck]) => [capDeck.corpusDeckId, deck]),
  );
  const capResult = enforceSlicePairCap(capDecks, otherPairs, args.cap);

  const report: SlicesRunReport = {
    stratum: 'pool-slice',
    engineCommit: league.engineCommit,
    sliceCount: args.sliceCount,
    seedBase: args.seedBase,
    generations: args.generations,
    population: args.population,
    gamesPerMember: args.gamesPerMember,
    threshold: args.threshold,
    referee: DEFAULT_REFEREE,
    slices: runs.map((run) => run.stats),
    decks: capResult.kept.map((kept) => {
      const candidate = candidateByCorpusId.get(kept.corpusDeckId)!;
      return {
        ...candidate,
        corpusDeckId: kept.corpusDeckId,
        pairs: kept.pairs,
      };
    }),
    totals: {
      slicesRun: runs.length,
      slicesDropped: runs.filter((run) => run.stats.dropped).length,
      candidatesEvaluated: runs.reduce(
        (sum, run) => sum + run.stats.candidatesEvaluated,
        0,
      ),
      games: runs.reduce((sum, run) => sum + run.stats.games, 0),
      passingDecks: runs.reduce((sum, run) => sum + run.stats.passingDecks, 0),
      decksAfterCap: capResult.kept.length,
      decksDroppedByCap: capResult.dropped.length,
    },
    capResult,
    capInputs: {
      corpusFiles: args.corpusPaths,
      strataCounts: strataCounts.byStratum,
      otherPairs,
    },
    wallMs,
  };
  const reportPath = resolve(
    args.outDir,
    `slices-${league.engineCommit.slice(0, 8)}.json`,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

async function main(): Promise<void> {
  const report = await runSlicesCli(parseSlicesArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 1));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
