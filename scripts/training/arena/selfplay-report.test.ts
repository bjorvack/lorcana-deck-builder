/**
 * Self-play run report tests (self-play-league, task 5.1) — schema shape,
 * deterministic field ordering and the round-trip schema check against
 * synthetic inputs; no engine, no games.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardMap } from './card-map';
import type { League } from './league';
import { emptyArchive, place } from './map-elites-archive';
import {
  buildSelfPlayReport,
  readSelfPlayReport,
  type SelfPlayReport,
  validateSelfPlayReport,
  writeSelfPlayReport,
} from './selfplay-report';

const coverage: CardMap['coverage'] = {
  identities: 2785,
  mapped: 2681,
  mappedVia: { key: 2679, name: 2 },
  ineligible: { quest: 104, epic: 0, promo: 0, unknown: 0, 'name-mismatch': 0 },
  missingImplementation: 6,
  coverageStatuses: { fully: 2675, partial: 6, unmapped: 104 },
  partialIdentities: ['1702', '2331'],
  statDriftGroups: [],
  perSet: {},
};

const pool = {
  identities: ['1', '2', '3'],
  excluded: 1,
  coverage: 0.75,
};

const cardMap: CardMap = {
  format: 2,
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  byIdentity: {},
  coverage,
};

const league: League = {
  format: 'core',
  engineCommit: '6de59de1c203827edc1bc6faa1bc6184cd126a5f',
  seededOn: '2026-11-22T09:24:18.575Z',
  members: [
    {
      id: 'real:13f4065f',
      kind: 'real',
      deck: { 1972: 4, 2208: 56 },
      share: 0.25,
      origin: 'corpus:test:1:2026-11-01',
    },
    {
      id: 'baseline-random:cce40a41',
      kind: 'baseline-random',
      deck: { 2039: 30, 2040: 30 },
      share: 0.25,
      origin: 'random-legal:seed-20261122-0',
    },
    {
      id: 'selfplay:ab12cd34',
      kind: 'selfplay',
      deck: { 2100: 60 },
      share: 0.5,
      origin: 'map-elites:gen-0:cost-1_ink-2',
      score: 0.62,
    },
  ],
};

const archive = (() => {
  let current = emptyArchive('core', league.engineCommit, 20261122);
  for (const [cellKey, fitness] of [
    ['cost-1_ink-2_mix-character-0_lore-1', 0.62],
    ['cost-0_ink-0_mix-action-1_lore-0', 0.44],
  ] as const) {
    current = place(current, cellKey, {
      descriptor: {
        avgCost: 3.1,
        inkableRatio: 0.4,
        typeMix: { character: 0.7, action: 0.3, item: 0 },
        lorePerTurnProxy: 1.2,
      },
      deck: { 1: 60 },
      fitness,
      games: 64,
      updatedOn: 0,
    }).archive;
  }
  return current;
})();

const baseInput = {
  format: 'core',
  engineCommit: league.engineCommit,
  generatedOn: '2026-11-22T12:00:00.000Z',
  seeds: {
    master: 20261122,
    gate: 1,
    league: 20261122,
    search: 20261122,
    acceptance: 70261122,
  },
  coverage: { cardMap, pool },
  league: { path: '/tmp/league-6de59de1.json', league },
  search: {
    archivePath: '/tmp/archive-6de59de1-20261122.json',
    run: { generations: 3, population: 8, gamesPerMember: 8 },
    archive,
  },
  isMctsGate: {
    name: 'is-mcts-referee' as const,
    iterations: null,
    games: 0,
    winRate: 0,
    ciLow: 0,
    ciHigh: 0,
    verdict: 'PENDING' as const,
    referee: 'best-deck-aware-lore-race',
  },
  acceptance: {
    referee: 'best-deck-aware-lore-race',
    refereeFallback: true,
    isMctsIterations: null,
    seedBase: 70261122,
    decks: [
      {
        cellKey: 'cost-1_ink-2_mix-character-0_lore-1',
        fitness: 0.62,
        masterSeed: 70261122,
        games: 96,
        wins: 58,
        winRate: 58 / 96,
        perMember: [
          {
            memberId: 'real:13f4065f',
            seedBase: 70261122,
            games: 24,
            wins: 15,
            stopped: false,
            decision: null,
          },
        ],
      },
    ],
    games: 96,
    wins: 58,
    winRate: 58 / 96,
    ci: { low: 0.504, high: 0.7, mean: 58 / 96 },
    verdict: 'SHIPPED' as const,
  },
};

describe('buildSelfPlayReport', () => {
  it('assembles the full schema with a fixed field order', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(Object.keys(report)).toEqual([
      'format',
      'generatedOn',
      'engineCommit',
      'seeds',
      'coverage',
      'league',
      'search',
      'gates',
      'acceptance',
      'verdict',
    ]);
    expect(Object.keys(report.seeds)).toEqual([
      'master',
      'gate',
      'league',
      'search',
      'acceptance',
    ]);
    expect(report.format).toBe('core');
    expect(report.engineCommit).toBe(league.engineCommit);
    expect(report.seeds).toEqual(baseInput.seeds);
  });

  it('passes coverage statuses, partial identities and pool numbers through', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(report.coverage).toEqual({
      identities: 2785,
      mapped: 2681,
      coverageStatuses: { fully: 2675, partial: 6, unmapped: 104 },
      partialIdentities: ['1702', '2331'],
      poolSize: 3,
      poolExcluded: 1,
      poolCoverage: 0.75,
    });
  });

  it('summarizes league composition with member sizes', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(report.league.memberCount).toBe(3);
    expect(report.league.byKind).toEqual({
      real: 1,
      'baseline-random': 1,
      selfplay: 1,
    });
    expect(report.league.members[0]).toEqual({
      id: 'real:13f4065f',
      kind: 'real',
      share: 0.25,
      size: 60,
    });
  });

  it('computes archive statistics for the search section', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(report.search.generations).toBe(3);
    expect(report.search.population).toBe(8);
    expect(report.search.gamesPerMember).toBe(8);
    expect(report.search.archiveStats.cells).toBe(2);
    expect(report.search.archiveStats.fitness?.max).toBe(0.62);
    expect(report.search.archiveStats.fitness?.min).toBe(0.44);
  });

  it('orders the gates and rounds their numbers', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(report.gates.map((gate) => gate.name)).toEqual([
      'is-mcts-referee',
      'acceptance',
    ]);
    expect(report.gates[1]).toEqual({
      name: 'acceptance',
      games: 96,
      winRate: Math.round((58 / 96) * 10_000) / 10_000,
      ciLow: 0.504,
      ciHigh: 0.7,
      verdict: 'SHIPPED',
      referee: 'best-deck-aware-lore-race',
    });
  });

  it('mirrors the acceptance verdict at the top level and keeps an ISO timestamp', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(report.verdict).toBe('SHIPPED');
    expect(report.acceptance.decks[0]!.winRate).toBe(
      Math.round((58 / 96) * 10_000) / 10_000,
    );
    expect(report.generatedOn).toBe('2026-11-22T12:00:00.000Z');
    const stamped = buildSelfPlayReport({
      ...baseInput,
      generatedOn: undefined,
    });
    expect(Number.isNaN(Date.parse(stamped.generatedOn))).toBe(false);
  });

  it('records a NOT_SHIPPED acceptance honestly', () => {
    const report = buildSelfPlayReport({
      ...baseInput,
      acceptance: {
        ...baseInput.acceptance,
        verdict: 'NOT_SHIPPED',
        ci: { low: 0.42, high: 0.55, mean: 0.48 },
      },
    });
    expect(report.verdict).toBe('NOT_SHIPPED');
    expect(report.gates[1]!.verdict).toBe('NOT_SHIPPED');
  });
});

describe('validateSelfPlayReport', () => {
  it('accepts a built report', () => {
    expect(validateSelfPlayReport(buildSelfPlayReport(baseInput))).toEqual([]);
  });

  it('flags missing and mistyped fields', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(validateSelfPlayReport({ ...report, engineCommit: 7 })).toContain(
      '.engineCommit must be a string',
    );
    expect(
      validateSelfPlayReport({ ...report, verdict: 'SHIPPED?' }),
    ).toContain('.verdict must be SHIPPED or NOT_SHIPPED');
    expect(
      validateSelfPlayReport({
        ...report,
        seeds: { ...report.seeds, gate: '1' },
      }),
    ).toContain('.seeds.gate must be a number');
    expect(
      validateSelfPlayReport({
        ...report,
        acceptance: {
          ...report.acceptance,
          refereeFallback: 'yes',
        },
      }),
    ).toContain('.acceptance.refereeFallback must be a boolean');
  });

  it('flags a wrong gates array', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(
      validateSelfPlayReport({ ...report, gates: report.gates.slice(0, 1) }),
    ).toContain('.gates must be an array of the two gate entries');
    const swapped = {
      ...report,
      gates: [report.gates[1], report.gates[0]],
    };
    expect(validateSelfPlayReport(swapped)).toContain(
      '.gates[0].name must be "is-mcts-referee"',
    );
  });

  it('flags a non-ISO generatedOn', () => {
    const report = buildSelfPlayReport(baseInput);
    expect(
      validateSelfPlayReport({ ...report, generatedOn: 'yesterday' }),
    ).toContain('.generatedOn must be an ISO timestamp');
  });
});

describe('writeSelfPlayReport / readSelfPlayReport', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  const tmpDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'selfplay-report-'));
    dirs.push(dir);
    return dir;
  };

  it('round-trips through disk and re-validates', async () => {
    const reportPath = path.join(tmpDir(), 'selfplay.report.json');
    const report = buildSelfPlayReport(baseInput);
    await writeSelfPlayReport(reportPath, report);
    const text = readFileSync(reportPath, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as SelfPlayReport;
    expect(validateSelfPlayReport(parsed)).toEqual([]);
    await expect(readSelfPlayReport(reportPath)).resolves.toEqual(report);
  });

  it('rejects a corrupted report on read-back', async () => {
    const reportPath = path.join(tmpDir(), 'broken.report.json');
    const broken = { ...buildSelfPlayReport(baseInput) };
    delete (broken as { verdict?: unknown }).verdict;
    await writeSelfPlayReport(reportPath, broken as unknown as SelfPlayReport);
    await expect(readSelfPlayReport(reportPath)).rejects.toThrow(
      /failed the report schema check/,
    );
  });
});
