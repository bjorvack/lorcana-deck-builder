/**
 * Pool coverage guarantee (learned-deck-generator, task 1.6; design D1b).
 *
 * Two guarantees, both pre-committed:
 *
 *  1. **Widening** — a restricted pool dropped as thin (below
 *     RESTRICTED_MIN_POOL_IDENTITIES) is not left dead: a franchise pool
 *     widens to franchise ∪ (self-play pool restricted to the franchise's 2
 *     most-represented inks, tallied over the pool's franchise cards); if the
 *     widened pool is still thin it widens to the full self-play pool.
 *     Original + widened sizes are recorded and the pool re-runs with the
 *     SAME pre-committed search budget as task 1.5, poolIndex numbering
 *     continuing after the original pools. Surviving decks feed the
 *     restricted stratum under a `+widened` conditioning suffix so a widened
 *     search's decks stay distinguishable from a pure franchise pool's.
 *  2. **Coverage sweep** — identities of the legal self-play pool that appear
 *     in ZERO corpus pairs are batched into forced-inclusion seed decks
 *     (~20 unseen cards/deck + seeded legal filler to 60, ink-coherent
 *     grouping so ≤ 2 declared inks stays satisfiable), ≤ 150 decks. Each
 *     deck is league-evaluated (heuristic referee, paired seeds, arena disk
 *     cache) against the real held-out league members only and enters the
 *     corpus in a distinct `coverage` stratum with its measured fitness —
 *     legality is the only gate, no fitness threshold (COVERAGE_TRAIN_WEIGHT
 *     keeps the long tail from outweighing gated evidence).
 *
 * The corpus reports pool-coverage % (identities in ≥1 pair / pool size) and
 * a per-identity occurrence histogram; the CLI asserts coverage ≥
 * COVERAGE_MIN_SHARE after the sweep and reports the exact number either way.
 *
 * Determinism: mulberry32 seeded per (master seed, deck index); grouping and
 * ordering are key-sorted; no Math.random in training paths.
 *
 * Usage (detached, resumable — the arena cache serves completed games):
 *   npx tsx scripts/training/generator/coverage.ts \
 *     --league <league.json> --archive <archive.json> [--archive ...] \
 *     [--restricted-report <report.json>] [--deltas-report <report.json>] \
 *     [--parallel 3] [--out <corpus.json>] [--report-out <report.json>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../../src/data/types';
import type { CandidateEvaluator } from '../arena/map-elites';
import {
  elitesDeckProblems,
  type LegalPool,
} from '../arena/map-elites-mutation';
import { DEFAULT_REFEREE } from '../arena/schedule';
import { mulberry32 } from '../prng';
import { type EvalChunkRequest, evaluateChunks } from './chunk-eval';
import {
  buildCorpus,
  COVERAGE_TRAIN_WEIGHT,
  type CorpusPair,
  type CorpusStats,
  type CorpusStratum,
  type CoverageDeckInput,
  collectDeckSources,
  type FitnessSummary,
  fitnessSummary,
  loadCorpusArchive,
  RESTRICTED_MIN_FITNESS,
  type RestrictedDeckInput,
  type StratumStats,
  type SubstitutionDeltaInput,
  stableStringify,
} from './corpus';
import {
  RESTRICTED_GAMES_PER_MEMBER,
  RESTRICTED_GENERATIONS,
  RESTRICTED_MIN_POOL_IDENTITIES,
  RESTRICTED_POOLS,
  RESTRICTED_POPULATION,
  RESTRICTED_SEED_BASE,
  type RestrictedPoolSpec,
  type RestrictedRunReport,
  runRestrictedPool,
} from './restricted';

// ---- pre-committed sweep parameters (task 1.6 / D1b) ----

/** unseen identities forced into one sweep deck */
export const SWEEP_UNSEEN_PER_DECK = 20;
/** sweep decks are full legal decks */
export const SWEEP_DECK_SIZE = 60;
/** hard budget cap: at most this many sweep decks */
export const SWEEP_MAX_DECKS = 150;
/** evaluation: the real held-out league members, 8 games each */
export const SWEEP_GAMES_PER_MEMBER = 8;
export const SWEEP_BATCH_SIZE = 8;
export const SWEEP_PARALLEL = 3;
/**
 * Sweep master seed: continues the restricted pool numbering (poolIndex
 * 0..4 consumed seeds 20261123..20261127; widened pools take 20261128+).
 */
export const SWEEP_MASTER_SEED = 20261130;
/** pool coverage that the corpus must reach after the sweep */
export const COVERAGE_MIN_SHARE = 0.99;

