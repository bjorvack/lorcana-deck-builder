/**
 * Substitution-delta stratum (learned-deck-generator, task 1.4; design D1b):
 * arena-measured leave-one-out deltas on elite decks — replace one card with
 * a pool candidate, play the paired-seed comparison, emit (context,
 * card-out → card-in, Δ) pairs for the corpus builder.
 *
 * PRE-COMMITTED scope (do not retune): the top-8 elites by fitness across
 * both archive runs, 6 replacement candidates per elite drawn seeded from the
 * self-play pool, 40 games per paired deck. Paired means both decks of a
 * comparison are evaluated on identical per-member seed bases (schedule.ts's
 * twin mode / CRN) — candidate and context each play every league member
 * from seat p1, so Δ = fitness(in) − fitness(out) is a paired advantage on
 * shared shuffles. With the 10-member league, 4 games per member give the
 * pre-committed 40 games per deck and 8×6×40×2 = 3,840 games per run.
 *
 * Decks are evaluated through map-elites' `--eval-chunk` child mode (see
 * chunk-eval.ts): the child wires the league schedule + heuristic referee +
 * arena disk cache; this module only plans work and merges parts.
 *
 * Legality is never learned or assumed: the candidate deck must clear
 * elitesDeckProblems (pool membership, copy limits, declared inks, full
 * src/rules validateDeck) — the 59-card context is an intermediate state
 * that is never played, only validated structurally (the corpus builder
 * re-checks context = deck − one cardOut).
 *
 * Determinism: mulberry32 seeded per (master seed, elite deck id, stream);
 * elite selection and candidate drawing depend only on the archives, the
 * pool and the seed. Re-running with identical flags reproduces the same
 * pairs and deltas (the report's wallMs is operational, like map-elites
 * summaries; the corpus artifact is the byte-identical contract).
 *
 * Usage:
 *   npx tsx scripts/training/generator/deltas.ts \
 *     --archive <archive.json> [--archive ...] --league <league.json> \
 *     [--seed 20261123] [--elites 8] [--candidates 6] \
 *     [--games-per-member 4] [--parallel 3] [--out <report.json>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../../src/data/types';
import {
  declaredInks,
  elitesDeckProblems,
  type LegalPool,
} from '../arena/map-elites-mutation';
import { DEFAULT_REFEREE } from '../arena/schedule';
import { mulberry32 } from '../prng';
import { type EvalChunkRequest, evaluateChunks } from './chunk-eval';
import {
  buildCorpus,
  type SubstitutionDeltaInput,
  sortDeckRecord,
  stableDeckKey,
  stableStringify,
} from './corpus';

// ---- pre-committed parameters (task 1.4) ----

export const DELTAS_MASTER_SEED = 20261123;
export const DELTA_ELITES = 8;
export const DELTA_CANDIDATES_PER_ELITE = 6;
/** per league member: 4 × the 10-member league = 40 games per paired deck */
export const DELTA_GAMES_PER_MEMBER = 4;
export const DELTA_BATCH_SIZE = 4;
export const DELTA_PARALLEL = 3;

// ---- archive reading (corpus.ts's structural type omits cell fitness) ----

export interface DeltaArchiveCell {
  cellKey: string;
  deck: Record<string, number>;
  fitness: number;
}

export interface DeltaArchive {
  format: string;
  engineCommit: string;
  seed: number;
  cells: Record<string, DeltaArchiveCell>;
}

/** load + validate an archive artifact for delta work (cell fitness required) */
export function loadDeltaArchive(filePath: string): DeltaArchive {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as DeltaArchive;
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
      typeof cell.fitness !== 'number' ||
      !Number.isFinite(cell.fitness) ||
      cell.deck === null ||
      typeof cell.deck !== 'object'
    ) {
      throw new Error(`${filePath} contains a malformed archive cell: ${key}`);
    }
  }
  return raw;
}

/** structural minimum of the league artifact the CLI reads */
export interface DeltaLeague {
  format: string;
  engineCommit: string;
  members: Array<{
    id: string;
    kind: string;
    deck: Record<string, number>;
    [key: string]: unknown;
  }>;
}

export function loadDeltaLeague(filePath: string): DeltaLeague {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as DeltaLeague;
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
      member.deck === null ||
      typeof member.deck !== 'object'
    ) {
      throw new Error(`${filePath} contains a malformed league member`);
    }
  }
  return raw;
}

// ---- elite selection ----

export interface DeltaElite {
  /** corpus deck id: `archive:<archiveSeed>:<cellKey>` */
  deckId: string;
  cellKey: string;
  fitness: number;
  deck: Record<string, number>;
}

