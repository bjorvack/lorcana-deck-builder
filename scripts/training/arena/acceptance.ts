/**
 * Acceptance gate (self-play-league, task 5.2): the top-N MAP-Elites elites
 * play the league's REAL held-out members (kind 'real', opponents only) on
 * fresh seed bases, and the loop ships only if the aggregate win rate's 95%
 * bootstrap CI lower bound beats 0.5 — i.e. the CI excludes 0.5 from above.
 * A CI that straddles or sits below 0.5 is an honest NOT_SHIPPED (spec
 * "Self-play reporting and acceptance gate", design D2a).
 *
 * Referee selection (D2a): if an IS-MCTS gate verdict file
 * (`scripts/training/data/arena/is-mcts/verdict-i<iters>.json`) says PASS,
 * the IS-MCTS evaluator at that iteration budget referees the acceptance
 * games (one strategy instance per seat per game — each carries its own
 * decision counter and simulation engine). Otherwise the shipped heuristic
 * bot referees and `refereeFallback: true` is recorded in the report.
 *
 * Fresh seed ranges (disjoint from every search/gate seed; master = the run's
 * master seed, 20261122 below):
 *   search league bases   master + memberIndex·1_000              (schedule.ts)
 *   search mutant rng     master + 1_000_003 + gen·10_007 + i·101 (map-elites.ts)
 *   search scatter rng    master + 2_000_003 + gen·10_007         (map-elites.ts)
 *   IS-MCTS gate seeds    base 1, per-pair strings "1-<pair>"     (is-mcts-gate.ts)
 *   acceptance decks      master + 50_000_000 + deckIndex·10_000
 *   acceptance members    deckBase + memberIndex·1_000            (schedule.ts)
 *   bootstrap rng         master + 60_000_000 (rng stream only — never a game seed)
 * With ≤ 9 real members and ≤ 999 games per member the per-member windows
 * stay inside a deck's 10_000-wide stride; runAcceptance enforces that bound.
 *
 * Pairing + stopping reuse schedule.ts unchanged: per-deck member seed bases
 * come from `memberSeedBase`, per-game seeds from `seedForGame`, and SPRT
 * stops decided pairings early. The aggregate CI resamples the pooled per-game
 * outcomes (1 win / 0 non-win — incomplete games count as non-wins, the same
 * convention the league score uses).
 *
 * Usage:
 *   npx tsx scripts/training/arena/acceptance.ts \
 *     --league scripts/training/data/arena/selfplay/league-<commit8>.json \
 *     --archive scripts/training/data/arena/selfplay/archive-<commit8>-<seed>.json \
 *     [--top 4] [--games-per-member 24] [--batch-size 8] \
 *     [--master-seed 20261122] [--league-seed 20261122] \
 *     [--report public/data/selfplay.report.json] [--search-summary <path>]
 *
 * The CLI builds the full selfplay.report.json (task 5.1), writes it,
 * re-reads and schema-checks it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../prng';
import type { CardMap } from './card-map';
import type { EngineCatalog } from './engine-cards';
import type { SimCardsMaps } from './is-mcts';
import type { League } from './league';
import { type BootstrapCi, bootstrapCi } from './league-score';
import { summaryPathFor } from './map-elites';
import type { ArchiveEntry, ElitesArchive } from './map-elites-archive';
import {
  type BatchPlayer,
  DEFAULT_BATCH_SIZE,
  DEFAULT_REFEREE,
  evaluateCandidateVsLeague,
  MEMBER_SEED_SPACING,
  seedForGame,
} from './schedule';
import { buildSelfPlayPool } from './selfplay-pool';
import {
  buildSelfPlayReport,
  type IsMctsGateStatus,
  REPORT_PATH,
  type ReportVerdict,
  readSelfPlayReport,
  writeSelfPlayReport,
} from './selfplay-report';

const ARENA_DIR = import.meta.dirname;
/** is-mcts-gate.ts writes verdict-i<iterations>.json here (read-only for us) */
export const IS_MCTS_DIR = path.resolve(
  ARENA_DIR,
  '..',
  'data',
  'arena',
  'is-mcts',
);

// ---- fresh seed ranges (see header) ----

export const ACCEPTANCE_SEED_OFFSET = 50_000_000;
export const ACCEPTANCE_DECK_STRIDE = 10_000;
/** rng stream for the aggregate bootstrap — not a game seed */
export const ACCEPTANCE_BOOTSTRAP_SEED_OFFSET = 60_000_000;

