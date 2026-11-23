/**
 * Stratified gated-evidence corpus builder (learned-deck-generator, tasks
 * 1.2/1.4/1.5; spec learned-deck-completion "Training corpus from gated deck
 * evidence").
 *
 * The corpus has five strata; every pair is tagged with its `stratum`:
 *
 *  - 'masked-elites': each archive elite and promoted (kind 'selfplay')
 *    league deck yields seed→target pairs by masking. For each (deck,
 *    sample) a seeded draw picks three disjoint masked regions (each 8–48
 *    cards, clamped down when three regions cannot fit disjointly into the
 *    deck); each region becomes one pair — seed = the deck minus that region,
 *    target = the region's composition. A sample contributes up to 3 pairs;
 *    SAMPLES_PER_DECK = 14 × 3 ≈ design D1's ~40 pairs per deck.
 *  - 'substitution-delta' (task 1.4): arena-measured leave-one-out pairs —
 *    (context, card-out → card-in, Δ) with Δ = fitness(in) − fitness(out) on
 *    paired seeds. Deltas MUST reference a deck already in the corpus
 *    (deckId/cellKey are inherited), so the holdout split stays deck-exact.
 *  - 'restricted' (task 1.5): seed→target pairs over restriction-conditioned
 *    decks that passed the pre-committed RESTRICTED_MIN_FITNESS league
 *    threshold; below-threshold decks are excluded, and the conditioning is
 *    carried as an opaque `condition` key.
 *  - 'pool-slice' (task 1.7, D1c): seed→target pairs from decks searched
 *    inside seeded random 50% slices of the legal self-play pool, thresholded
 *    at the same strict fitness gate and capped at ~25% of final corpus
 *    pairs (lowest-fitness decks drop first) so full-pool elite evidence
 *    stays dominant.
 *
 * Holdout split is stratified ACROSS strata and always deck-exact: holdout
 * grouping keys (the archive descriptor cell key, or `league:<memberId>` /
 * `restricted:<condition>:<id>` / `pool-slice:<i>:<id>` pseudo keys) are
 * grouped by the first stratum (canonical order: masked-elites →
 * substitution-delta → restricted → pool-slice → coverage) in which they
 * appear, every 5th key within a group becomes a holdout key,
 * and a pair is holdout iff its grouping key is one. No deck appears in both
 * sides — and decks from different archive runs that share a descriptor cell
 * share the split side too, so no cell straddles the boundary; each stratum
 * present in the corpus is represented on both sides whenever its decks
 * allow it.
 *
 * Candidates are NEVER materialized in the corpus file — they are derived at
 * training time from the legal pool + the pair's seed (lean file
 * requirement).
 *
 * Determinism: mulberry32 seeded per (corpus seed, deckId, sample); decks and
 * identity keys are normalized to a fixed order; the CLI serializes with a
 * key-sorted stringify, so equal inputs rebuild a byte-identical file.
 *
 * Module boundaries (root-tsconfig rule): this file must not import from
 * scripts/training/arena — the root program excludes that directory and an
 * import would drag it (and the vendored engine) back in. Archive/league
 * artifacts are therefore read through local structural types below, in the
 * same spirit as train.ts's local interfaces.
 *
 * Usage (masked-elites stratum; later strata feed the builder API):
 *   npx tsx scripts/training/generator/corpus.ts \
 *     --archive <archive.json> [--archive ...] --league <league.json> \
 *     [--out <corpus.json>] [--seed 20261123] [--samples-per-deck 14]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../prng';
import { FEATURE_SCHEMA_VERSION } from './features';

// ---- local structural types for the arena artifacts (see module docstring)

export interface CorpusArchiveCell {
  cellKey: string;
  /** identity id → count */
  deck: Record<string, number>;
}

export interface CorpusArchive {
  format: string;
  engineCommit: string;
  seed: number;
  cells: Record<string, CorpusArchiveCell>;
}

export interface CorpusLeagueMember {
  id: string;
  kind: string;
  /** identity id → count */
  deck: Record<string, number>;
}

export interface CorpusLeague {
  format: string;
  engineCommit: string;
  members: CorpusLeagueMember[];
}

// ---- corpus shape (the on-disk contract) ----

export type CorpusStratum =
  | 'masked-elites'
  | 'substitution-delta'
  | 'restricted'
  | 'pool-slice'
  | 'coverage';

/** canonical order for stratum tie-breaks (holdout grouping, stats) */
export const STRATUM_ORDER: readonly CorpusStratum[] = [
  'masked-elites',
  'substitution-delta',
  'restricted',
  'pool-slice',
  'coverage',
] as const;

/**
 * Pre-committed training weight for coverage-sweep pairs (design D1b): sweep
 * decks exist for visibility (every pool identity seen at least once), not
 * for their quality, so long-tail noise must not outweigh gated evidence.
 * Carried on every coverage pair; the trainer applies it in the final
 * all-strata run.
 */
export const COVERAGE_TRAIN_WEIGHT = 0.3;

