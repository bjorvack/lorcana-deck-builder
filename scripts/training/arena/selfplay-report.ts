/**
 * Self-play run report (self-play-league, task 5.1): assembles
 * `public/data/selfplay.report.json` — engine pin, seed manifest, coverage
 * numbers, league composition, archive statistics and every gate verdict.
 *
 * Provenance of the sections:
 * - coverage: the live card map (`buildCardMap`, the same builder that emits
 *   `scripts/training/arena/card-map.json`) plus `buildSelfPlayPool` — pool
 *   size and pool coverage ratio over the fully-scripted identity pool.
 * - league: the league artifact as it stands after the run (promotions
 *   included), member `size` = card slots (sum of identity counts).
 * - search: the MAP-Elites archive plus the run summary the search CLI
 *   writes next to it (`<archive>.summary.json`).
 * - gates: the IS-MCTS referee gate (its verdict file, or PENDING when the
 *   gate had produced no verdict yet — zeros are the no-evidence sentinel)
 *   and the acceptance gate (see acceptance.ts).
 *
 * Field ordering is fixed by the builder (JSON.stringify preserves insertion
 * order). The report carries a real `generatedOn` timestamp: like the league
 * artifact it is operational; only the MAP-Elites archive is held to the
 * byte-reproducibility contract (design D3/D4).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CardMap, CoverageStatus } from './card-map';
import type { League, MemberKind } from './league';
import type { ArchiveStats, ElitesArchive } from './map-elites-archive';
import { archiveStats } from './map-elites-archive';
import type { SelfPlayPool } from './selfplay-pool';

/** repo-committed report path (D3: a committed summary, not meta-model payload) */
export const REPORT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'public',
  'data',
  'selfplay.report.json',
);

export type ReportVerdict = 'SHIPPED' | 'NOT_SHIPPED';

/**
 * IS-MCTS referee gate state. PENDING = no `verdict-i*.json` existed when the
 * report was written (the gate is still running); PASS/FAIL mirror the gate
 * file. On PENDING the numeric fields are the no-evidence sentinel (0) and
 * iterations is null.
 */
export type IsMctsGateStatus = 'PASS' | 'FAIL' | 'PENDING';

export interface ReportSeeds {
  /** master seed of the whole program run */
  master: number;
  /** IS-MCTS gate seed base (is-mcts-gate.ts --seed-base) */
  gate: number;
  /** league seeding seed (league.ts --seed) */
  league: number;
  /** MAP-Elites search master seed (map-elites.ts --seed = archive.seed) */
  search: number;
  /** acceptance seed-range start (acceptance.ts acceptanceBaseSeed) */
  acceptance: number;
}

export interface ReportCoverage {
  identities: number;
  mapped: number;
  coverageStatuses: Record<CoverageStatus, number>;
  partialIdentities: string[];
  /** identities in the fully-scripted self-play pool */
  poolSize: number;
  /** identities kept out of the pool (partial + unmapped) */
  poolExcluded: number;
  /** poolSize / identities */
  poolCoverage: number;
}

export interface ReportLeagueMember {
  id: string;
  kind: MemberKind;
  share: number;
  /** card slots (sum of identity counts) */
  size: number;
}

export interface ReportLeague {
  path: string;
  memberCount: number;
  byKind: Record<string, number>;
  members: ReportLeagueMember[];
}

/** subset of map-elites.ts RunSummary the report needs */
export interface SearchRunInfo {
  /** generations actually completed (summary.perGeneration.length) */
  generations: number;
  population: number;
  gamesPerMember: number;
}

export interface ReportSearch {
  archivePath: string;
  generations: number;
  population: number;
  gamesPerMember: number;
  archiveStats: ArchiveStats;
}

export interface IsMctsGateReport {
  name: 'is-mcts-referee';
  iterations: number | null;
  games: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
  verdict: IsMctsGateStatus;
  referee: string;
}

export interface AcceptanceGateReport {
  name: 'acceptance';
  games: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
  verdict: ReportVerdict;
  referee: string;
}

export type ReportGate = IsMctsGateReport | AcceptanceGateReport;