/** seed-range start of the acceptance evaluation (deck 0's base) */
export function acceptanceBaseSeed(masterSeed: number): number {
  return (masterSeed + ACCEPTANCE_SEED_OFFSET) >>> 0;
}

/** per-deck acceptance master seed; member bases derive via memberSeedBase */
export function acceptanceDeckSeed(
  masterSeed: number,
  deckIndex: number,
): number {
  return (
    (masterSeed +
      ACCEPTANCE_SEED_OFFSET +
      deckIndex * ACCEPTANCE_DECK_STRIDE) >>>
    0
  );
}

// ---- IS-MCTS referee gate verdicts (read-only) ----

export interface IsMctsGateRecord {
  iterations: number;
  seedBase: number;
  games: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
  verdict: 'PASS' | 'FAIL';
  referee: string;
  path: string;
}

/** minimal shape of is-mcts-gate.ts's GateVerdict file */
interface GateVerdictFile {
  seedBase?: number;
  games?: number;
  winRate?: number;
  ci?: { low?: number; high?: number };
  verdict?: string;
  referee?: string;
}

/** read every verdict-i<iterations>.json in the gate output dir (sorted) */
export function readIsMctsVerdicts(dir: string): IsMctsGateRecord[] {
  if (!existsSync(dir)) return [];
  const records: IsMctsGateRecord[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = /^verdict-i(\d+)\.json$/.exec(name);
    if (!match) continue;
    const filePath = path.join(dir, name);
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as GateVerdictFile;
    if (raw.verdict !== 'PASS' && raw.verdict !== 'FAIL') {
      throw new Error(`${filePath} carries an unknown gate verdict`);
    }
    records.push({
      iterations: Number(match[1]),
      seedBase: raw.seedBase ?? 1,
      games: raw.games ?? 0,
      winRate: raw.winRate ?? 0,
      ciLow: raw.ci?.low ?? 0,
      ciHigh: raw.ci?.high ?? 0,
      verdict: raw.verdict,
      referee: raw.referee ?? DEFAULT_REFEREE,
      path: filePath,
    });
  }
  return records;
}

export interface RefereeDecision {
  /** strategy id the acceptance games are played (and recorded) under */
  referee: string;
  /** true when no IS-MCTS PASS verdict existed and the heuristic bot refereed */
  refereeFallback: boolean;
  /** the PASS verdict that promoted IS-MCTS to referee (null on fallback) */
  isMctsVerdict: IsMctsGateRecord | null;
}

/**
 * D2a referee selection: the LOWEST iteration budget with a PASS verdict is
 * the shipped referee (the cheaper budget that earned it); any FAIL-only
 * state — or no verdict file at all, e.g. the gate still running — keeps the
 * shipped heuristic bot with refereeFallback: true.
 */
export function resolveReferee(verdicts: IsMctsGateRecord[]): RefereeDecision {
  const pass = verdicts
    .filter((record) => record.verdict === 'PASS')
    .sort((a, b) => a.iterations - b.iterations)[0];
  if (pass) {
    return {
      referee: `is-mcts(i${pass.iterations})`,
      refereeFallback: false,
      isMctsVerdict: pass,
    };
  }
  return {
    referee: DEFAULT_REFEREE,
    refereeFallback: true,
    isMctsVerdict: null,
  };
}

/**
 * The gate record the report should show: the verdict that decided the
 * referee outcome — the PASS (lowest iterations) when one exists, else the
 * highest-iteration FAIL (the latest gate state), else null (report PENDING).
 */
export function reportGateRecord(
  verdicts: IsMctsGateRecord[],
): IsMctsGateRecord | null {
  const pass = verdicts
    .filter((record) => record.verdict === 'PASS')
    .sort((a, b) => a.iterations - b.iterations)[0];
  if (pass) return pass;
  const fails = verdicts
    .filter((record) => record.verdict === 'FAIL')
    .sort((a, b) => a.iterations - b.iterations);
  return fails[fails.length - 1] ?? null;
}

// ---- acceptance core (pure; the game player is injected) ----

export const DEFAULT_TOP_N = 4;
export const DEFAULT_ACCEPTANCE_GAMES_PER_MEMBER = 24;

/**
 * Top-N archive elites in fitness order (ties broken by cell key ascending —
 * deterministic selection).
 */
export function topElites(archive: ElitesArchive, n: number): ArchiveEntry[] {
  return Object.values(archive.cells)
    .sort(
      (a, b) =>
        b.fitness - a.fitness ||
        (a.cellKey < b.cellKey ? -1 : a.cellKey > b.cellKey ? 1 : 0),
    )
    .slice(0, Math.max(0, n));
}