/**
 * Top-`count` elites by fitness across all archive runs. Compositions are
 * deduped first-wins in collectDeckSources' walk order (archive array order,
 * sorted cells) — a selected deck id is guaranteed to exist in the corpus's
 * deck map even when two runs hold the same deck in different cells.
 */
export function selectTopElites(
  archives: DeltaArchive[],
  count = DELTA_ELITES,
): DeltaElite[] {
  const unique: DeltaElite[] = [];
  const seen = new Set<string>();
  for (const archive of archives) {
    for (const cellKey of Object.keys(archive.cells).sort()) {
      const cell = archive.cells[cellKey]!;
      const key = stableDeckKey(cell.deck);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({
        deckId: `archive:${archive.seed}:${cellKey}`,
        cellKey,
        fitness: cell.fitness,
        deck: sortDeckRecord(cell.deck),
      });
    }
  }
  return unique
    .sort(
      (a, b) =>
        b.fitness - a.fitness ||
        (a.deckId < b.deckId ? -1 : a.deckId > b.deckId ? 1 : 0),
    )
    .slice(0, count);
}

// ---- replacement candidate drawing ----

/**
 * Pool identities that could join the deck as one copy: inks within the
 * deck's declared inks, one more copy within the identity's limit.
 */
export function eligibleReplacementIds(
  deck: Record<string, number>,
  pool: LegalPool,
): number[] {
  const inks = declaredInks(deck, pool);
  return [...pool.keys()]
    .sort((a, b) => a - b)
    .filter((id) => {
      const entry = pool.get(id);
      if (!entry) return false;
      if (!entry.inks.every((ink) => inks.includes(ink))) return false;
      return (deck[String(id)] ?? 0) + 1 <= entry.maxCopies;
    });
}

/** seeded Fisher–Yates draw of `count` replacement candidates */
export function drawReplacementCandidates(
  deck: Record<string, number>,
  pool: LegalPool,
  rng: () => number,
  count: number,
): number[] {
  const eligible = eligibleReplacementIds(deck, pool);
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
  }
  return eligible.slice(0, Math.max(0, count));
}

// ---- substitution construction + legality gate ----

export interface SubstitutionWork {
  elite: DeltaElite;
  cardOut: string;
  cardIn: string;
  /** deck − one cardOut (59 cards; never played, corpus-validated) */
  context: Record<string, number>;
  /** context + one cardIn (60 cards; must clear the legality gate) */
  candidate: Record<string, number>;
}

export interface SubstitutionSkipped {
  deckId: string;
  cellKey: string;
  cardIn: string | null;
  reason: string;
}

function removeOneCopy(
  deck: Record<string, number>,
  id: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(deck)) {
    if (key === id) {
      if (count - 1 > 0) out[key] = count - 1;
    } else {
      out[key] = count;
    }
  }
  return out;
}

function addOneCopy(
  deck: Record<string, number>,
  id: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(deck)) out[key] = count;
  out[id] = (out[id] ?? 0) + 1;
  return out;
}

/**
 * Build one substitution and gate the candidate deck end to end. Returns a
 * rejection reason instead of work when the pair is degenerate (card-in
 * equals card-out) or the candidate deck is illegal — rejections are
 * recorded, never silently retried with a different card.
 */
export function buildSubstitution(
  elite: DeltaElite,
  cardOut: string,
  cardIn: string,
  pool: LegalPool,
  cards: readonly Card[],
): { work?: SubstitutionWork; reason?: string } {
  if ((elite.deck[cardOut] ?? 0) < 1) {
    return { reason: `card-out-${cardOut}-not-in-deck` };
  }
  if (cardOut === cardIn) return { reason: 'card-in-equals-card-out' };
  const context = removeOneCopy(elite.deck, cardOut);
  const candidate = addOneCopy(context, cardIn);
  const problems = elitesDeckProblems(candidate, pool, cards);
  if (problems.length > 0) {
    return { reason: `illegal:${problems.join('|')}` };
  }
  return {
    work: {
      elite,
      cardOut,
      cardIn,
      context: sortDeckRecord(context),
      candidate: sortDeckRecord(candidate),
    },
  };
}

// ---- work planning ----

/**
 * Per-(elite, stream) RNG seed — FNV-1a over `<masterSeed>:<deckId>#<stream>`,
 * the same text-hash pattern as corpus.sampleSeedFor, so adding elites or
 * streams never shifts existing draws. The master seed rides in the text
 * only: folding it into the offset basis would cancel against its own
 * leading digits (5^C ^ '5' === 6^C ^ '6') and collide streams.
 */