// ---- widening rule ----

/**
 * The 2 most-represented inks among the franchise's pool identities: ink
 * membership tallied per card, sorted by count desc then ink asc. Null when
 * the franchise's pool cards span fewer than 2 inks.
 */
export function topFranchiseInks(
  pool: LegalPool,
  franchise: string,
  cardsById: Map<number, Card>,
): string[] | null {
  const tally = new Map<string, number>();
  for (const [id, entry] of pool) {
    const card = cardsById.get(id);
    if (!card || card.franchise !== franchise) continue;
    for (const ink of entry.inks) tally.set(ink, (tally.get(ink) ?? 0) + 1);
  }
  const top = [...tally.entries()]
    .sort(
      ([a, countA], [b, countB]) =>
        countB - countA || (a < b ? -1 : a > b ? 1 : 0),
    )
    .slice(0, 2)
    .map(([ink]) => ink)
    .sort();
  return top.length === 2 ? top : null;
}

export interface WidenedPool {
  /** the pool to search (widened, or the full pool on fallback) */
  pool: LegalPool;
  /** legal identities of the declared (unwidened) pool */
  originalSize: number;
  /** legal identities actually searched */
  widenedSize: number;
  /** the franchise's 2 most-represented inks (null for ink-kind pools) */
  inkPair: string[] | null;
  /** widened still below the floor → the full self-play pool was used */
  fellBackToFullPool: boolean;
}

/**
 * Task 1.6 widening: franchise pool ∪ (full pool ∩ the franchise's 2
 * most-represented inks); if still below the searchable floor, the full
 * self-play pool. Ink-kind pools have no franchise to tally — they fall
 * straight to the full pool when thin.
 */
export function widenRestrictedPool(opts: {
  spec: RestrictedPoolSpec;
  fullPool: LegalPool;
  cards: readonly Card[];
  minIdentities?: number;
}): WidenedPool {
  const minIdentities = opts.minIdentities ?? RESTRICTED_MIN_POOL_IDENTITIES;
  const cardsById = new Map(opts.cards.map((card) => [card.id, card]));
  const original = new Map<number, { maxCopies: number; inks: string[] }>();
  for (const [id, entry] of opts.fullPool) {
    if (opts.spec.kind === 'franchise') {
      const card = cardsById.get(id);
      if (!card || card.franchise !== opts.spec.franchise) continue;
    } else if (!entry.inks.every((ink) => opts.spec.inks?.includes(ink))) {
      continue;
    }
    original.set(id, entry);
  }
  const inkPair =
    opts.spec.kind === 'franchise'
      ? topFranchiseInks(opts.fullPool, opts.spec.franchise!, cardsById)
      : null;
  const widened = new Map(original);
  if (inkPair) {
    for (const [id, entry] of opts.fullPool) {
      if (entry.inks.every((ink) => inkPair.includes(ink))) {
        widened.set(id, entry);
      }
    }
  }
  if (widened.size < minIdentities) {
    return {
      pool: opts.fullPool,
      originalSize: original.size,
      widenedSize: opts.fullPool.size,
      inkPair,
      fellBackToFullPool: true,
    };
  }
  return {
    pool: widened,
    originalSize: original.size,
    widenedSize: widened.size,
    inkPair,
    fellBackToFullPool: false,
  };
}

// ---- unseen detection + histogram ----

/** identity ids a pair mentions (seed/target keys, or delta endpoints) */
export function pairMentionedIdentities(pair: CorpusPair): string[] {
  if (pair.stratum === 'substitution-delta') {
    return [...Object.keys(pair.context), pair.cardOut, pair.cardIn];
  }
  return [...Object.keys(pair.seed), ...Object.keys(pair.target)];
}