/** the league restricted to its held-out real members (opponents only) */
export function realSubLeague(league: League): League {
  return {
    ...league,
    members: league.members.filter((member) => member.kind === 'real'),
  };
}

/** SHIPPED iff the 95% bootstrap CI lower bound beats 0.5 (excludes 0.5 from above) */
export function acceptanceVerdict(ci: {
  low: number;
  high?: number;
}): ReportVerdict {
  return ci.low > 0.5 ? 'SHIPPED' : 'NOT_SHIPPED';
}

export interface AcceptanceDeckResult {
  cellKey: string;
  fitness: number;
  masterSeed: number;
  games: number;
  wins: number;
  winRate: number;
  perMember: Array<{
    memberId: string;
    seedBase: number;
    games: number;
    wins: number;
    stopped: boolean;
    decision: 'accept' | 'reject' | null;
  }>;
}

export interface AcceptanceResult {
  decks: AcceptanceDeckResult[];
  games: number;
  wins: number;
  winRate: number;
  ci: BootstrapCi;
  verdict: ReportVerdict;
}

export interface AcceptanceOptions {
  archive: ElitesArchive;
  league: League;
  /** injected game player (fake in tests, cached arena playGame in the CLI) */
  play: BatchPlayer;
  masterSeed: number;
  /** strategy id the games are played (and recorded) under */
  referee: string;
  topN?: number;
  gamesPerMember?: number;
  batchSize?: number;
  bootstrapReps?: number;
}

/**
 * Evaluate the top-N elites against the league's real members only, pool the
 * per-game outcomes and decide SHIPPED / NOT_SHIPPED on the bootstrap CI.
 */
export function runAcceptance(opts: AcceptanceOptions): AcceptanceResult {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const gamesPerMember =
    opts.gamesPerMember ?? DEFAULT_ACCEPTANCE_GAMES_PER_MEMBER;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const subLeague = realSubLeague(opts.league);
  if (subLeague.members.length === 0) {
    throw new Error(
      'the league has no real members — acceptance plays the held-out ' +
        'tournament decks only; reseed the league',
    );
  }
  // keep the per-member windows inside one deck's 10_000-wide stride
  if (
    subLeague.members.length * MEMBER_SEED_SPACING + gamesPerMember >
    ACCEPTANCE_DECK_STRIDE
  ) {
    throw new Error(
      `acceptance seed windows collide: ${subLeague.members.length} real ` +
        `members × ${MEMBER_SEED_SPACING} + ${gamesPerMember} games exceeds ` +
        `the deck stride ${ACCEPTANCE_DECK_STRIDE}`,
    );
  }
  const elites = topElites(opts.archive, topN);
  if (elites.length === 0) {
    throw new Error(
      'the archive has no cells — run the MAP-Elites search first',
    );
  }

  const decks: AcceptanceDeckResult[] = [];
  const pooled: number[] = [];
  for (const [deckIndex, elite] of elites.entries()) {
    const masterSeed = acceptanceDeckSeed(opts.masterSeed, deckIndex);
    const evaluation = evaluateCandidateVsLeague(elite.deck, subLeague, {
      play: opts.play,
      masterSeed,
      gamesPerMember,
      batchSize,
      referee: opts.referee,
    });
    const perMember = evaluation.results.map((result) => ({
      memberId: result.memberId,
      seedBase: result.seedBase,
      games: result.games,
      wins: result.wins,
      stopped: result.stopped,
      decision: result.decision,
    }));
    const games = perMember.reduce((sum, member) => sum + member.games, 0);
    const wins = perMember.reduce((sum, member) => sum + member.wins, 0);
    // pooled outcomes: `wins` ones, the rest (losses + incomplete) zeros —
    // the multiset is all a bootstrap over per-game outcomes needs
    for (let i = 0; i < wins; i++) pooled.push(1);
    for (let i = 0; i < games - wins; i++) pooled.push(0);
    decks.push({
      cellKey: elite.cellKey,
      fitness: elite.fitness,
      masterSeed,
      games,
      wins,
      winRate: games > 0 ? wins / games : 0,
      perMember,
    });
  }

  const games = pooled.length;
  const wins = pooled.reduce((sum, outcome) => sum + outcome, 0);
  const ci = bootstrapCi(pooled, {
    reps: opts.bootstrapReps ?? 1000,
    rng: mulberry32((opts.masterSeed + ACCEPTANCE_BOOTSTRAP_SEED_OFFSET) >>> 0),
  });
  const winRate = games > 0 ? wins / games : 0;
  return { decks, games, wins, winRate, ci, verdict: acceptanceVerdict(ci) };
}