/**
 * Pre-committed share cap for pool-slice pairs (design D1c ~25%): full-pool
 * elite evidence must stay dominant. Enforced against the FINAL corpus here
 * (the slices CLI only estimates it); over-cap slices lose lowest-fitness
 * decks first (ties → lower slice index, then lexicographic deck id).
 */
export const POOL_SLICE_PAIR_CAP = 0.25;

/** seed→target imitation pair (masked-elites and restricted strata) */
interface ImitationPairFields {
  /**
   * `archive:<archiveSeed>:<cellKey>`, `league:<memberId>`, or
   * `restricted:<condition>:<id>` — unique per deck
   */
  deckId: string;
  /**
   * the holdout-grouping key: the archive descriptor cell, or the league /
   * restricted pseudo key. Decks from different archive runs can share a
   * descriptor cell; the cell never straddles the split.
   */
  cellKey: string;
  /** identity id → count; the deck minus the masked region (strict subset) */
  seed: Record<string, number>;
  /** identity id → count; the masked region's composition */
  target: Record<string, number>;
  /**
   * Present in the pair contract only to pin that candidates are NOT part of
   * the corpus: they are derived at training time from the legal pool + the
   * pair's seed, so the file stays lean. TypeScript forbids setting it.
   */
  candidates?: never;
}

export interface MaskedElitesPair extends ImitationPairFields {
  stratum: 'masked-elites';
}

export interface RestrictedPair extends ImitationPairFields {
  stratum: 'restricted';
  /** opaque conditioning label of the restricted pool, e.g. `inks:ruby-sapphire` */
  condition: string;
}

export interface PoolSlicePair extends ImitationPairFields {
  stratum: 'pool-slice';
  /** the slice's conditioning label, `pool-slice:<i>` (D1c) */
  condition: string;
}

export interface CoveragePair extends ImitationPairFields {
  stratum: 'coverage';
  /** pre-committed reduced training weight (D1b, COVERAGE_TRAIN_WEIGHT) */
  trainWeight: number;
  /** measured league fitness of the sweep deck — no threshold applied */
  fitness: number;
}

export interface SubstitutionDeltaPair {
  stratum: 'substitution-delta';
  /** the elite deck the delta was measured on (split side is inherited) */
  deckId: string;
  cellKey: string;
  /** the deck minus one copy of cardOut */
  context: Record<string, number>;
  /** identity id removed from the deck */
  cardOut: string;
  /** identity id that replaced it */
  cardIn: string;
  /** arena-measured fitness delta on paired seeds (in − out) */
  delta: number;
}

export type CorpusPair =
  | MaskedElitesPair
  | RestrictedPair
  | PoolSlicePair
  | SubstitutionDeltaPair
  | CoveragePair;

/** pairs shaped (seed → target): the imitation strata */
export type ImitationPair =
  | MaskedElitesPair
  | RestrictedPair
  | PoolSlicePair
  | CoveragePair;

export interface Corpus {
  format: string;
  featureSchemaVersion: number;
  pairs: CorpusPair[];
  /** every 5th grouping key per stratum; a pair is holdout iff its key is here */
  holdoutCellKeys: string[];
}

export interface CorpusStats {
  pairs: number;
  decks: number;
  holdoutDecks: number;
  holdoutPairs: number;
  /** per-stratum breakdown; decks = decks that actually yielded pairs */
  strata: Record<CorpusStratum, StratumStats>;
  /** total target (masked) cards across imitation pairs */
  maskedCards: number;
  duplicatesSkipped: number;
  tooSmallSkipped: number;
  /** restricted decks excluded by the fitness threshold */
  restrictedBelowThreshold: number;
  /** pool-slice decks excluded by the fitness threshold (D1c strict >) */
  poolSliceBelowThreshold: number;
  /**
   * Slice-pair cap enforcement against the final corpus (present when slice
   * decks were offered): the pre-committed ~25% share, recomputed here.
   */
  poolSliceCap?: PoolSliceCapReport;
  /** coverage stratum fitness distribution (present when sweep decks exist) */
  coverageFitness?: FitnessSummary;
}

export interface PoolSliceCapReport {
  cap: number;
  /** slicePairs / (slicePairs + otherPairs) before enforcement */
  shareBefore: number;
  /** share after enforcement (≤ cap when enforced) */
  shareAfter: number;
  slicePairsBefore: number;
  slicePairsAfter: number;
  /** every corpus pair that is not a pool-slice pair */
  otherPairs: number;
  enforced: boolean;
  /** dropped decks in drop order (lowest fitness first, ties deterministic) */
  dropped: Array<{ deckId: string; fitness: number; pairs: number }>;
}

export interface FitnessSummary {
  min: number;
  median: number;
  mean: number;
  max: number;
}

export interface StratumStats {
  decks: number;
  pairs: number;
  holdoutDecks: number;
  holdoutPairs: number;
}

// ---- pre-committed parameters ----

/** masked region size band (task 1.2): each region is 8–48 cards */
export const MIN_REGION_CARDS = 8;
export const MAX_REGION_CARDS = 48;
/** disjoint regions per (deck, sample); each becomes one pair */
export const REGIONS_PER_SAMPLE = 3;
/** samples per deck: 14 × 3 regions ≈ design D1's ~40 pairs per deck */
export const SAMPLES_PER_DECK = 14;
export const DEFAULT_CORPUS_SEED = 20261123;
/** restricted-conditioned decks below this league fitness are excluded (D1) */
export const RESTRICTED_MIN_FITNESS = 0.45;
const HOLDOUT_EVERY = 5;

