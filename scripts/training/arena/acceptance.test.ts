/**
 * Acceptance gate tests (self-play-league, task 5.2) — the CI-low verdict
 * rule, fresh-seed-base disjointness, referee fallback logic and the pure
 * acceptance core against a fake game player; no engine, no real games.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_DECK_STRIDE,
  ACCEPTANCE_SEED_OFFSET,
  acceptanceBaseSeed,
  acceptanceDeckSeed,
  acceptanceVerdict,
  type IsMctsGateRecord,
  readIsMctsVerdicts,
  realSubLeague,
  reportGateRecord,
  resolveReferee,
  runAcceptance,
  topElites,
} from './acceptance';
import { deckSignature, type League } from './league';
import { mutantSeedFor, scatterSeedFor } from './map-elites';
import { emptyArchive, place } from './map-elites-archive';
import {
  type BatchGameRequest,
  type BatchPlayer,
  MEMBER_SEED_SPACING,
  memberSeedBase,
} from './schedule';

const MASTER = 20261122;
const COMMIT = '6de59de1c203827edc1bc6faa1bc6184cd126a5f';

const makeLeague = (): League => ({
  format: 'core',
  engineCommit: COMMIT,
  seededOn: '2026-11-22T09:24:18.575Z',
  members: [
    {
      id: `real:${deckSignature({ 100: 60 })}`,
      kind: 'real',
      deck: { 100: 60 },
      share: 0.125,
      origin: 'corpus:test:1:2026-11-01',
    },
    {
      id: `real:${deckSignature({ 101: 60 })}`,
      kind: 'real',
      deck: { 101: 60 },
      share: 0.125,
      origin: 'corpus:test:2:2026-11-07',
    },
    {
      id: `baseline-random:${deckSignature({ 102: 60 })}`,
      kind: 'baseline-random',
      deck: { 102: 60 },
      share: 0.75,
      origin: 'random-legal:seed-20261122-0',
    },
  ],
});

const archiveWith = (
  cells: Array<{
    cellKey: string;
    fitness: number;
    deck?: Record<string, number>;
  }>,
) => {
  let archive = emptyArchive('core', COMMIT, MASTER);
  for (const cell of cells) {
    archive = place(archive, cell.cellKey, {
      descriptor: {
        avgCost: 3,
        inkableRatio: 0.4,
        typeMix: { character: 0.8, action: 0.2, item: 0 },
        lorePerTurnProxy: 1,
      },
      deck: cell.deck ?? { 200: 60 },
      fitness: cell.fitness,
      games: 64,
      updatedOn: 0,
    }).archive;
  }
  return archive;
};

const fakePlayer =
  (
    winnerFor: (request: BatchGameRequest, game: number) => string | null,
  ): BatchPlayer =>
  (request) =>
    Array.from({ length: request.count }, (_, game) => ({
      winner: winnerFor(request, game),
    }));

const gateRecord = (
  overrides: Partial<IsMctsGateRecord> & { iterations: number },
): IsMctsGateRecord => ({
  seedBase: 1,
  games: 1000,
  winRate: 0.55,
  ciLow: 0.51,
  ciHigh: 0.59,
  verdict: 'PASS',
  referee: 'is-mcts',
  path: `verdict-i${overrides.iterations}.json`,
  ...overrides,
});

// ---- referee selection (D2a) ----

describe('resolveReferee', () => {
  it('falls back to the heuristic bot when no verdict files exist', () => {
    const decision = resolveReferee([]);
    expect(decision.referee).toBe('best-deck-aware-lore-race');
    expect(decision.refereeFallback).toBe(true);
    expect(decision.isMctsVerdict).toBeNull();
  });

  it('falls back when the gate only produced FAIL verdicts', () => {
    const decision = resolveReferee([
      gateRecord({ iterations: 75, verdict: 'FAIL', ciLow: 0.44 }),
      gateRecord({ iterations: 150, verdict: 'FAIL', ciLow: 0.46 }),
    ]);
    expect(decision.referee).toBe('best-deck-aware-lore-race');
    expect(decision.refereeFallback).toBe(true);
    expect(decision.isMctsVerdict).toBeNull();
  });

  it('uses IS-MCTS at the PASS iteration budget', () => {
    const decision = resolveReferee([
      gateRecord({ iterations: 150, winRate: 0.62, ciLow: 0.57 }),
    ]);
    expect(decision.referee).toBe('is-mcts(i150)');
    expect(decision.refereeFallback).toBe(false);
    expect(decision.isMctsVerdict?.iterations).toBe(150);
    expect(decision.isMctsVerdict?.ciLow).toBe(0.57);
  });

  it('prefers the cheapest PASS budget and ignores FAIL budgets', () => {
    const decision = resolveReferee([
      gateRecord({ iterations: 150, verdict: 'FAIL' }),
      gateRecord({ iterations: 150 }),
      gateRecord({ iterations: 75 }),
    ]);
    expect(decision.referee).toBe('is-mcts(i75)');
    expect(decision.refereeFallback).toBe(false);
    expect(decision.isMctsVerdict?.iterations).toBe(75);
  });
});

describe('reportGateRecord', () => {
  it('returns null without verdict files (report PENDING)', () => {
    expect(reportGateRecord([])).toBeNull();
  });

  it('shows the latest FAIL while no PASS exists', () => {
    const record = reportGateRecord([
      gateRecord({ iterations: 75, verdict: 'FAIL' }),
      gateRecord({ iterations: 150, verdict: 'FAIL', winRate: 0.56 }),
    ]);
    expect(record?.iterations).toBe(150);
    expect(record?.verdict).toBe('FAIL');
  });

  it('shows the PASS that decided the referee', () => {
    const record = reportGateRecord([
      gateRecord({ iterations: 150, verdict: 'FAIL' }),
      gateRecord({ iterations: 75 }),
    ]);
    expect(record?.iterations).toBe(75);
    expect(record?.verdict).toBe('PASS');
  });
});

describe('readIsMctsVerdicts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });
  const tmpDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'is-mcts-verdicts-'));
    dirs.push(dir);
    return dir;
  };

  it('returns an empty list for a missing directory', () => {
    expect(readIsMctsVerdicts(path.join(tmpdir(), 'does-not-exist'))).toEqual(
      [],
    );
  });

  it('parses verdict-i<iterations>.json files and skips other files', () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, 'verdict-i75.json'),
      `${JSON.stringify({
        games: 1000,
        seedBase: 1,
        iterations: 75,
        wins: 470,
        winRate: 0.47,
        ci: { method: 'bootstrap-10000', low: 0.44, high: 0.5 },
        verdict: 'FAIL',
        referee: 'best-deck-aware-lore-race',
      })}\n`,
    );
    writeFileSync(path.join(dir, 'games-i75.jsonl'), 'not a verdict\n');
    const records = readIsMctsVerdicts(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      iterations: 75,
      games: 1000,
      winRate: 0.47,
      ciLow: 0.44,
      ciHigh: 0.5,
      verdict: 'FAIL',
      referee: 'best-deck-aware-lore-race',
    });
  });
});

// ---- verdict rule ----

describe('acceptanceVerdict', () => {
  it('is NOT_SHIPPED for a 0.48 point with a wide CI', () => {
    expect(acceptanceVerdict({ low: 0.4, high: 0.56 })).toBe('NOT_SHIPPED');
  });

  it('is NOT_SHIPPED while the CI only straddles 0.5', () => {
    expect(acceptanceVerdict({ low: 0.49, high: 0.55 })).toBe('NOT_SHIPPED');
  });

  it('is SHIPPED only when the CI lower bound beats 0.5', () => {
    expect(acceptanceVerdict({ low: 0.501, high: 0.6 })).toBe('SHIPPED');
    expect(acceptanceVerdict({ low: 0.83, high: 0.95 })).toBe('SHIPPED');
    expect(acceptanceVerdict({ low: 0.5 })).toBe('NOT_SHIPPED');
  });
});

// ---- fresh seed bases ----

describe('acceptance seed bases', () => {
  it('start 50,000,000 above the master seed in 10,000-wide deck windows', () => {
    expect(acceptanceBaseSeed(MASTER)).toBe(MASTER + ACCEPTANCE_SEED_OFFSET);
    for (let deck = 0; deck < 8; deck++) {
      expect(acceptanceDeckSeed(MASTER, deck)).toBe(
        MASTER + ACCEPTANCE_SEED_OFFSET + deck * ACCEPTANCE_DECK_STRIDE,
      );
    }
  });

  it('are disjoint from every search and gate seed range', () => {
    // the widest search ranges for this run (3 generations, population 8,
    // ≤ 8 league members) plus the IS-MCTS gate's seed base 1
    const searchMax = Math.max(
      memberSeedBase(MASTER, 7),
      mutantSeedFor(MASTER, 2, 7),
      scatterSeedFor(MASTER, 2),
    );
    const acceptanceMin = acceptanceBaseSeed(MASTER);
    expect(acceptanceMin).toBeGreaterThan(searchMax);
    expect(acceptanceMin).toBeGreaterThan(1); // the gate's seed base
  });

  it('keep per-member windows inside each deck stride with no overlap', () => {
    const decks = 4;
    const members = 4; // real members only
    const gamesPerMember = 24;
    for (let deck = 0; deck < decks; deck++) {
      for (let member = 0; member < members; member++) {
        const base = memberSeedBase(acceptanceDeckSeed(MASTER, deck), member);
        // the whole member window stays inside the deck's stride window
        expect(base + gamesPerMember - 1).toBeLessThan(
          acceptanceDeckSeed(MASTER, deck) + ACCEPTANCE_DECK_STRIDE,
        );
        // and never reaches the next deck's window
        if (deck + 1 < decks) {
          expect(base + gamesPerMember - 1).toBeLessThan(
            acceptanceDeckSeed(MASTER, deck + 1),
          );
        }
      }
    }
  });
});

// ---- acceptance core ----

describe('runAcceptance', () => {
  const league = makeLeague();
  const archive = archiveWith([{ cellKey: 'cell-a', fitness: 0.62 }]);

  it('plays the real members only, on the fresh seed bases', () => {
    const result = runAcceptance({
      archive,
      league,
      play: fakePlayer(() => 'p1'),
      masterSeed: MASTER,
      referee: 'best-deck-aware-lore-race',
      gamesPerMember: 4,
      batchSize: 4,
    });
    const memberIds = new Set(league.members.map((m) => m.id));
    expect(realSubLeague(league).members.map((m) => m.id)).toHaveLength(2);
    const played = new Set(result.decks[0]!.perMember.map((m) => m.memberId));
    for (const id of played) expect(memberIds.has(id)).toBe(true);
    expect(played.has(league.members[2]!.id)).toBe(false);
    // fresh paired seeds: per-deck base + memberSeedBase offsets
    expect(result.decks[0]!.masterSeed).toBe(acceptanceDeckSeed(MASTER, 0));
    expect(result.decks[0]!.perMember.map((m) => m.seedBase)).toEqual([
      memberSeedBase(acceptanceDeckSeed(MASTER, 0), 0),
      memberSeedBase(acceptanceDeckSeed(MASTER, 0), 1),
    ]);
    expect(result.decks[0]!.winRate).toBe(1);
    expect(result.winRate).toBe(1);
    expect(result.ci.low).toBeGreaterThan(0.5);
    expect(result.verdict).toBe('SHIPPED');
  });

  it('records an honest NOT_SHIPPED when the decks lose', () => {
    const result = runAcceptance({
      archive,
      league,
      play: fakePlayer(() => 'p2'),
      masterSeed: MASTER,
      referee: 'best-deck-aware-lore-race',
      gamesPerMember: 4,
      batchSize: 4,
    });
    expect(result.winRate).toBe(0);
    expect(result.ci.low).toBe(0);
    expect(result.verdict).toBe('NOT_SHIPPED');
  });

  it('pools per-game outcomes across decks and members for the CI', () => {
    // deck 0 wins everything, deck 1 loses everything → pooled 0.5
    const decks = [
      archiveWith([{ cellKey: 'cell-a', fitness: 0.62, deck: { 200: 60 } }]),
      archiveWith([{ cellKey: 'cell-b', fitness: 0.58, deck: { 201: 60 } }]),
    ];
    const result = runAcceptance({
      archive: decks[0]!,
      league,
      play: fakePlayer(() => 'p1'),
      masterSeed: MASTER,
      referee: 'best-deck-aware-lore-race',
      gamesPerMember: 2,
      batchSize: 2,
    });
    expect(result.winRate).toBe(1);
    // the second deck's fresh deck window must differ from the first's
    expect(result.decks[0]!.masterSeed).not.toBe(acceptanceDeckSeed(MASTER, 1));
    const both = runAcceptance({
      archive: {
        ...decks[0]!,
        cells: {
          ...decks[0]!.cells,
          ...decks[1]!.cells,
        },
      },
      league,
      play: fakePlayer((request) =>
        request.deckA === decks[1]!.cells['cell-b']!.deck ? 'p2' : 'p1',
      ),
      masterSeed: MASTER,
      referee: 'best-deck-aware-lore-race',
      gamesPerMember: 2,
      batchSize: 2,
      bootstrapReps: 200,
    });
    expect(both.decks).toHaveLength(2);
    expect(both.games).toBe(8); // 2 decks × 2 real members × 2 games
    expect(both.wins).toBe(4);
    expect(both.winRate).toBeCloseTo(0.5, 12);
    // a 0.5 point can never ship: the CI lower bound sits at or below 0.5
    expect(both.verdict).toBe('NOT_SHIPPED');
    expect(both.ci.low).toBeLessThanOrEqual(0.5);
  });

  it('selects the top-N elites in fitness order with cell-key tie-breaks', () => {
    const archive = archiveWith([
      { cellKey: 'cell-c', fitness: 0.7 },
      { cellKey: 'cell-a', fitness: 0.7 },
      { cellKey: 'cell-e', fitness: 0.4 },
      { cellKey: 'cell-b', fitness: 0.9 },
    ]);
    expect(topElites(archive, 4).map((cell) => cell.cellKey)).toEqual([
      'cell-b',
      'cell-a',
      'cell-c',
      'cell-e',
    ]);
    expect(topElites(archive, 2).map((cell) => cell.cellKey)).toEqual([
      'cell-b',
      'cell-a',
    ]);
    const recorded: string[] = [];
    runAcceptance({
      archive,
      league,
      play: fakePlayer((request) => {
        recorded.push(
          request.deckA === archive.cells['cell-b']!.deck ? 'b' : 'x',
        );
        return 'p1';
      }),
      masterSeed: MASTER,
      referee: 'best-deck-aware-lore-race',
      topN: 2,
      gamesPerMember: 1,
      batchSize: 1,
    });
    // only the two fittest cells were evaluated: 2 decks × 2 real members
    expect(recorded).toHaveLength(4);
  });

  it('lets SPRT stop lopsided pairings early', () => {
    const result = runAcceptance({
      archive,
      league,
      play: fakePlayer(() => 'p1'),
      masterSeed: MASTER,
      referee: 'best-deck-aware-lore-race',
      gamesPerMember: 40,
      batchSize: 8,
    });
    // 24 straight wins cross the Wald upper bound (24·ln(1.2) ≥ ln(19))
    for (const member of result.decks[0]!.perMember) {
      expect(member.games).toBe(24);
      expect(member.stopped).toBe(true);
      expect(member.decision).toBe('accept');
    }
  });

  it('fails loudly without real members or an empty archive', () => {
    const noReal: League = {
      ...league,
      members: league.members.filter((m) => m.kind !== 'real'),
    };
    expect(() =>
      runAcceptance({
        archive,
        league: noReal,
        play: fakePlayer(() => 'p1'),
        masterSeed: MASTER,
        referee: 'best-deck-aware-lore-race',
      }),
    ).toThrow(/no real members/);
    expect(() =>
      runAcceptance({
        archive: emptyArchive('core', COMMIT, MASTER),
        league,
        play: fakePlayer(() => 'p1'),
        masterSeed: MASTER,
        referee: 'best-deck-aware-lore-race',
      }),
    ).toThrow(/archive has no cells/);
  });

  it('refuses seed windows that would collide', () => {
    const crowded: League = {
      ...league,
      members: [
        ...league.members.filter((m) => m.kind === 'real'),
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `real:crowd-${i}`,
          kind: 'real' as const,
          deck: { [300 + i]: 60 },
          share: 0.01,
          origin: 'test',
        })),
      ],
    };
    expect(() =>
      runAcceptance({
        archive,
        league: crowded,
        play: fakePlayer(() => 'p1'),
        masterSeed: MASTER,
        referee: 'best-deck-aware-lore-race',
        gamesPerMember: MEMBER_SEED_SPACING + 1,
      }),
    ).toThrow(/seed windows collide/);
  });
});