// ---- IS-MCTS referee player (D2a PASS path; lazily imports the engine) ----

interface IsMctsPlayerDeps {
  catalog: EngineCatalog;
  cardMap: CardMap;
  iterations: number;
}

/**
 * Batch player for the IS-MCTS referee: builds the deterministic cardsMaps
 * once per game (mirroring is-mcts-gate.ts playPair) and gives EACH seat its
 * own evaluator instance — a shared instance would carry one seat's decision
 * counter into the other's. Not disk-cached: acceptance is a one-shot gate,
 * the fallback heuristic path uses the arena cache instead.
 */
async function isMctsBatchPlayer(deps: IsMctsPlayerDeps): Promise<BatchPlayer> {
  // heavy imports stay lazy: the test import graph must stay engine-free
  const { createRecordCardCatalog } = await import('@tcg/shared/cards/catalog');
  const { deterministicCardsMaps, playGame, strategyById } = await import(
    './play'
  );
  const { isMctsStrategy } = await import('./is-mcts');
  const base = strategyById(DEFAULT_REFEREE) as unknown as Parameters<
    typeof isMctsStrategy
  >[0];
  const cardCatalog = createRecordCardCatalog(
    'lorcana:cards',
    deps.catalog.byId,
  );
  const toEngine = (cards: Record<string, number>): Record<string, number> =>
    Object.fromEntries(
      Object.entries(cards).map(([identity, count]) => {
        const entry = deps.cardMap.byIdentity[identity];
        if (!entry)
          throw new Error(`identity ${identity} has no engine mapping`);
        return [entry.engineId, count];
      }),
    );
  return (request) => {
    const results: Array<{ winner: string | null }> = [];
    for (let game = request.from; game < request.from + request.count; game++) {
      const seed = seedForGame(request.seedBase, game);
      const cardsMaps = deterministicCardsMaps(
        [
          { owner: 'p1', cards: toEngine(request.deckA) },
          { owner: 'p2', cards: toEngine(request.deckB) },
        ],
        deps.catalog.byId,
      ) as unknown as SimCardsMaps;
      const evaluator = (): ReturnType<typeof isMctsStrategy> =>
        isMctsStrategy(base, {
          seed,
          iterations: deps.iterations,
          cardsMaps,
          cardCatalog,
        });
      const record = playGame({
        catalog: deps.catalog,
        cardMap: deps.cardMap,
        deckA: request.deckA,
        deckB: request.deckB,
        strategyA: evaluator(),
        strategyB: evaluator(),
        seed,
      });
      results.push({ winner: record.winner });
    }
    return results;
  };
}

// ---- CLI ----

interface AcceptanceArgs {
  league: string;
  archive: string;
  top: number;
  gamesPerMember: number;
  batchSize: number;
  masterSeed: number;
  leagueSeed: number;
  report: string;
  searchSummary: string | null;
}