// ---- deterministic primitives ----

/** normalize a deck record: drop nothing, order identity keys lexicographically */
export function sortDeckRecord(
  deck: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, count] of Object.entries(deck).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    out[id] = count;
  }
  return out;
}

/** stable dedupe key for a deck (sorted entry list) */
export function stableDeckKey(deck: Record<string, number>): string {
  return JSON.stringify(Object.entries(sortDeckRecord(deck)));
}

/**
 * Per-(deck, sample) RNG seed: FNV-1a over "<deckId>#<sample>" with the
 * corpus seed folded into the offset basis — stable when other decks are
 * added to the corpus, so existing pairs never change.
 */
export function sampleSeedFor(
  corpusSeed: number,
  deckId: string,
  sample: number,
): number {
  let hash = (corpusSeed ^ 2166136261) >>> 0;
  const text = `${deckId}#${sample}`;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Region sizes for one (deck, sample): REGIONS_PER_SAMPLE disjoint regions
 * drawn from [8, 48], shrunk largest-first (ties → lowest index) until they
 * fit disjointly into `total` cards. Sizes never drop below 8 because
 * 8 × regions ≤ total is guaranteed by the region count.
 */
export function planRegionSizes(total: number, rng: () => number): number[] {
  const regions = Math.min(
    REGIONS_PER_SAMPLE,
    Math.floor(total / MIN_REGION_CARDS),
  );
  if (regions === 0) return [];
  const sizes = Array.from(
    { length: regions },
    () =>
      MIN_REGION_CARDS +
      Math.floor(rng() * (MAX_REGION_CARDS - MIN_REGION_CARDS + 1)),
  );
  let sum = sizes.reduce((a, b) => a + b, 0);
  while (sum > total) {
    let maxIndex = 0;
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i]! > sizes[maxIndex]!) maxIndex = i;
    }
    sizes[maxIndex]!--;
    sum--;
  }
  return sizes;
}

/** seeded Fisher–Yates shuffle (no Math.random in training paths) */
function seededShuffle<T>(list: T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** the deck as a sorted, count-expanded identity list */
function expandDeck(deck: Record<string, number>): string[] {
  const pool: string[] = [];
  for (const [id, count] of Object.entries(sortDeckRecord(deck))) {
    for (let i = 0; i < count; i++) pool.push(id);
  }
  return pool;
}

/** one masked pair: target = region composition, seed = deck − region */
export function maskRegion(
  deck: Record<string, number>,
  regionIds: string[],
): { seed: Record<string, number>; target: Record<string, number> } {
  const target: Record<string, number> = {};
  for (const id of regionIds) target[id] = (target[id] ?? 0) + 1;
  const seed: Record<string, number> = {};
  for (const [id, count] of Object.entries(deck)) {
    const masked = target[id] ?? 0;
    if (count - masked > 0) seed[id] = count - masked;
  }
  return { seed: sortDeckRecord(seed), target: sortDeckRecord(target) };
}

function deckTotal(deck: Record<string, number>): number {
  let total = 0;
  for (const count of Object.values(deck)) {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`malformed deck entry (count ${count})`);
    }
    total += count;
  }
  return total;
}

/** spec scenario guard: the seed is a strict subset of the deck's cards */
function assertStrictSubset(
  deckId: string,
  deck: Record<string, number>,
  seed: Record<string, number>,
): void {
  let seedTotal = 0;
  for (const [id, count] of Object.entries(seed)) {
    const deckCount = deck[id];
    if (deckCount === undefined || count <= 0 || count > deckCount) {
      throw new Error(`pair ${deckId}: seed is not a subset of the deck`);
    }
    seedTotal += count;
  }
  if (seedTotal >= deckTotal(deck)) {
    throw new Error(
      `pair ${deckId}: seed is not a strict subset (nothing masked)`,
    );
  }
}

// ---- deck collection (masked-elites sources) ----

interface DeckSource {
  deckId: string;
  cellKey: string;
  deck: Record<string, number>;
}

/** archive cells (sorted) + promoted league members (sorted), deduped */
export function collectDeckSources(
  archives: CorpusArchive[],
  league: CorpusLeague,
): { sources: DeckSource[]; duplicatesSkipped: number } {
  const sources: DeckSource[] = [];
  const seen = new Set<string>();
  let duplicatesSkipped = 0;
  const add = (
    deckId: string,
    cellKey: string,
    deck: Record<string, number>,
  ): void => {
    const key = stableDeckKey(deck);
    if (seen.has(key)) {
      duplicatesSkipped++;
      return;
    }
    seen.add(key);
    sources.push({ deckId, cellKey, deck: sortDeckRecord(deck) });
  };
  for (const archive of archives) {
    // deck ids carry the archive seed: two runs can hold DIFFERENT elite
    // decks in the same descriptor cell, and ids must stay unique. The bare
    // cellKey stays the holdout-grouping key, so one descriptor cell never
    // straddles the split.
    for (const cellKey of Object.keys(archive.cells).sort()) {
      add(
        `archive:${archive.seed}:${cellKey}`,
        cellKey,
        archive.cells[cellKey]!.deck,
      );
    }
  }
  for (const member of [...league.members].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    if (member.kind !== 'selfplay') continue;
    add(`league:${member.id}`, `league:${member.id}`, member.deck);
  }
  return { sources, duplicatesSkipped };
}