/** per-identity occurrence count: the number of pairs mentioning it */
export function identityOccurrences(
  pairs: readonly CorpusPair[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    for (const id of new Set(pairMentionedIdentities(pair))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Pool identities appearing in ZERO corpus pairs — the sweep's input.
 * Deterministic: ascending numeric order.
 */
export function unseenIdentities(
  poolIds: readonly number[],
  pairs: readonly CorpusPair[],
): number[] {
  const mentioned = new Set<string>();
  for (const pair of pairs) {
    for (const id of pairMentionedIdentities(pair)) mentioned.add(id);
  }
  return [...poolIds]
    .filter((id) => !mentioned.has(String(id)))
    .sort((a, b) => a - b);
}

export interface CoverageHistogram {
  /** identities in the legal self-play pool */
  poolSize: number;
  /** pool identities appearing in ≥1 pair */
  seen: number;
  /** the headline pool-coverage number: seen / poolSize */
  shareSeen: number;
  /** pool identities appearing in ≥3 pairs (D1b: targeted where budget allows) */
  atLeast3: number;
  shareAtLeast3: number;
  meanOccurrences: number;
  maxOccurrences: number;
  /** exact occurrence value → number of pool identities with that count */
  counts: Record<string, number>;
  /** pool identities with zero pairs (empty after a complete sweep) */
  unseen: number[];
}

export function coverageHistogram(
  occurrences: Map<string, number>,
  poolIds: readonly number[],
): CoverageHistogram {
  const counts: Record<string, number> = {};
  let seen = 0;
  let atLeast3 = 0;
  let total = 0;
  let max = 0;
  const unseen: number[] = [];
  for (const id of [...poolIds].sort((a, b) => a - b)) {
    const count = occurrences.get(String(id)) ?? 0;
    if (count === 0) {
      unseen.push(id);
      continue;
    }
    seen++;
    if (count >= 3) atLeast3++;
    total += count;
    max = Math.max(max, count);
    counts[String(count)] = (counts[String(count)] ?? 0) + 1;
  }
  const poolSize = poolIds.length;
  return {
    poolSize,
    seen,
    shareSeen: poolSize === 0 ? 1 : seen / poolSize,
    atLeast3,
    shareAtLeast3: poolSize === 0 ? 1 : atLeast3 / poolSize,
    meanOccurrences: seen === 0 ? 0 : total / seen,
    maxOccurrences: max,
    counts,
    unseen,
  };
}

// ---- sweep deck planning ----

/** per-(master seed, deck index) RNG seed — deltas.deltaSeedFor's text-hash pattern */
export function coverageSeedFor(masterSeed: number, deckIndex: number): number {
  const text = `${masterSeed}:coverage#${deckIndex}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** strictest copy limit across the pool cards sharing a print group */
function groupLimits(
  pool: LegalPool,
  cardsById: Map<number, Card>,
): Map<string, number> {
  const limits = new Map<string, number>();
  for (const [id, entry] of pool) {
    const card = cardsById.get(id);
    if (!card) continue;
    const current = limits.get(card.groupKey);
    limits.set(
      card.groupKey,
      current === undefined
        ? entry.maxCopies
        : Math.min(current, entry.maxCopies),
    );
  }
  return limits;
}

export interface PlannedSweepDeck {
  index: number;
  /** forced-included unseen identities (1 copy each) */
  forced: number[];
  /** the deck's declared inks (the forced group's ink signature) */
  inks: string[];
  deck: Record<string, number>;
}

export interface SweepPlan {
  decks: PlannedSweepDeck[];
  /** identities left out because the deck cap was hit */
  truncated: number[];
  /** identities that never fit any deck (cross-print limit conflicts) */
  unplaced: number[];
}

/**
 * Batch unseen identities into forced-inclusion seed decks. Identities are
 * grouped by ink signature (≤ 2 inks each) so a deck's forced cards share a
 * declared ink pair; a group larger than a deck spills into the next deck.
 * An identity whose print group is already at its cross-print limit is
 * carried into the next deck. Filler to 60 cards is a seeded draw from the
 * pool restricted to the deck's inks, respecting identity and print-group
 * limits. Every deck must clear elitesDeckProblems — legality is the only
 * gate, and a violation here is a planner bug, so it throws.
 */
export function planSweepDecks(opts: {
  unseen: readonly number[];
  pool: LegalPool;
  cards: readonly Card[];
  masterSeed: number;
  unseenPerDeck?: number;
  deckSize?: number;
  maxDecks?: number;
}): SweepPlan {
  const unseenPerDeck = opts.unseenPerDeck ?? SWEEP_UNSEEN_PER_DECK;
  const deckSize = opts.deckSize ?? SWEEP_DECK_SIZE;
  const maxDecks = opts.maxDecks ?? SWEEP_MAX_DECKS;
  const cardsById = new Map(opts.cards.map((card) => [card.id, card]));
  const limits = groupLimits(opts.pool, cardsById);

  // group by ink signature: decks stay ink-coherent (≤ 2 declared inks)
  const bySignature = new Map<string, number[]>();
  for (const id of [...opts.unseen].sort((a, b) => a - b)) {
    const entry = opts.pool.get(id);
    if (!entry) {
      throw new Error(`unseen identity ${id} is not in the legal pool`);
    }
    const signature = [...entry.inks].sort().join('+');
    const group = bySignature.get(signature) ?? [];
    group.push(id);
    bySignature.set(signature, group);
  }
  const signatures = [...bySignature.keys()].sort();

  const decks: PlannedSweepDeck[] = [];
  const unplaced: number[] = [];
  const truncated: number[] = [];
  let carry: number[] = [];
  let index = 0;
  for (const signature of signatures) {
    let queue = [...bySignature.get(signature)!];
    while (queue.length > 0) {
      if (decks.length >= maxDecks) {
        truncated.push(...carry, ...queue);
        carry = [];
        queue = [];
        break;
      }
      const inks = signature.split('+');
      const forced: number[] = [];
      const groupCount = new Map<string, number>();
      const deferred: number[] = [];
      for (const id of [...carry, ...queue]) {
        if (forced.length >= unseenPerDeck) {
          deferred.push(id);
          continue;
        }
        const card = cardsById.get(id)!;
        const used = groupCount.get(card.groupKey) ?? 0;
        if (used + 1 > (limits.get(card.groupKey) ?? 1)) {
          deferred.push(id);
          continue;
        }
        forced.push(id);
        groupCount.set(card.groupKey, used + 1);
      }
      if (forced.length === 0) {
        // every remaining identity of this signature is group-blocked in a
        // fresh deck — it can never be forced
        unplaced.push(...deferred);
        queue = [];
        carry = [];
        break;
      }
      const filled = fillSweepDeck({
        forced,
        inks,
        index,
        pool: opts.pool,
        cardsById,
        limits,
        masterSeed: opts.masterSeed,
        deckSize,
      });
      // legality is the only gate for sweep decks — a violation here is a
      // planner bug, never a deck to drop
      const problems = elitesDeckProblems(filled, opts.pool, opts.cards);
      if (problems.length > 0) {
        throw new Error(
          `sweep deck ${index} is illegal (${problems.join(', ')}) — planner bug`,
        );
      }
      decks.push({
        index,
        forced,
        inks,
        deck: filled,
      });
      index++;
      carry = [];
      queue = deferred;
    }
  }
  unplaced.push(...carry);
  return { decks, truncated, unplaced };
}

/** forced inclusions + seeded ink-legal filler to a full 60-card deck */
function fillSweepDeck(opts: {
  forced: readonly number[];
  inks: string[];
  index: number;
  pool: LegalPool;
  cardsById: Map<number, Card>;
  limits: Map<string, number>;
  masterSeed: number;
  deckSize: number;
}): Record<string, number> {
  const deck: Record<string, number> = {};
  const groupCount = new Map<string, number>();
  let total = 0;
  const addCopy = (id: number): boolean => {
    const entry = opts.pool.get(id);
    if (!entry) return false;
    if ((deck[String(id)] ?? 0) + 1 > entry.maxCopies) return false;
    const card = opts.cardsById.get(id)!;
    const used = groupCount.get(card.groupKey) ?? 0;
    if (used + 1 > (opts.limits.get(card.groupKey) ?? 1)) return false;
    deck[String(id)] = (deck[String(id)] ?? 0) + 1;
    groupCount.set(card.groupKey, used + 1);
    total++;
    return true;
  };
  for (const id of opts.forced) addCopy(id);

  // filler: seeded shuffle over ink-legal pool identities. Untouched
  // identities fill first (distinct-identity coverage per deck), extra
  // copies of already-present identities only top up when needed.
  const inkLegal = [...opts.pool.keys()]
    .filter((id) => {
      const entry = opts.pool.get(id)!;
      return entry.inks.every((ink) => opts.inks.includes(ink));
    })
    .sort((a, b) => a - b);
  const fresh = inkLegal.filter((id) => (deck[String(id)] ?? 0) === 0);
  const capacity =
    fresh.reduce((sum, id) => sum + (opts.pool.get(id)?.maxCopies ?? 0), 0) +
    inkLegal.reduce(
      (sum, id) =>
        sum +
        Math.max(
          0,
          (opts.pool.get(id)?.maxCopies ?? 0) - (deck[String(id)] ?? 0),
        ),
      0,
    );
  if (capacity < opts.deckSize - total) {
    throw new Error(
      `sweep deck ${opts.index}: ink pair [${opts.inks.join(', ')}] has ` +
        `capacity ${capacity} for ${opts.deckSize - total} filler cards`,
    );
  }
  const rng = mulberry32(coverageSeedFor(opts.masterSeed, opts.index));
  const shuffled = (list: number[]): number[] => {
    const order = [...list];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    return order;
  };
  for (const candidates of [shuffled(fresh), shuffled(inkLegal)]) {
    while (total < opts.deckSize) {
      let added = 0;
      for (const id of candidates) {
        if (total >= opts.deckSize) break;
        if (addCopy(id)) added++;
      }
      if (added === 0) break;
    }
  }
  if (total < opts.deckSize) {
    throw new Error(
      `sweep deck ${opts.index}: filler exhausted at ${total}/${opts.deckSize} cards`,
    );
  }
  return deck;
}

// ---- prior-strata artifact loading ----

interface DeltasReportPair {
  deckId: string;
  cardOut: string;
  cardIn: string;
  delta: number;
}

interface DeltasReport {
  stratum: string;
  engineCommit: string;
  pairs: DeltasReportPair[];
}

function loadDeltasReport(filePath: string): DeltasReport {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as DeltasReport;
  if (raw.stratum !== 'substitution-delta' || !Array.isArray(raw.pairs)) {
    throw new Error(`${filePath} is not a substitution-delta report`);
  }
  for (const pair of raw.pairs) {
    if (
      typeof pair.deckId !== 'string' ||
      typeof pair.cardOut !== 'string' ||
      typeof pair.cardIn !== 'string' ||
      !Number.isFinite(pair.delta)
    ) {
      throw new Error(`${filePath} contains a malformed delta pair`);
    }
  }
  return raw;
}

/**
 * Rebuild the delta inputs from a deltas report: the report omits the
 * context deck, but context ≡ deck − one cardOut (the corpus builder
 * re-derives and re-checks exactly that), so it is reconstructed from the
 * corpus deck map.
 */
export function deltasFromReport(
  report: DeltasReport,
  decksById: Map<string, { deck: Record<string, number> }>,
): SubstitutionDeltaInput[] {
  return report.pairs.map((pair) => {
    const source = decksById.get(pair.deckId);
    if (!source) {
      throw new Error(
        `delta pair references unknown corpus deck ${pair.deckId}`,
      );
    }
    const outCount = source.deck[pair.cardOut];
    if (outCount === undefined || outCount < 1) {
      throw new Error(
        `delta pair ${pair.deckId}: cardOut ${pair.cardOut} is not in the deck`,
      );
    }
    const context: Record<string, number> = {};
    for (const [id, count] of Object.entries(source.deck)) {
      if (id === pair.cardOut) {
        if (count - 1 > 0) context[id] = count - 1;
      } else {
        context[id] = count;
      }
    }
    return {
      deckId: pair.deckId,
      context,
      cardOut: pair.cardOut,
      cardIn: pair.cardIn,
      delta: pair.delta,
    };
  });
}

/** the parts of a task-1.5 restricted report the widening step consumes */
export interface RestrictedReport {
  engineCommit: string;
  pools: RestrictedRunReport['pools'];
  decks: RestrictedDeckInput[];
}

export function loadRestrictedReport(filePath: string): RestrictedReport {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as RestrictedReport;
  if (raw.engineCommit === undefined || !Array.isArray(raw.pools)) {
    throw new Error(`${filePath} is not a restricted run report`);
  }
  for (const deck of raw.decks) {
    if (
      typeof deck.condition !== 'string' ||
      typeof deck.deckId !== 'string' ||
      typeof deck.deck !== 'object' ||
      deck.deck === null ||
      !Number.isFinite(deck.fitness)
    ) {
      throw new Error(`${filePath} contains a malformed restricted deck`);
    }
  }
  return raw;
}

// ---- report shape ----

export interface WidenedPoolReport {
  condition: string;
  originalCondition: string;
  slug: string;
  poolIndex: number;
  masterSeed: number;
  originalPoolSize: number;
  widenedPoolSize: number;
  inkPair: string[] | null;
  fellBackToFullPool: boolean;
  candidatesEvaluated: number;
  games: number;
  cells: number;
  cellsPassingThreshold: number;
  passingDecks: number;
  dropped: boolean;
  reason?: string;
  error?: string;
}

export interface SweepDeckRecord {
  deckId: string;
  forced: number;
  inks: string[];
  fitness: number;
  games: number;
}

export interface SweepReport {
  unseenBefore: number;
  decksPlanned: number;
  truncated: number;
  unplaced: number;
  unseenPerDeck: number;
  deckSize: number;
  maxDecks: number;
  masterSeed: number;
  gamesPerMember: number;
  referee: string;
  opponents: Array<{ id: string; kind: string }>;
  decks: SweepDeckRecord[];
  fitness: FitnessSummary;
  games: number;
  wallMs: number;
}

export interface PoolCoverageReport {
  poolSize: number;
  seen: number;
  /** identities in ≥1 pair / pool size — the headline number */
  shareSeen: number;
  atLeast3: number;
  shareAtLeast3: number;
  meanOccurrences: number;
  maxOccurrences: number;
  minShareRequired: number;
  passes: boolean;
  counts: Record<string, number>;
  unseenAfter: number[];
}

export interface CoverageRunReport {
  stratum: 'coverage';
  engineCommit: string;
  trainWeight: number;
  minPoolShare: number;
  threshold: number;
  referee: string;
  widening: WidenedPoolReport[];
  sweep: SweepReport;
  poolCoverage: PoolCoverageReport;
  strata: Record<CorpusStratum, StratumStats>;
  corpusOut: string;
  corpusStats: CorpusStats;
  wallMs: number;
}

// ---- CLI ----

export interface CoverageArgs {
  leaguePath: string;
  archivePaths: string[];
  restrictedReportPath: string;
  deltasReportPath: string;
  seedBase: number;
  generations: number;
  population: number;
  gamesPerMember: number;
  batchSize: number;
  parallel: number;
  threshold: number;
  sweepMasterSeed: number;
  corpusOutPath: string;
  reportPath: string;
  outDir: string;
}

const DEFAULT_OUT_DIR = resolve(import.meta.dirname, '..', 'data', 'generator');

function parseCoverageArgs(argv: string[]): CoverageArgs {
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
  if (archivePaths.length === 0)
    throw new Error('--archive <file> is required (repeatable)');
  const commit8 = (
    JSON.parse(readFileSync(archivePaths[0]!, 'utf8')) as {
      engineCommit: string;
    }
  ).engineCommit.slice(0, 8);
  return {
    leaguePath,
    archivePaths: [...archivePaths].sort(),
    restrictedReportPath: get('--restricted-report')
      ? resolve(get('--restricted-report')!)
      : resolve(DEFAULT_OUT_DIR, `restricted-${commit8}.json`),
    deltasReportPath: get('--deltas-report')
      ? resolve(get('--deltas-report')!)
      : resolve(DEFAULT_OUT_DIR, `deltas-${commit8}-20261123.json`),
    seedBase: Number(get('--seed-base') ?? RESTRICTED_SEED_BASE),
    generations: Number(get('--generations') ?? RESTRICTED_GENERATIONS),
    population: Number(get('--population') ?? RESTRICTED_POPULATION),
    gamesPerMember: Number(
      get('--games-per-member') ?? RESTRICTED_GAMES_PER_MEMBER,
    ),
    batchSize: Number(get('--batch-size') ?? SWEEP_BATCH_SIZE),
    parallel: Math.max(1, Number(get('--parallel') ?? SWEEP_PARALLEL)),
    threshold: Number(get('--threshold') ?? RESTRICTED_MIN_FITNESS),
    sweepMasterSeed: Number(get('--sweep-seed') ?? SWEEP_MASTER_SEED),
    corpusOutPath: get('--out')
      ? resolve(get('--out')!)
      : resolve(DEFAULT_OUT_DIR, `corpus-${commit8}-20261123.json`),
    reportPath: get('--report-out')
      ? resolve(get('--report-out')!)
      : resolve(DEFAULT_OUT_DIR, `coverage-${commit8}.json`),
    outDir: DEFAULT_OUT_DIR,
  };
}

export async function runCoverageCli(
  args: CoverageArgs,
): Promise<CoverageRunReport> {
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
  const commit8 = catalog.engineCommit.slice(0, 8);
  if (league.engineCommit.slice(0, 8) !== commit8) {
    throw new Error(
      `league era ${league.engineCommit.slice(0, 8)} ≠ engine era ${commit8}`,
    );
  }
  const fullPool = legalSelfPlayIdentities(cards, cardMap);
  const archives = args.archivePaths.map((path) => loadCorpusArchive(path));
  for (const archive of archives) {
    if (archive.engineCommit.slice(0, 8) !== commit8) {
      throw new Error(
        `archive era ${archive.engineCommit.slice(0, 8)} ≠ engine era ${commit8}`,
      );
    }
  }
  const restrictedReport = loadRestrictedReport(args.restrictedReportPath);
  if (restrictedReport.engineCommit.slice(0, 8) !== commit8) {
    throw new Error(
      `restricted report era ${restrictedReport.engineCommit.slice(0, 8)} ≠ engine era ${commit8}`,
    );
  }
  const deltasReport = loadDeltasReport(args.deltasReportPath);
  if (deltasReport.engineCommit.slice(0, 8) !== commit8) {
    throw new Error(
      `deltas report era ${deltasReport.engineCommit.slice(0, 8)} ≠ engine era ${commit8}`,
    );
  }
  const { sources } = collectDeckSources(archives, {
    format: league.format,
    engineCommit: league.engineCommit,
    members: league.members.map(({ id, kind, deck }) => ({ id, kind, deck })),
  });
  const decksById = new Map(sources.map((source) => [source.deckId, source]));
  const substitutionDeltas = deltasFromReport(deltasReport, decksById);

  const started = Date.now();

  // ---- 1) widen + rerun the thin pools (seeds continue the numbering) ----
  const thinPools = restrictedReport.pools
    .filter((pool) => pool.dropped && pool.reason === 'thin-pool')
    .sort((a, b) => a.poolIndex - b.poolIndex);
  const widening: WidenedPoolReport[] = [];
  const widenedDecks: RestrictedDeckInput[] = [];
  for (const [offset, thin] of thinPools.entries()) {
    const originalSpec = RESTRICTED_POOLS[thin.poolIndex];
    if (!originalSpec) {
      throw new Error(
        `restricted report pool index ${thin.poolIndex} is not a pre-committed pool`,
      );
    }
    const spec: RestrictedPoolSpec = {
      ...originalSpec,
      condition: `${originalSpec.condition}+widened`,
      slug: `${originalSpec.slug}-widened`,
    };
    const poolIndex = RESTRICTED_POOLS.length + offset;
    const masterSeed = args.seedBase + poolIndex;
    const widened = widenRestrictedPool({
      spec: originalSpec,
      fullPool,
      cards,
    });
    const evaluate: CandidateEvaluator = async (
      candidates,
      poolLeague,
      generation,
    ) => {
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
        label: `widened-${spec.slug}-gen${generation}`,
      });
      return parts.map((part) => ({
        index: part.index,
        fitness: part.fitness,
        games: part.games,
      }));
    };
    const run = await runRestrictedPool({
      spec,
      poolIndex,
      fullPool,
      cards,
      league,
      masterSeed,
      generations: args.generations,
      population: args.population,
      gamesPerMember: args.gamesPerMember,
      threshold: args.threshold,
      poolOverride: widened.pool,
      evaluate,
      archivePath: resolve(
        args.outDir,
        'restricted',
        `${spec.slug}.archive.json`,
      ),
    });
    widening.push({
      condition: spec.condition,
      originalCondition: originalSpec.condition,
      slug: spec.slug,
      poolIndex,
      masterSeed,
      originalPoolSize: widened.originalSize,
      widenedPoolSize: widened.widenedSize,
      inkPair: widened.inkPair,
      fellBackToFullPool: widened.fellBackToFullPool,
      candidatesEvaluated: run.stats.candidatesEvaluated,
      games: run.stats.games,
      cells: run.stats.cells,
      cellsPassingThreshold: run.stats.cellsPassingThreshold,
      passingDecks: run.stats.passingDecks,
      dropped: run.stats.dropped,
      ...(run.stats.reason ? { reason: run.stats.reason } : {}),
      ...(run.stats.error ? { error: run.stats.error } : {}),
    });
    widenedDecks.push(...run.decks);
  }

  const restrictedDecks = [...restrictedReport.decks, ...widenedDecks];

  // ---- 2) base corpus → unseen identities ----
  const leagueForCorpus = {
    format: league.format,
    engineCommit: league.engineCommit,
    members: league.members.map(({ id, kind, deck }) => ({ id, kind, deck })),
  };
  const baseCorpus = buildCorpus({
    archives,
    league: leagueForCorpus,
    restrictedDecks,
    substitutionDeltas,
  });
  const poolIds = [...fullPool.keys()].sort((a, b) => a - b);
  const unseen = unseenIdentities(poolIds, baseCorpus.corpus.pairs);

  // ---- 3) plan + evaluate the sweep vs the real held-out members ----
  const plan = planSweepDecks({
    unseen,
    pool: fullPool,
    cards,
    masterSeed: args.sweepMasterSeed,
  });
  const realMembers = league.members.filter((member) => member.kind === 'real');
  if (realMembers.length === 0) {
    throw new Error('league has no real held-out members for the sweep');
  }
  const sweepLeague = { ...league, members: realMembers };
  const sweepRequests: EvalChunkRequest[] = plan.decks.map((deck) => ({
    index: deck.index,
    deck: deck.deck,
    parentDeck: deck.deck,
    league: sweepLeague,
    masterSeed: args.sweepMasterSeed,
    gamesPerMember: SWEEP_GAMES_PER_MEMBER,
    batchSize: args.batchSize,
    referee: DEFAULT_REFEREE,
    twinPaired: false,
  }));
  const sweepStarted = Date.now();
  const sweepParts = await evaluateChunks(sweepRequests, {
    parallel: args.parallel,
    workDir: args.outDir,
    label: 'coverage-sweep',
  });
  const sweepWallMs = Date.now() - sweepStarted;

  const coverageDecks: CoverageDeckInput[] = plan.decks.map((deck, i) => ({
    deckId: `sweep-${deck.index}`,
    deck: deck.deck,
    fitness: sweepParts[i]!.fitness,
  }));

  // ---- 4) final merged corpus (all four strata) ----
  const { corpus, stats } = buildCorpus({
    archives,
    league: leagueForCorpus,
    restrictedDecks,
    substitutionDeltas,
    coverageDecks,
  });
  mkdirSync(dirname(args.corpusOutPath), { recursive: true });
  writeFileSync(args.corpusOutPath, `${stableStringify(corpus)}\n`);

  // ---- 5) pool coverage + histogram + assertion ----
  const histogram = coverageHistogram(
    identityOccurrences(corpus.pairs),
    poolIds,
  );
  const poolCoverage: PoolCoverageReport = {
    poolSize: histogram.poolSize,
    seen: histogram.seen,
    shareSeen: histogram.shareSeen,
    atLeast3: histogram.atLeast3,
    shareAtLeast3: histogram.shareAtLeast3,
    meanOccurrences: histogram.meanOccurrences,
    maxOccurrences: histogram.maxOccurrences,
    minShareRequired: COVERAGE_MIN_SHARE,
    passes: histogram.shareSeen >= COVERAGE_MIN_SHARE,
    counts: histogram.counts,
    unseenAfter: histogram.unseen,
  };

  const wallMs = Date.now() - started;
  const report: CoverageRunReport = {
    stratum: 'coverage',
    engineCommit: catalog.engineCommit,
    trainWeight: COVERAGE_TRAIN_WEIGHT,
    minPoolShare: COVERAGE_MIN_SHARE,
    threshold: args.threshold,
    referee: DEFAULT_REFEREE,
    widening,
    sweep: {
      unseenBefore: unseen.length,
      decksPlanned: plan.decks.length,
      truncated: plan.truncated.length,
      unplaced: plan.unplaced.length,
      unseenPerDeck: SWEEP_UNSEEN_PER_DECK,
      deckSize: SWEEP_DECK_SIZE,
      maxDecks: SWEEP_MAX_DECKS,
      masterSeed: args.sweepMasterSeed,
      gamesPerMember: SWEEP_GAMES_PER_MEMBER,
      referee: DEFAULT_REFEREE,
      opponents: realMembers.map(({ id, kind }) => ({ id, kind })),
      decks: plan.decks.map((deck, i) => ({
        deckId: `coverage:sweep-${deck.index}`,
        forced: deck.forced.length,
        inks: deck.inks,
        fitness: sweepParts[i]!.fitness,
        games: sweepParts[i]!.games,
      })),
      fitness: fitnessSummary(sweepParts.map((part) => part.fitness)),
      games: sweepParts.reduce((sum, part) => sum + part.games, 0),
      wallMs: sweepWallMs,
    },
    poolCoverage,
    strata: stats.strata,
    corpusOut: args.corpusOutPath,
    corpusStats: stats,
    wallMs,
  };
  mkdirSync(dirname(args.reportPath), { recursive: true });
  writeFileSync(args.reportPath, `${JSON.stringify(report, null, 1)}\n`);

  if (!poolCoverage.passes) {
    throw new Error(
      `pool coverage ${(poolCoverage.shareSeen * 100).toFixed(2)}% is below ` +
        `the required ${(COVERAGE_MIN_SHARE * 100).toFixed(0)}% ` +
        `(${poolCoverage.seen}/${poolCoverage.poolSize} identities seen, ` +
        `${poolCoverage.unseenAfter.length} still unseen) — report written to ` +
        args.reportPath,
    );
  }
  return report;
}

async function main(): Promise<void> {
  const report = await runCoverageCli(parseCoverageArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 1));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
