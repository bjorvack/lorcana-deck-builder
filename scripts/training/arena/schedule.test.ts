/**
 * League scheduler tests (self-play-league task 3.2) — pure scheduling logic
 * against a fake game player; no engine games.
 */
import { describe, expect, it } from 'vitest';
import type { League } from './league';
import { bootstrapLeagueCi } from './league-score';
import {
  type BatchGameRequest,
  type BatchGameResult,
  type BatchPlayer,
  DEFAULT_REFEREE,
  evaluateCandidateVsLeague,
  MEMBER_SEED_SPACING,
  memberSeedBase,
  seedForGame,
} from './schedule';

function makeLeague(shares: number[]): League {
  return {
    format: 'core',
    engineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    seededOn: '2026-01-01T00:00:00.000Z',
    members: shares.map((share, i) => ({
      id: `test:member-${i}`,
      kind: 'baseline-random' as const,
      deck: { [String(1000 + i)]: 60 },
      share,
      origin: `test-${i}`,
    })),
  };
}

/** fake player: canned winners per member deck + request recording */
function fakePlayer(
  winnerFor: (request: BatchGameRequest, game: number) => string | null,
  recorded?: BatchGameRequest[],
): BatchPlayer {
  return (request) => {
    recorded?.push({ ...request });
    const results: BatchGameResult[] = [];
    for (let game = request.from; game < request.from + request.count; game++) {
      results.push({ winner: winnerFor(request, game) });
    }
    return results;
  };
}

describe('seed derivation', () => {
  it('spaces member seed bases off one master seed', () => {
    expect(memberSeedBase(1000, 0)).toBe(1000);
    expect(memberSeedBase(1000, 1)).toBe(1000 + MEMBER_SEED_SPACING);
    expect(memberSeedBase(20261121, 3)).toBe(
      20261121 + 3 * MEMBER_SEED_SPACING,
    );
  });

  it('formats per-game seeds as <seedBase>-<game>', () => {
    expect(seedForGame(77, 0)).toBe('77-0');
    expect(seedForGame(77, 12)).toBe('77-12');
  });
});