// ---- strata inputs (tasks 1.4 / 1.5) ----

export interface SubstitutionDeltaInput {
  /** must reference a masked-elites deck already in the corpus */
  deckId: string;
  context: Record<string, number>;
  cardOut: string;
  cardIn: string;
  /** arena-measured fitness delta on paired seeds (in − out) */
  delta: number;
}

export interface RestrictedDeckInput {
  /** opaque conditioning label, e.g. `inks:ruby-sapphire` */
  condition: string;
  deckId: string;
  deck: Record<string, number>;
  /** league fitness of the deck (evaluateCandidateVsLeague score) */
  fitness: number;
}

export interface CoverageDeckInput {
  deckId: string;
  deck: Record<string, number>;
  /** measured league fitness of the sweep deck (no threshold, D1b) */
  fitness: number;
}

export interface PoolSliceDeckInput {
  /** slice index (seed offset, D1c) */
  sliceIndex: number;
  /** conditioning label, `pool-slice:<i>` */
  condition: string;
  /** slice-local deck id, `gen-<g>-cand-<c>` */
  deckId: string;
  deck: Record<string, number>;
  /** league fitness of the slice deck (threshold + cap inputs) */
  fitness: number;
}

// ---- corpus builder ----

export interface BuildCorpusOptions {
  archives: CorpusArchive[];
  league: CorpusLeague;
  corpusSeed?: number;
  samplesPerDeck?: number;
  /** restricted-conditioned decks (task 1.5); below-threshold entries drop */
  restrictedDecks?: RestrictedDeckInput[];
  /** leave-one-out deltas (task 1.4); must reference corpus decks */
  substitutionDeltas?: SubstitutionDeltaInput[];
  /** restricted fitness threshold (default RESTRICTED_MIN_FITNESS) */
  restrictedThreshold?: number;
  /**
   * Coverage-sweep decks (task 1.6): legality is the only gate — every deck
   * enters the `coverage` stratum with its measured fitness and the
   * pre-committed COVERAGE_TRAIN_WEIGHT.
   */
  coverageDecks?: CoverageDeckInput[];
  /** pool-slice ablation decks (task 1.7, D1c); thresholded and capped here */
  poolSliceDecks?: PoolSliceDeckInput[];
  /** slice-pair share cap (default POOL_SLICE_PAIR_CAP) */
  poolSliceCap?: number;
}

export interface BuiltCorpus {
  corpus: Corpus;
  stats: CorpusStats;
}

function emptyStratumStats(): StratumStats {
  return { decks: 0, pairs: 0, holdoutDecks: 0, holdoutPairs: 0 };
}

/** mask one deck into imitation pairs (shared by the imitation strata) */
function maskDeckIntoPairs(opts: {
  deckId: string;
  cellKey: string;
  deck: Record<string, number>;
  stratum: 'masked-elites' | 'restricted' | 'pool-slice' | 'coverage';
  condition?: string;
  fitness?: number;
  samplesPerDeck: number;
  corpusSeed: number;
  pairs: CorpusPair[];
}): number {
  const total = deckTotal(opts.deck);
  if (total < MIN_REGION_CARDS) return -1;
  const pool = expandDeck(opts.deck);
  let maskedCards = 0;
  for (let sample = 0; sample < opts.samplesPerDeck; sample++) {
    const rng = mulberry32(sampleSeedFor(opts.corpusSeed, opts.deckId, sample));
    const sizes = planRegionSizes(total, rng);
    const shuffled = seededShuffle(pool, rng);
    let offset = 0;
    for (const size of sizes) {
      const region = shuffled.slice(offset, offset + size);
      offset += size;
      const { seed, target } = maskRegion(opts.deck, region);
      assertStrictSubset(opts.deckId, opts.deck, seed);
      if (opts.stratum === 'restricted') {
        opts.pairs.push({
          stratum: 'restricted',
          deckId: opts.deckId,
          cellKey: opts.cellKey,
          condition: opts.condition!,
          seed,
          target,
        });
      } else if (opts.stratum === 'pool-slice') {
        opts.pairs.push({
          stratum: 'pool-slice',
          deckId: opts.deckId,
          cellKey: opts.cellKey,
          condition: opts.condition!,
          seed,
          target,
        });
      } else if (opts.stratum === 'coverage') {
        opts.pairs.push({
          stratum: 'coverage',
          deckId: opts.deckId,
          cellKey: opts.cellKey,
          seed,
          target,
          trainWeight: COVERAGE_TRAIN_WEIGHT,
          fitness: opts.fitness!,
        });
      } else {
        opts.pairs.push({
          stratum: 'masked-elites',
          deckId: opts.deckId,
          cellKey: opts.cellKey,
          seed,
          target,
        });
      }
      maskedCards += size;
    }
  }
  return maskedCards;
}