function parseArgs(argv: string[]): AcceptanceArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const resolveInput = (flag: string): string | null => {
    const value = get(flag);
    return value ? path.resolve(value) : null;
  };
  const league = resolveInput('--league');
  const archive = resolveInput('--archive');
  if (!league) throw new Error('--league <file> is required');
  if (!archive) throw new Error('--archive <file> is required');
  return {
    league,
    archive,
    top: Number(get('--top') ?? DEFAULT_TOP_N),
    gamesPerMember: Number(
      get('--games-per-member') ?? DEFAULT_ACCEPTANCE_GAMES_PER_MEMBER,
    ),
    batchSize: Number(get('--batch-size') ?? DEFAULT_BATCH_SIZE),
    masterSeed: Number(get('--master-seed') ?? 20261122),
    leagueSeed: Number(get('--league-seed') ?? 20261122),
    report: get('--report') ? path.resolve(get('--report')!) : REPORT_PATH,
    searchSummary: resolveInput('--search-summary'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // heavy imports stay lazy (same pattern as the map-elites CLI)
  const { buildCanonicalRegistry } = await import('../canonical');
  const { buildCardMap } = await import('./card-map');
  const { loadCards } = await import('./cards');
  const { loadEngineCatalog } = await import('./engine-cards');
  const { cachedBatchPlayer } = await import('./evaluate-candidate');
  const { loadArchive } = await import('./map-elites-archive');
  const { loadLeague } = await import('./league');

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

  const archive = await loadArchive(args.archive);
  const league = await loadLeague(args.league);
  const era = catalog.engineCommit.slice(0, 8);
  for (const [name, commit] of [
    ['archive', archive.engineCommit],
    ['league', league.engineCommit],
    ['card map', cardMap.engineCommit],
  ] as const) {
    if (commit.slice(0, 8) !== era) {
      throw new Error(
        `${name} era ${commit.slice(0, 8)} ≠ engine era ${era} — rerun in the engine's era`,
      );
    }
  }

  // coverage gate: fail loudly before any games when the engine lags
  const pool = buildSelfPlayPool(cardMap);

  const summaryPath = args.searchSummary ?? summaryPathFor(args.archive);
  if (!existsSync(summaryPath)) {
    throw new Error(
      `search summary ${summaryPath} not found — run map-elites.ts first`,
    );
  }
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
    perGeneration?: unknown[];
    population?: number;
    gamesPerMember?: number;
  };
  if (
    !Array.isArray(summary.perGeneration) ||
    typeof summary.population !== 'number' ||
    typeof summary.gamesPerMember !== 'number'
  ) {
    throw new Error(`${summaryPath} is not a map-elites run summary`);
  }

  const verdicts = readIsMctsVerdicts(IS_MCTS_DIR);
  const decision = resolveReferee(verdicts);
  const play = decision.isMctsVerdict
    ? await isMctsBatchPlayer({
        catalog,
        cardMap,
        iterations: decision.isMctsVerdict.iterations,
      })
    : cachedBatchPlayer({
        catalog,
        cardMap,
        engineCommit: catalog.engineCommit,
        mapFormat: cardMap.format,
        referee: decision.referee,
      });

  const result = runAcceptance({
    archive,
    league,
    play,
    masterSeed: args.masterSeed,
    referee: decision.referee,
    topN: args.top,
    gamesPerMember: args.gamesPerMember,
    batchSize: args.batchSize,
  });

  const gateRecord = reportGateRecord(verdicts);
  const report = buildSelfPlayReport({
    format: league.format,
    engineCommit: catalog.engineCommit,
    seeds: {
      master: args.masterSeed,
      // is-mcts-gate.ts's --seed-base (confirmed from the verdict file when
      // one exists; its CLI default otherwise)
      gate: gateRecord?.seedBase ?? 1,
      league: args.leagueSeed,
      search: archive.seed,
      acceptance: acceptanceBaseSeed(args.masterSeed),
    },
    coverage: { cardMap, pool },
    league: { path: args.league, league },
    search: {
      archivePath: args.archive,
      run: {
        generations: summary.perGeneration.length,
        population: summary.population,
        gamesPerMember: summary.gamesPerMember,
      },
      archive,
    },
    isMctsGate: {
      name: 'is-mcts-referee',
      iterations: gateRecord?.iterations ?? null,
      games: gateRecord?.games ?? 0,
      winRate: gateRecord?.winRate ?? 0,
      ciLow: gateRecord?.ciLow ?? 0,
      ciHigh: gateRecord?.ciHigh ?? 0,
      verdict: (gateRecord?.verdict ?? 'PENDING') as IsMctsGateStatus,
      referee: decision.referee,
    },
    acceptance: {
      referee: decision.referee,
      refereeFallback: decision.refereeFallback,
      isMctsIterations: decision.isMctsVerdict?.iterations ?? null,
      seedBase: acceptanceBaseSeed(args.masterSeed),
      decks: result.decks,
      games: result.games,
      wins: result.wins,
      winRate: result.winRate,
      ci: result.ci,
      verdict: result.verdict,
    },
  });

  const reportPath = await writeSelfPlayReport(args.report, report);
  // post-run verification (task 5.1): re-read and schema-check
  await readSelfPlayReport(reportPath);
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        referee: decision.referee,
        refereeFallback: decision.refereeFallback,
        isMctsGate: gateRecord?.verdict ?? 'PENDING',
        decks: result.decks.map((deck) => ({
          cellKey: deck.cellKey,
          fitness: deck.fitness,
          winRate: deck.winRate,
          games: deck.games,
        })),
        games: result.games,
        wins: result.wins,
        winRate: result.winRate,
        ci: result.ci,
        verdict: result.verdict,
      },
      null,
      1,
    ),
  );
  if (result.verdict === 'NOT_SHIPPED') process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