describe('evaluateCandidateVsLeague', () => {
  const CANDIDATE = { '1': 60 };
  const TWIN = { '2': 60 };

  it('pairs candidate and twin on identical seed bases per member', () => {
    const league = makeLeague([0.5, 0.5]);
    const recorded: BatchGameRequest[] = [];
    const result = evaluateCandidateVsLeague(CANDIDATE, league, {
      play: fakePlayer(() => 'p1', recorded),
      masterSeed: 1000,
      gamesPerMember: 8,
      batchSize: 8,
      referee: 'test-referee',
      twinDeck: TWIN,
    });
    const candidateRequests = recorded.filter((r) => r.deckA === CANDIDATE);
    const twinRequests = recorded.filter((r) => r.deckA === TWIN);
    expect(candidateRequests).toHaveLength(2);
    expect(twinRequests).toHaveLength(2);
    for (const [index, member] of league.members.entries()) {
      const candidateReq = candidateRequests.find(
        (r) => r.seedBase === memberSeedBase(1000, index),
      )!;
      const twinReq = twinRequests.find(
        (r) => r.seedBase === memberSeedBase(1000, index),
      )!;
      // paired seeds: same base, same per-game seeds, same opponent deck
      expect(candidateReq.seedBase).toBe(memberSeedBase(1000, index));
      expect(twinReq.seedBase).toBe(candidateReq.seedBase);
      expect(candidateReq.from).toBe(twinReq.from);
      expect(candidateReq.count).toBe(twinReq.count);
      expect(candidateReq.deckB).toBe(member.deck);
      expect(twinReq.deckB).toBe(member.deck);
      expect(candidateReq.referee).toBe('test-referee');
      expect(twinReq.referee).toBe('test-referee');
      expect(
        Array.from({ length: twinReq.count }, (_, g) =>
          seedForGame(twinReq.seedBase, twinReq.from + g),
        ),
      ).toEqual(
        Array.from({ length: candidateReq.count }, (_, g) =>
          seedForGame(candidateReq.seedBase, candidateReq.from + g),
        ),
      );
      // common random numbers: seed bases differ across members only
      if (index > 0) {
        expect(candidateReq.seedBase).not.toBe(memberSeedBase(1000, index - 1));
      }
    }
    expect(result.twin).toBeDefined();
    expect(result.twin?.results.map((r) => r.games)).toEqual(
      result.results.map((r) => r.games),
    );
  });

  it('stops lopsided members early via SPRT', () => {
    const league = makeLeague([0.5, 0.5]);
    const [deck0] = league.members.map((m) => m.deck);
    const recorded: BatchGameRequest[] = [];
    const result = evaluateCandidateVsLeague(CANDIDATE, league, {
      play: fakePlayer(
        (request) => (request.deckB === deck0 ? 'p1' : 'p2'),
        recorded,
      ),
      masterSeed: 42,
      gamesPerMember: 40,
      batchSize: 8,
    });
    // 24 straight wins: 24·ln(1.2) ≈ 4.376 ≥ ln(19) — decided after 3 batches
    const sweep = result.results[0]!;
    expect(sweep.games).toBe(24);
    expect(sweep.wins).toBe(24);
    expect(sweep.losses).toBe(0);
    expect(sweep.stopped).toBe(true);
    expect(sweep.decision).toBe('accept');
    // 16 straight losses: 16·ln(0.8) ≈ -3.570 ≤ -ln(19) — decided after 2
    const washed = result.results[1]!;
    expect(washed.games).toBe(16);
    expect(washed.losses).toBe(16);
    expect(washed.stopped).toBe(true);
    expect(washed.decision).toBe('reject');
    // sequential stopping: 40 of the 80-game budget simulated
    const simulated = recorded.reduce((sum, r) => sum + r.count, 0);
    expect(simulated).toBe(40);
  });

  it('wires score and CI to the shared pure modules', () => {
    const league = makeLeague([0.25, 0.75]);
    const scripted = new Map<Record<string, number>, Array<string | null>>([
      [league.members[0]!.deck, ['p1', 'p2', 'p1', 'p1']],
      [league.members[1]!.deck, ['p2', 'p2', 'p1', 'p2']],
    ]);
    const cursors = new Map<Record<string, number>, number>();
    const result = evaluateCandidateVsLeague(CANDIDATE, league, {
      play: fakePlayer((request) => {
        const script = scripted.get(request.deckB)!;
        const cursor = cursors.get(request.deckB) ?? 0;
        cursors.set(request.deckB, cursor + 1);
        return script[cursor % script.length]!;
      }),
      masterSeed: 7,
      gamesPerMember: 4,
      batchSize: 4,
    });
    const [m0, m1] = result.results;
    expect(m0).toMatchObject({ games: 4, wins: 3, losses: 1, stopped: false });
    expect(m1).toMatchObject({ games: 4, wins: 1, losses: 3, stopped: false });
    expect(result.results.every((r) => r.decision === null)).toBe(true);
    // W = Σ W_ij·P(j) = 0.75·0.25 + 0.25·0.75 = 0.375 (shares fully covered)
    expect(result.score.score).toBeCloseTo(0.375, 12);
    expect(result.score.coveredShare).toBe(1);
    // CI wiring: identical to a direct bootstrapLeagueCi on the same outcomes
    const direct = bootstrapLeagueCi(
      {
        [league.members[0]!.id]: [1, 0, 1, 1],
        [league.members[1]!.id]: [0, 0, 1, 0],
      },
      league,
    );
    expect(result.ci.low).toBe(direct.low);
    expect(result.ci.high).toBe(direct.high);
    expect(result.ci.mean).toBe(direct.mean);
    expect(result.ci.mean).toBeCloseTo(0.375, 12);
  });

  it('renormalizes shares over played members only', () => {
    const league = makeLeague([0.2, 0.3, 0.5]);
    const [deck0] = league.members.map((m) => m.deck);
    const recorded: BatchGameRequest[] = [];
    const result = evaluateCandidateVsLeague(CANDIDATE, league, {
      // member 3 goes unplayed: the fake plays no games for it
      play: (request) => {
        recorded.push({ ...request });
        if (request.deckB === league.members[2]!.deck) return [];
        return Array.from({ length: request.count }, () => ({
          winner: request.deckB === deck0 ? 'p1' : 'p2',
        }));
      },
      masterSeed: 9,
      gamesPerMember: 4,
      batchSize: 4,
    });
    // covered share 0.5 → effective shares double: 0.4 and 0.6
    expect(result.score.coveredShare).toBeCloseTo(0.5, 12);
    expect(result.score.score).toBeCloseTo(1 * 0.4 + 0 * 0.6, 12);
    expect(result.score.perMember.map((m) => m.effectiveShare)).toEqual([
      0.4, 0.6,
    ]);
    // the unplayed member is reported with zero games and no stop
    expect(result.results[2]).toMatchObject({
      memberId: 'test:member-2',
      games: 0,
      stopped: false,
      decision: null,
      seedBase: memberSeedBase(9, 2),
    });
    const direct = bootstrapLeagueCi(
      {
        [league.members[0]!.id]: [1, 1, 1, 1],
        [league.members[1]!.id]: [0, 0, 0, 0],
      },
      league,
    );
    expect(result.ci.low).toBe(direct.low);
    expect(result.ci.high).toBe(direct.high);
  });

  it('defaults the referee to the shipped heuristic bot', () => {
    const league = makeLeague([1]);
    const recorded: BatchGameRequest[] = [];
    evaluateCandidateVsLeague(CANDIDATE, league, {
      play: fakePlayer(() => null, recorded),
      masterSeed: 1,
      gamesPerMember: 2,
      batchSize: 2,
    });
    expect(recorded[0]!.referee).toBe(DEFAULT_REFEREE);
  });
});