/** validate + emit one substitution-delta pair against its parent deck */
function addSubstitutionDelta(
  delta: SubstitutionDeltaInput,
  byDeckId: Map<string, DeckSource>,
  pairs: CorpusPair[],
): boolean {
  const source = byDeckId.get(delta.deckId);
  if (!source) {
    throw new Error(
      `substitution delta references unknown deck ${delta.deckId} — deltas must be measured on corpus decks`,
    );
  }
  const deck = source.deck;
  const outCount = deck[delta.cardOut];
  if (outCount === undefined || outCount < 1) {
    throw new Error(
      `substitution delta ${delta.deckId}: cardOut ${delta.cardOut} is not in the deck`,
    );
  }
  const context = sortDeckRecord(delta.context);
  if (!Number.isFinite(delta.delta)) {
    throw new Error(`substitution delta ${delta.deckId}: delta is not finite`);
  }
  let contextTotal = 0;
  for (const [id, count] of Object.entries(context)) {
    const deckCount = deck[id] ?? 0;
    if (!Number.isInteger(count) || count < 0 || count > deckCount) {
      throw new Error(
        `substitution delta ${delta.deckId}: context is not a subset of the deck`,
      );
    }
    contextTotal += count;
  }
  if (
    contextTotal !== deckTotal(deck) - 1 ||
    (context[delta.cardOut] ?? 0) !== outCount - 1
  ) {
    throw new Error(
      `substitution delta ${delta.deckId}: context ≠ deck − one ${delta.cardOut}`,
    );
  }
  pairs.push({
    stratum: 'substitution-delta',
    deckId: source.deckId,
    cellKey: source.cellKey,
    context,
    cardOut: delta.cardOut,
    cardIn: delta.cardIn,
    delta: delta.delta,
  });
  return true;
}

/**
 * Build the stratified corpus. Pure and deterministic: equal inputs (in any
 * object-key order) produce equal corpora.
 */