export function deltaSeedFor(
  masterSeed: number,
  deckId: string,
  stream: number,
): number {
  const text = `${masterSeed}:${deckId}#${stream}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** card-out redraw attempts before a pair is skipped as degenerate */
const CARD_OUT_ATTEMPTS = 8;

export interface DeltaWorkPlan {
  work: SubstitutionWork[];
  skipped: SubstitutionSkipped[];
}

/**
 * Plan every (elite, candidate) substitution: per elite, a seeded draw of
 * `candidatesPerElite` pool candidates (stream 0), then per candidate a
 * seeded card-out pick (stream index + 1) that avoids the card-in. Pure and
 * deterministic given (archives, pool, cards, seed).
 */
export function planDeltaWork(opts: {
  elites: DeltaElite[];
  pool: LegalPool;
  cards: readonly Card[];
  masterSeed: number;
  candidatesPerElite: number;
}): DeltaWorkPlan {
  const work: SubstitutionWork[] = [];
  const skipped: SubstitutionSkipped[] = [];
  for (const elite of opts.elites) {
    const drawRng = mulberry32(deltaSeedFor(opts.masterSeed, elite.deckId, 0));
    const cardIns = drawReplacementCandidates(
      elite.deck,
      opts.pool,
      drawRng,
      opts.candidatesPerElite,
    );
    if (cardIns.length === 0) {
      skipped.push({
        deckId: elite.deckId,
        cellKey: elite.cellKey,
        cardIn: null,
        reason: 'no-eligible-candidates',
      });
      continue;
    }
    for (const [index, cardIn] of cardIns.entries()) {
      const pairRng = mulberry32(
        deltaSeedFor(opts.masterSeed, elite.deckId, index + 1),
      );
      const identities = Object.keys(elite.deck).sort();
      let cardOut: string | null = null;
      for (let attempt = 0; attempt < CARD_OUT_ATTEMPTS; attempt++) {
        const pick = identities[Math.floor(pairRng() * identities.length)]!;
        if (pick !== String(cardIn)) {
          cardOut = pick;
          break;
        }
      }
      if (cardOut === null) {
        skipped.push({
          deckId: elite.deckId,
          cellKey: elite.cellKey,
          cardIn: String(cardIn),
          reason: 'card-in-equals-only-identity',
        });
        continue;
      }
      const built = buildSubstitution(
        elite,
        cardOut,
        String(cardIn),
        opts.pool,
        opts.cards,
      );
      if (built.reason || !built.work) {
        skipped.push({
          deckId: elite.deckId,
          cellKey: elite.cellKey,
          cardIn: String(cardIn),
          reason: built.reason ?? 'unknown',
        });
        continue;
      }
      work.push(built.work);
    }
  }
  return { work, skipped };
}

// ---- evaluation + corpus assembly ----

export interface PairEvaluation {
  /** fitness(candidate) − fitness(context) on the paired seed bases */
  delta: number;
  /** games simulated for both sides of the comparison */
  games: number;
  candidateFitness: number;
  contextFitness: number;
}

export interface DeltaPair extends SubstitutionWork {
  delta: number;
  games: number;
  candidateFitness: number;
  contextFitness: number;
}

/**
 * Merge evaluations into delta pairs in work order. `evaluate` plays the
 * candidate deck and its context on the same per-member seed bases (the
 * league schedule's twin mode) — the paired-seed semantics of schedule.ts.
 */
export async function evaluateDeltaPairs(
  work: SubstitutionWork[],
  evaluate: (items: SubstitutionWork[]) => Promise<PairEvaluation[]>,
): Promise<DeltaPair[]> {
  const evaluations = await evaluate(work);
  if (evaluations.length !== work.length) {
    throw new Error(
      `evaluator returned ${evaluations.length} results for ${work.length} pairs`,
    );
  }
  return work.map((item, index) => {
    const evaluation = evaluations[index]!;
    if (!Number.isFinite(evaluation.delta)) {
      throw new Error(
        `pair ${item.elite.deckId} ${item.cardOut}→${item.cardIn}: delta is not finite`,
      );
    }
    return {
      ...item,
      delta: evaluation.delta,
      games: evaluation.games,
      candidateFitness: evaluation.candidateFitness,
      contextFitness: evaluation.contextFitness,
    };
  });
}

/** corpus builder input for one measured delta (pinned SubstitutionDeltaInput shape) */
export function toDeltaInputs(pairs: DeltaPair[]): SubstitutionDeltaInput[] {
  return pairs.map((pair) => ({
    deckId: pair.elite.deckId,
    context: pair.context,
    cardOut: pair.cardOut,
    cardIn: pair.cardIn,
    delta: pair.delta,
  }));
}

/** the chunk request for one pair: candidate vs league with context as twin */
export function pairChunkRequest(
  index: number,
  pair: SubstitutionWork,
  league: unknown,
  masterSeed: number,
  gamesPerMember: number,
  batchSize: number,
): EvalChunkRequest {
  return {
    index,
    deck: pair.candidate,
    parentDeck: pair.context,
    league,
    masterSeed,
    gamesPerMember,
    batchSize,
    referee: DEFAULT_REFEREE,
    twinPaired: true,
  };
}

export interface DeltaTotals {
  pairs: number;
  games: number;
  meanDelta: number;
  minDelta: number;
  maxDelta: number;
  medianDelta: number;
  positive: number;
  negative: number;
  zero: number;
}

export function deltaTotals(pairs: DeltaPair[]): DeltaTotals {
  const deltas = pairs.map((pair) => pair.delta).sort((a, b) => a - b);
  const round = (value: number): number => Number(value.toFixed(6));
  const mean =
    deltas.length === 0
      ? 0
      : deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
  const median =
    deltas.length === 0 ? 0 : deltas[Math.floor(0.5 * (deltas.length - 1))]!;
  return {
    pairs: pairs.length,
    games: pairs.reduce((sum, pair) => sum + pair.games, 0),
    meanDelta: round(mean),
    minDelta: deltas.length === 0 ? 0 : round(deltas[0]!),
    maxDelta: deltas.length === 0 ? 0 : round(deltas[deltas.length - 1]!),
    medianDelta: round(median),
    positive: deltas.filter((delta) => delta > 0).length,
    negative: deltas.filter((delta) => delta < 0).length,
    zero: deltas.filter((delta) => delta === 0).length,
  };
}

// ---- CLI ----

export interface DeltaRunReport {
  stratum: 'substitution-delta';
  engineCommit: string;
  masterSeed: number;
  elites: number;
  candidatesPerElite: number;
  gamesPerMember: number;
  gamesPerDeck: number;
  gamesPerPair: number;
  batchSize: number;
  referee: string;
  leagueMembers: number;
  eliteSources: Array<Pick<DeltaElite, 'deckId' | 'cellKey' | 'fitness'>>;
  pairs: Array<{
    deckId: string;
    cellKey: string;
    cardOut: string;
    cardIn: string;
    delta: number;
    games: number;
    candidateFitness: number;
    contextFitness: number;
  }>;
  skipped: SubstitutionSkipped[];
  totals: DeltaTotals;
  corpusOut: string;
  corpusStats: ReturnType<typeof buildCorpus>['stats'];
  wallMs: number;
  gamesPerSecond: number;
}

interface DeltaArgs {
  archivePaths: string[];
  leaguePath: string;
  seed: number;
  elites: number;
  candidates: number;
  gamesPerMember: number;
  batchSize: number;
  parallel: number;
  outPath: string;
  corpusOutPath: string;
}

const DEFAULT_OUT_DIR = resolve(import.meta.dirname, '..', 'data', 'generator');

function parseDeltaArgs(argv: string[]): DeltaArgs {
  const archivePaths: string[] = [];
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--archive') archivePaths.push(resolve(argv[++i]!));
  }
  const leaguePath = get('--league') ? resolve(get('--league')!) : '';
  if (archivePaths.length === 0)
    throw new Error('--archive <file> is required (repeatable)');
  if (!leaguePath) throw new Error('--league <file> is required');
  const seed = Number(get('--seed') ?? DELTAS_MASTER_SEED);
  const commit8 = loadDeltaArchive(archivePaths[0]!).engineCommit.slice(0, 8);
  return {
    archivePaths: [...archivePaths].sort(),
    leaguePath,
    seed,
    elites: Number(get('--elites') ?? DELTA_ELITES),
    candidates: Number(get('--candidates') ?? DELTA_CANDIDATES_PER_ELITE),
    gamesPerMember: Number(get('--games-per-member') ?? DELTA_GAMES_PER_MEMBER),
    batchSize: Number(get('--batch-size') ?? DELTA_BATCH_SIZE),
    parallel: Math.max(1, Number(get('--parallel') ?? DELTA_PARALLEL)),
    outPath: get('--out')
      ? resolve(get('--out')!)
      : resolve(DEFAULT_OUT_DIR, `deltas-${commit8}-${seed}.json`),
    corpusOutPath: get('--corpus-out')
      ? resolve(get('--corpus-out')!)
      : resolve(DEFAULT_OUT_DIR, `deltas-corpus-${commit8}-${seed}.json`),
  };
}

export async function runDeltasCli(args: DeltaArgs): Promise<DeltaRunReport> {
  // heavy imports stay lazy: the test import graph must stay engine-free
  const { loadCards } = await import('../arena/cards');
  const { buildCanonicalRegistry } = await import('../canonical');
  const { buildCardMap } = await import('../arena/card-map');
  const { loadEngineCatalog } = await import('../arena/engine-cards');
  const { legalSelfPlayIdentities } = await import('../arena/league');
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
  const league = loadDeltaLeague(args.leaguePath);
  if (league.engineCommit.slice(0, 8) !== catalog.engineCommit.slice(0, 8)) {
    throw new Error(
      `league era ${league.engineCommit.slice(0, 8)} ≠ engine era ${catalog.engineCommit.slice(0, 8)}`,
    );
  }
  const pool = legalSelfPlayIdentities(cards, cardMap);

  const archives = args.archivePaths.map((path) => loadDeltaArchive(path));
  for (const archive of archives) {
    if (archive.engineCommit.slice(0, 8) !== catalog.engineCommit.slice(0, 8)) {
      throw new Error(
        `archive era ${archive.engineCommit.slice(0, 8)} ≠ engine era ${catalog.engineCommit.slice(0, 8)}`,
      );
    }
  }
  const elites = selectTopElites(archives, args.elites);
  const plan = planDeltaWork({
    elites,
    pool,
    cards,
    masterSeed: args.seed,
    candidatesPerElite: args.candidates,
  });

  const started = Date.now();
  const requests = plan.work.map((pair, index) =>
    pairChunkRequest(
      index,
      pair,
      league,
      args.seed,
      args.gamesPerMember,
      args.batchSize,
    ),
  );
  const parts = await evaluateChunks(requests, {
    parallel: args.parallel,
    workDir: dirname(args.outPath),
    label: 'deltas',
  });
  // parts merge in request order (chunk-eval), so index i is work item i
  const pairs = await evaluateDeltaPairs(plan.work, async () =>
    parts.map((part) => ({
      delta: part.fitness - (part.twin?.fitness ?? 0),
      games: part.games + (part.twin?.games ?? 0),
      candidateFitness: part.fitness,
      contextFitness: part.twin?.fitness ?? 0,
    })),
  );
  const wallMs = Date.now() - started;

  const { corpus, stats } = buildCorpus({
    archives,
    league: {
      format: league.format,
      engineCommit: league.engineCommit,
      members: league.members.map(({ id, kind, deck }) => ({ id, kind, deck })),
    },
    substitutionDeltas: toDeltaInputs(pairs),
  });
  mkdirSync(dirname(args.corpusOutPath), { recursive: true });
  writeFileSync(args.corpusOutPath, `${stableStringify(corpus)}\n`);

  const gamesPerDeck = args.gamesPerMember * league.members.length;
  const totals = deltaTotals(pairs);
  const report: DeltaRunReport = {
    stratum: 'substitution-delta',
    engineCommit: catalog.engineCommit,
    masterSeed: args.seed,
    elites: args.elites,
    candidatesPerElite: args.candidates,
    gamesPerMember: args.gamesPerMember,
    gamesPerDeck,
    gamesPerPair: gamesPerDeck * 2,
    batchSize: args.batchSize,
    referee: DEFAULT_REFEREE,
    leagueMembers: league.members.length,
    eliteSources: elites.map(({ deckId, cellKey, fitness }) => ({
      deckId,
      cellKey,
      fitness,
    })),
    pairs: pairs.map(
      ({
        elite,
        cardOut,
        cardIn,
        delta,
        games,
        candidateFitness,
        contextFitness,
      }) => ({
        deckId: elite.deckId,
        cellKey: elite.cellKey,
        cardOut,
        cardIn,
        delta,
        games,
        candidateFitness,
        contextFitness,
      }),
    ),
    skipped: plan.skipped,
    totals,
    corpusOut: args.corpusOutPath,
    corpusStats: stats,
    wallMs,
    gamesPerSecond:
      wallMs > 0 && totals.games > 0
        ? Number((totals.games / (wallMs / 1000)).toFixed(3))
        : 0,
  };
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

async function main(): Promise<void> {
  const report = await runDeltasCli(parseDeltaArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 1));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