export interface ReportAcceptanceDeck {
  cellKey: string;
  /** archive fitness the deck qualified with */
  fitness: number;
  /** acceptance master seed for this deck (acceptanceDeckSeed) */
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

export interface ReportAcceptance {
  referee: string;
  /** true when no IS-MCTS PASS verdict existed and the heuristic bot refereed */
  refereeFallback: boolean;
  /** IS-MCTS iteration budget when it refereed, else null */
  isMctsIterations: number | null;
  /** acceptance seed-range start (per-deck bases derive from it) */
  seedBase: number;
  decks: ReportAcceptanceDeck[];
  games: number;
  wins: number;
  winRate: number;
  ci: { low: number; high: number; mean: number };
  verdict: ReportVerdict;
}

export interface SelfPlayReport {
  format: string;
  generatedOn: string;
  engineCommit: string;
  seeds: ReportSeeds;
  coverage: ReportCoverage;
  league: ReportLeague;
  search: ReportSearch;
  gates: ReportGate[];
  acceptance: ReportAcceptance;
  verdict: ReportVerdict;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const byKindOf = (league: League): Record<string, number> => {
  const byKind: Record<string, number> = {};
  for (const member of league.members)
    byKind[member.kind] = (byKind[member.kind] ?? 0) + 1;
  return byKind;
};

const deckSize = (deck: Record<string, number>): number =>
  Object.values(deck).reduce((sum, count) => sum + count, 0);

export interface SelfPlayReportInput {
  format: string;
  engineCommit: string;
  /** default: a fresh ISO timestamp — the report is operational (see header) */
  generatedOn?: string;
  seeds: ReportSeeds;
  /** the live card map (its coverage block feeds the report) + the gated pool */
  coverage: { cardMap: CardMap; pool: SelfPlayPool };
  league: { path: string; league: League };
  search: {
    archivePath: string;
    run: SearchRunInfo;
    archive: ElitesArchive;
  };
  isMctsGate: IsMctsGateReport;
  acceptance: ReportAcceptance;
}

/** Assemble the run report with a fixed field order (see header). */
export function buildSelfPlayReport(
  input: SelfPlayReportInput,
): SelfPlayReport {
  const coverage = input.coverage.cardMap.coverage;
  const total = coverage.identities;
  return {
    format: input.format,
    generatedOn: input.generatedOn ?? new Date().toISOString(),
    engineCommit: input.engineCommit,
    seeds: {
      master: input.seeds.master,
      gate: input.seeds.gate,
      league: input.seeds.league,
      search: input.seeds.search,
      acceptance: input.seeds.acceptance,
    },
    coverage: {
      identities: total,
      mapped: coverage.mapped,
      coverageStatuses: { ...coverage.coverageStatuses },
      partialIdentities: [...coverage.partialIdentities],
      poolSize: input.coverage.pool.identities.length,
      poolExcluded: input.coverage.pool.excluded,
      poolCoverage: round4(input.coverage.pool.coverage),
    },
    league: {
      path: input.league.path,
      memberCount: input.league.league.members.length,
      byKind: byKindOf(input.league.league),
      members: input.league.league.members.map((member) => ({
        id: member.id,
        kind: member.kind,
        share: member.share,
        size: deckSize(member.deck),
      })),
    },
    search: {
      archivePath: input.search.archivePath,
      generations: input.search.run.generations,
      population: input.search.run.population,
      gamesPerMember: input.search.run.gamesPerMember,
      archiveStats: archiveStats(input.search.archive),
    },
    gates: [
      {
        name: 'is-mcts-referee',
        iterations: input.isMctsGate.iterations,
        games: input.isMctsGate.games,
        winRate: round4(input.isMctsGate.winRate),
        ciLow: round4(input.isMctsGate.ciLow),
        ciHigh: round4(input.isMctsGate.ciHigh),
        verdict: input.isMctsGate.verdict,
        referee: input.isMctsGate.referee,
      },
      {
        name: 'acceptance',
        games: input.acceptance.games,
        winRate: round4(input.acceptance.winRate),
        ciLow: round4(input.acceptance.ci.low),
        ciHigh: round4(input.acceptance.ci.high),
        verdict: input.acceptance.verdict,
        referee: input.acceptance.referee,
      },
    ],
    acceptance: {
      referee: input.acceptance.referee,
      refereeFallback: input.acceptance.refereeFallback,
      isMctsIterations: input.acceptance.isMctsIterations,
      seedBase: input.acceptance.seedBase,
      decks: input.acceptance.decks.map((deck) => ({
        cellKey: deck.cellKey,
        fitness: deck.fitness,
        masterSeed: deck.masterSeed,
        games: deck.games,
        wins: deck.wins,
        winRate: round4(deck.winRate),
        perMember: deck.perMember.map((member) => ({ ...member })),
      })),
      games: input.acceptance.games,
      wins: input.acceptance.wins,
      winRate: round4(input.acceptance.winRate),
      ci: {
        low: round4(input.acceptance.ci.low),
        high: round4(input.acceptance.ci.high),
        mean: round4(input.acceptance.ci.mean),
      },
      verdict: input.acceptance.verdict,
    },
    // the loop ships only when the acceptance gate ships
    verdict: input.acceptance.verdict,
  };
}

/** validate the report's schema shape; returns a list of problems (empty = ok) */
export function validateSelfPlayReport(raw: unknown): string[] {
  const problems: string[] = [];
  const problem = (message: string): void => {
    problems.push(message);
  };
  if (raw === null || typeof raw !== 'object') {
    return ['report is not an object'];
  }
  const report = raw as Record<string, unknown>;
  for (const key of ['format', 'generatedOn', 'engineCommit']) {
    if (typeof report[key] !== 'string') problem(`.${key} must be a string`);
  }
  if (typeof report.generatedOn === 'string') {
    if (Number.isNaN(Date.parse(report.generatedOn)))
      problem('.generatedOn must be an ISO timestamp');
  }
  const seeds = report.seeds;
  if (seeds === null || typeof seeds !== 'object') {
    problem('.seeds must be an object');
  } else {
    for (const key of ['master', 'gate', 'league', 'search', 'acceptance']) {
      if (typeof (seeds as Record<string, unknown>)[key] !== 'number')
        problem(`.seeds.${key} must be a number`);
    }
  }
  const coverage = report.coverage;
  if (coverage === null || typeof coverage !== 'object') {
    problem('.coverage must be an object');
  } else {
    const cov = coverage as Record<string, unknown>;
    for (const key of [
      'identities',
      'mapped',
      'poolSize',
      'poolExcluded',
      'poolCoverage',
    ]) {
      if (typeof cov[key] !== 'number')
        problem(`.coverage.${key} must be a number`);
    }
    if (
      cov.coverageStatuses === null ||
      typeof cov.coverageStatuses !== 'object'
    )
      problem('.coverage.coverageStatuses must be an object');
    if (!Array.isArray(cov.partialIdentities))
      problem('.coverage.partialIdentities must be an array');
  }
  const league = report.league;
  if (league === null || typeof league !== 'object') {
    problem('.league must be an object');
  } else {
    const lg = league as Record<string, unknown>;
    if (typeof lg.path !== 'string') problem('.league.path must be a string');
    if (typeof lg.memberCount !== 'number')
      problem('.league.memberCount must be a number');
    if (lg.byKind === null || typeof lg.byKind !== 'object')
      problem('.league.byKind must be an object');
    if (!Array.isArray(lg.members)) {
      problem('.league.members must be an array');
    } else {
      for (const [index, entry] of lg.members.entries()) {
        const member = entry as Record<string, unknown>;
        for (const key of ['id', 'kind']) {
          if (typeof member[key] !== 'string')
            problem(`.league.members[${index}].${key} must be a string`);
        }
        for (const key of ['share', 'size']) {
          if (typeof member[key] !== 'number')
            problem(`.league.members[${index}].${key} must be a number`);
        }
      }
    }
  }
  const search = report.search;
  if (search === null || typeof search !== 'object') {
    problem('.search must be an object');
  } else {
    const se = search as Record<string, unknown>;
    if (typeof se.archivePath !== 'string')
      problem('.search.archivePath must be a string');
    for (const key of ['generations', 'population', 'gamesPerMember']) {
      if (typeof se[key] !== 'number')
        problem(`.search.${key} must be a number`);
    }
    if (se.archiveStats === null || typeof se.archiveStats !== 'object')
      problem('.search.archiveStats must be an object');
  }
  const gates = report.gates;
  if (!Array.isArray(gates) || gates.length !== 2) {
    problem('.gates must be an array of the two gate entries');
  } else {
    const [isMcts, acceptance] = gates as Record<string, unknown>[];
    if (isMcts?.name !== 'is-mcts-referee')
      problem('.gates[0].name must be "is-mcts-referee"');
    else {
      if (
        isMcts.verdict !== 'PASS' &&
        isMcts.verdict !== 'FAIL' &&
        isMcts.verdict !== 'PENDING'
      )
        problem('.gates[0].verdict must be PASS, FAIL or PENDING');
      for (const key of ['games', 'winRate', 'ciLow', 'ciHigh']) {
        if (typeof isMcts[key] !== 'number')
          problem(`.gates[0].${key} must be a number`);
      }
      if (isMcts.iterations !== null && typeof isMcts.iterations !== 'number')
        problem('.gates[0].iterations must be a number or null');
      if (typeof isMcts.referee !== 'string')
        problem('.gates[0].referee must be a string');
    }
    if (acceptance?.name !== 'acceptance')
      problem('.gates[1].name must be "acceptance"');
    else {
      if (
        acceptance.verdict !== 'SHIPPED' &&
        acceptance.verdict !== 'NOT_SHIPPED'
      )
        problem('.gates[1].verdict must be SHIPPED or NOT_SHIPPED');
      for (const key of ['games', 'winRate', 'ciLow', 'ciHigh']) {
        if (typeof acceptance[key] !== 'number')
          problem(`.gates[1].${key} must be a number`);
      }
      if (typeof acceptance.referee !== 'string')
        problem('.gates[1].referee must be a string');
    }
  }
  const acceptance = report.acceptance;
  if (acceptance === null || typeof acceptance !== 'object') {
    problem('.acceptance must be an object');
  } else {
    const ac = acceptance as Record<string, unknown>;
    if (typeof ac.referee !== 'string')
      problem('.acceptance.referee must be a string');
    if (typeof ac.refereeFallback !== 'boolean')
      problem('.acceptance.refereeFallback must be a boolean');
    if (ac.isMctsIterations !== null && typeof ac.isMctsIterations !== 'number')
      problem('.acceptance.isMctsIterations must be a number or null');
    if (typeof ac.seedBase !== 'number')
      problem('.acceptance.seedBase must be a number');
    if (!Array.isArray(ac.decks)) problem('.acceptance.decks must be an array');
    for (const key of ['games', 'wins', 'winRate']) {
      if (typeof ac[key] !== 'number')
        problem(`.acceptance.${key} must be a number`);
    }
    if (ac.ci === null || typeof ac.ci !== 'object') {
      problem('.acceptance.ci must be an object');
    } else {
      for (const key of ['low', 'high', 'mean']) {
        if (typeof (ac.ci as Record<string, unknown>)[key] !== 'number')
          problem(`.acceptance.ci.${key} must be a number`);
      }
    }
    if (ac.verdict !== 'SHIPPED' && ac.verdict !== 'NOT_SHIPPED')
      problem('.acceptance.verdict must be SHIPPED or NOT_SHIPPED');
  }
  if (report.verdict !== 'SHIPPED' && report.verdict !== 'NOT_SHIPPED')
    problem('.verdict must be SHIPPED or NOT_SHIPPED');
  return problems;
}

/** persist the report (league-style serialization); returns the path */
export async function writeSelfPlayReport(
  filePath: string,
  report: SelfPlayReport,
): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 1)}\n`);
  return filePath;
}

/** load + schema-check a written report (the post-run verification step) */
export async function readSelfPlayReport(
  filePath: string,
): Promise<SelfPlayReport> {
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  const problems = validateSelfPlayReport(raw);
  if (problems.length > 0) {
    throw new Error(
      `${filePath} failed the report schema check:\n  ${problems.join('\n  ')}`,
    );
  }
  return raw as SelfPlayReport;
}