export function buildCorpus(opts: BuildCorpusOptions): BuiltCorpus {
  const corpusSeed = opts.corpusSeed ?? DEFAULT_CORPUS_SEED;
  const samplesPerDeck = opts.samplesPerDeck ?? SAMPLES_PER_DECK;
  const threshold = opts.restrictedThreshold ?? RESTRICTED_MIN_FITNESS;
  if (!Number.isInteger(samplesPerDeck) || samplesPerDeck < 1) {
    throw new Error(
      `samplesPerDeck must be a positive integer (got ${samplesPerDeck})`,
    );
  }
  const formats = new Set([
    ...opts.archives.map((archive) => archive.format),
    opts.league.format,
  ]);
  if (formats.size > 1) {
    throw new Error(
      `input formats disagree: ${[...formats].sort().join(', ')}`,
    );
  }
  const engineCommits = new Set([
    ...opts.archives.map((archive) => archive.engineCommit),
    opts.league.engineCommit,
  ]);
  if (engineCommits.size > 1) {
    throw new Error('input artifacts span multiple engine eras');
  }

  const pairs: CorpusPair[] = [];
  // deck-composition dedupe across strata: an identical imitation target must
  // not enter the corpus twice (a restricted re-find of an elite deck drops)
  const emittedDeckKeys = new Set<string>();
  const strata: Record<CorpusStratum, StratumStats> = {
    'masked-elites': emptyStratumStats(),
    'substitution-delta': emptyStratumStats(),
    restricted: emptyStratumStats(),
    'pool-slice': emptyStratumStats(),
    coverage: emptyStratumStats(),
  };
  let maskedCards = 0;
  let duplicatesSkipped = 0;
  let tooSmallSkipped = 0;
  let restrictedBelowThreshold = 0;
  let poolSliceBelowThreshold = 0;

  // ---- stratum (a): masked elites ----
  const { sources, duplicatesSkipped: sourceDupes } = collectDeckSources(
    opts.archives,
    opts.league,
  );
  duplicatesSkipped += sourceDupes;
  const byDeckId = new Map(sources.map((source) => [source.deckId, source]));
  for (const source of sources) {
    // malformed identity counts throw (loud), only genuinely small decks skip
    if (deckTotal(source.deck) < MIN_REGION_CARDS) {
      tooSmallSkipped++;
      continue;
    }
    const cards = maskDeckIntoPairs({
      ...source,
      stratum: 'masked-elites',
      samplesPerDeck,
      corpusSeed,
      pairs,
    });
    if (cards < 0) {
      tooSmallSkipped++;
      continue;
    }
    maskedCards += cards;
    emittedDeckKeys.add(stableDeckKey(source.deck));
  }

  // ---- stratum (c): restriction-conditioned decks above the threshold ----
  const restricted = [...(opts.restrictedDecks ?? [])].sort((a, b) =>
    a.deckId < b.deckId ? -1 : a.deckId > b.deckId ? 1 : 0,
  );
  for (const entry of restricted) {
    if (entry.fitness <= threshold) {
      restrictedBelowThreshold++;
      continue;
    }
    const deckId = `restricted:${entry.condition}:${entry.deckId}`;
    if (byDeckId.has(deckId)) {
      duplicatesSkipped++;
      continue;
    }
    const deck = sortDeckRecord(entry.deck);
    if (emittedDeckKeys.has(stableDeckKey(deck))) {
      duplicatesSkipped++;
      continue;
    }
    const source: DeckSource = {
      deckId,
      cellKey: deckId,
      deck,
    };
    byDeckId.set(deckId, source);
    const cards = maskDeckIntoPairs({
      ...source,
      stratum: 'restricted',
      condition: entry.condition,
      samplesPerDeck,
      corpusSeed,
      pairs,
    });
    if (cards < 0) {
      tooSmallSkipped++;
      byDeckId.delete(deckId);
      continue;
    }
    maskedCards += cards;
    emittedDeckKeys.add(stableDeckKey(deck));
  }

  // ---- stratum (d): coverage sweep decks (task 1.6, D1b) ----
  // Legality is the only gate: every deck enters with its measured fitness
  // and the pre-committed COVERAGE_TRAIN_WEIGHT, however weak it played.
  const coverageDecks = [...(opts.coverageDecks ?? [])].sort((a, b) =>
    a.deckId < b.deckId ? -1 : a.deckId > b.deckId ? 1 : 0,
  );
  const coverageFitnesses: number[] = [];
  for (const entry of coverageDecks) {
    if (!Number.isFinite(entry.fitness)) {
      throw new Error(`coverage deck ${entry.deckId}: fitness is not finite`);
    }
    const deckId = entry.deckId.startsWith('coverage:')
      ? entry.deckId
      : `coverage:${entry.deckId}`;
    if (byDeckId.has(deckId)) {
      duplicatesSkipped++;
      continue;
    }
    const deck = sortDeckRecord(entry.deck);
    // an exact duplicate of an existing deck adds no unseen identity (its
    // identities are already in the corpus) — drop for corpus hygiene
    if (emittedDeckKeys.has(stableDeckKey(deck))) {
      duplicatesSkipped++;
      continue;
    }
    const source: DeckSource = { deckId, cellKey: deckId, deck };
    byDeckId.set(deckId, source);
    const cards = maskDeckIntoPairs({
      ...source,
      stratum: 'coverage',
      fitness: entry.fitness,
      samplesPerDeck,
      corpusSeed,
      pairs,
    });
    if (cards < 0) {
      tooSmallSkipped++;
      byDeckId.delete(deckId);
      continue;
    }
    maskedCards += cards;
    coverageFitnesses.push(entry.fitness);
    emittedDeckKeys.add(stableDeckKey(deck));
  }

  // ---- stratum (b): substitution deltas (must reference corpus decks) ----
  for (const delta of opts.substitutionDeltas ?? []) {
    addSubstitutionDelta(delta, byDeckId, pairs);
  }

  // ---- stratum (e): pool-slice ablation decks (task 1.7, D1c) ----
  // Same strict fitness threshold as the restricted strata; the ~25% pair
  // cap is enforced against the final corpus below.
  const poolSliceDecks = [...(opts.poolSliceDecks ?? [])].sort((a, b) => {
    const ka = `${a.condition}:${a.deckId}`;
    const kb = `${b.condition}:${b.deckId}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const entry of poolSliceDecks) {
    if (entry.fitness <= threshold) {
      poolSliceBelowThreshold++;
      continue;
    }
    const deckId = `${entry.condition}:${entry.deckId}`;
    if (byDeckId.has(deckId)) {
      duplicatesSkipped++;
      continue;
    }
    const deck = sortDeckRecord(entry.deck);
    if (emittedDeckKeys.has(stableDeckKey(deck))) {
      duplicatesSkipped++;
      continue;
    }
    const source: DeckSource = { deckId, cellKey: deckId, deck };
    const cards = maskDeckIntoPairs({
      ...source,
      stratum: 'pool-slice',
      condition: entry.condition,
      samplesPerDeck,
      corpusSeed,
      pairs,
    });
    if (cards < 0) {
      tooSmallSkipped++;
      continue;
    }
    maskedCards += cards;
    emittedDeckKeys.add(stableDeckKey(deck));
    byDeckId.set(deckId, source);
  }

  // ---- slice-pair cap (D1c): recompute the share against the final corpus ----
  let poolSliceCap: PoolSliceCapReport | undefined;
  const sliceDeckIds = [
    ...new Set(
      pairs
        .filter((pair) => pair.stratum === 'pool-slice')
        .map((pair) => pair.deckId),
    ),
  ];
  if (sliceDeckIds.length > 0) {
    const cap = opts.poolSliceCap ?? POOL_SLICE_PAIR_CAP;
    if (!(cap > 0 && cap <= 1)) {
      throw new Error(`poolSliceCap must be in (0, 1] (got ${cap})`);
    }
    const fitnessById = new Map(
      poolSliceDecks.map((entry) => [
        `${entry.condition}:${entry.deckId}`,
        entry.fitness,
      ]),
    );
    const slicePairsBefore = pairs.filter(
      (pair) => pair.stratum === 'pool-slice',
    ).length;
    const otherPairs = pairs.length - slicePairsBefore;
    const dropOrder = sliceDeckIds
      .map((deckId) => ({
        deckId,
        fitness: fitnessById.get(deckId)!,
        pairs: pairs.filter(
          (pair) => pair.stratum === 'pool-slice' && pair.deckId === deckId,
        ).length,
      }))
      .sort((a, b) => a.fitness - b.fitness || (a.deckId < b.deckId ? -1 : 1));
    const droppedIds = new Set<string>();
    const dropped: PoolSliceCapReport['dropped'] = [];
    let slicePairs = slicePairsBefore;
    // dropping slice decks shrinks the corpus: the share is always
    // slicePairs / (slicePairs + otherPairs) with otherPairs fixed
    const share = (slice: number): number => slicePairShare(slice, otherPairs);
    if (share(slicePairs) > cap) {
      for (const deck of dropOrder) {
        if (share(slicePairs) <= cap) break;
        droppedIds.add(deck.deckId);
        slicePairs -= deck.pairs;
        dropped.push(deck);
      }
    }
    if (droppedIds.size > 0) {
      for (const deckId of droppedIds) {
        byDeckId.delete(deckId);
      }
      for (let i = pairs.length - 1; i >= 0; i--) {
        if (droppedIds.has(pairs[i]!.deckId)) pairs.splice(i, 1);
      }
    }
    poolSliceCap = {
      cap,
      shareBefore: slicePairShare(slicePairsBefore, otherPairs),
      shareAfter: slicePairShare(slicePairs, otherPairs),
      slicePairsBefore,
      slicePairsAfter: slicePairs,
      otherPairs,
      enforced: dropped.length > 0,
      dropped,
    };
  }

  // ---- stratified holdout: every 5th deck key per stratum, deck-exact ----
  const keysByStratum = new Map<CorpusStratum, Set<string>>(
    STRATUM_ORDER.map((stratum) => [stratum, new Set()]),
  );
  for (const pair of pairs) {
    keysByStratum.get(pair.stratum)!.add(pair.cellKey);
  }
  const holdout = new Set<string>();
  for (const stratum of STRATUM_ORDER) {
    const keys = [...keysByStratum.get(stratum)!].sort();
    for (const [index, key] of keys.entries()) {
      if (index % HOLDOUT_EVERY === 0) holdout.add(key);
    }
  }

  for (const stratum of STRATUM_ORDER) {
    const stratumPairs = pairs.filter((pair) => pair.stratum === stratum);
    const decks = new Set(stratumPairs.map((pair) => pair.deckId));
    const holdoutDecks = new Set(
      stratumPairs
        .filter((pair) => holdout.has(pair.cellKey))
        .map((pair) => pair.deckId),
    );
    strata[stratum] = {
      decks: decks.size,
      pairs: stratumPairs.length,
      holdoutDecks: holdoutDecks.size,
      holdoutPairs: stratumPairs.filter((pair) => holdout.has(pair.cellKey))
        .length,
    };
  }

  const allDecks = new Set(pairs.map((pair) => pair.deckId));
  const allHoldoutDecks = new Set(
    pairs
      .filter((pair) => holdout.has(pair.cellKey))
      .map((pair) => pair.deckId),
  );
  return {
    corpus: {
      format: opts.league.format,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      pairs,
      holdoutCellKeys: [...holdout].sort(),
    },
    stats: {
      pairs: pairs.length,
      decks: allDecks.size,
      holdoutDecks: allHoldoutDecks.size,
      holdoutPairs: pairs.filter((pair) => holdout.has(pair.cellKey)).length,
      strata,
      maskedCards,
      duplicatesSkipped,
      tooSmallSkipped,
      restrictedBelowThreshold,
      poolSliceBelowThreshold,
      ...(poolSliceCap ? { poolSliceCap } : {}),
      ...(coverageFitnesses.length > 0
        ? {
            coverageFitness: fitnessSummary(coverageFitnesses),
          }
        : {}),
    },
  };
}

/** slice-pair share of the corpus: slicePairs / (slicePairs + otherPairs) */
export function slicePairShare(slicePairs: number, otherPairs: number): number {
  const total = slicePairs + otherPairs;
  return total === 0 ? 0 : slicePairs / total;
}

/** nearest-rank median + min/mean/max over an unsorted copy of the values */
export function fitnessSummary(values: number[]): FitnessSummary {
  if (values.length === 0) {
    throw new Error('fitnessSummary needs at least one value');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0]!,
    median: sorted[Math.floor(0.5 * (sorted.length - 1))]!,
    mean: sum / sorted.length,
    max: sorted[sorted.length - 1]!,
  };
}

// ---- JSON helpers: key-sorted, byte-deterministic serialization ----

/** JSON with every object key sorted recursively — byte-identical for equal corpora */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 1);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

// ---- artifact loading + CLI ----

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (count) => typeof count === 'number' && Number.isInteger(count),
  );
}

/** load + validate an archive artifact into the corpus-facing shape */
export function loadCorpusArchive(filePath: string): CorpusArchive {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as CorpusArchive;
  if (
    typeof raw.format !== 'string' ||
    typeof raw.engineCommit !== 'string' ||
    typeof raw.seed !== 'number' ||
    raw.cells === null ||
    typeof raw.cells !== 'object'
  ) {
    throw new Error(`${filePath} is not a valid archive file`);
  }
  for (const [key, cell] of Object.entries(raw.cells)) {
    if (
      cell === null ||
      typeof cell !== 'object' ||
      typeof cell.cellKey !== 'string' ||
      cell.cellKey !== key ||
      !isRecordOfNumbers(cell.deck)
    ) {
      throw new Error(`${filePath} contains a malformed archive cell: ${key}`);
    }
  }
  return raw;
}

/** load + validate a league artifact into the corpus-facing shape */
export function loadCorpusLeague(filePath: string): CorpusLeague {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as CorpusLeague;
  if (
    typeof raw.format !== 'string' ||
    typeof raw.engineCommit !== 'string' ||
    !Array.isArray(raw.members)
  ) {
    throw new Error(`${filePath} is not a valid league file`);
  }
  for (const member of raw.members) {
    if (
      typeof member.id !== 'string' ||
      typeof member.kind !== 'string' ||
      !isRecordOfNumbers(member.deck)
    ) {
      throw new Error(`${filePath} contains a malformed league member`);
    }
  }
  return raw;
}

/**
 * Load + validate one pool-slice deck file (slices.ts SliceDeckFile shape)
 * into pool-slice corpus inputs for the final build.
 */
export function loadPoolSliceDeckFile(filePath: string): PoolSliceDeckInput[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
    format?: unknown;
    engineCommit?: unknown;
    stratum?: unknown;
    sliceIndex?: unknown;
    condition?: unknown;
    decks?: unknown;
  };
  if (
    raw.stratum !== 'pool-slice' ||
    typeof raw.sliceIndex !== 'number' ||
    typeof raw.condition !== 'string' ||
    raw.condition !== `pool-slice:${raw.sliceIndex}` ||
    !Array.isArray(raw.decks)
  ) {
    throw new Error(`${filePath} is not a valid pool-slice deck file`);
  }
  return raw.decks.map((entry) => {
    const deck = entry as {
      deckId?: unknown;
      deck?: unknown;
      fitness?: unknown;
    };
    if (
      typeof deck.deckId !== 'string' ||
      !isRecordOfNumbers(deck.deck) ||
      typeof deck.fitness !== 'number' ||
      !Number.isFinite(deck.fitness)
    ) {
      throw new Error(
        `${filePath} contains a malformed pool-slice deck: ${String(deck.deckId)}`,
      );
    }
    return {
      sliceIndex: raw.sliceIndex as number,
      condition: raw.condition as string,
      deckId: deck.deckId,
      deck: deck.deck,
      fitness: deck.fitness,
    };
  });
}

export const DEFAULT_CORPUS_OUT_DIR = resolve(
  import.meta.dirname,
  '..',
  'data',
  'generator',
);

interface CorpusArgs {
  archivePaths: string[];
  leaguePath: string;
  sliceDeckPaths: string[];
  outPath: string;
  corpusSeed: number;
  samplesPerDeck: number;
}

function parseArgs(argv: string[]): CorpusArgs {
  const archivePaths: string[] = [];
  const sliceDeckPaths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--archive') archivePaths.push(resolve(argv[++i]!));
    if (argv[i] === '--slice-decks') sliceDeckPaths.push(resolve(argv[++i]!));
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const corpusSeed = Number(get('--seed') ?? DEFAULT_CORPUS_SEED);
  const leaguePath = get('--league') ? resolve(get('--league')!) : '';
  if (archivePaths.length === 0)
    throw new Error('--archive <file> is required');
  if (!leaguePath) throw new Error('--league <file> is required');
  const engineCommit8 = loadCorpusArchive(archivePaths[0]!).engineCommit.slice(
    0,
    8,
  );
  return {
    archivePaths: [...archivePaths].sort(),
    leaguePath,
    sliceDeckPaths: [...sliceDeckPaths].sort(),
    outPath: get('--out')
      ? resolve(get('--out')!)
      : resolve(
          DEFAULT_CORPUS_OUT_DIR,
          `corpus-${engineCommit8}-${corpusSeed}.json`,
        ),
    corpusSeed,
    samplesPerDeck: Number(get('--samples-per-deck') ?? SAMPLES_PER_DECK),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const archives = args.archivePaths.map((path) => loadCorpusArchive(path));
  const league = loadCorpusLeague(args.leaguePath);
  const poolSliceDecks = args.sliceDeckPaths.flatMap((path) =>
    loadPoolSliceDeckFile(path),
  );
  const { corpus, stats } = buildCorpus({
    archives,
    league,
    corpusSeed: args.corpusSeed,
    samplesPerDeck: args.samplesPerDeck,
    poolSliceDecks,
  });
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, `${stableStringify(corpus)}\n`);
  console.log(JSON.stringify({ corpus: args.outPath, ...stats }, null, 1));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
