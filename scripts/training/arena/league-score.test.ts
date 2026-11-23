/** League scoring math + bootstrap CI tests (pure, hand-computed values). */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../prng';
import type { League } from './league';
import {
  bootstrapCi,
  bootstrapLeagueCi,
  type CandidateResults,
  leagueScore,
} from './league-score';

const member = (id: string, share: number): League['members'][number] => ({
  id,
  kind: 'real',
  deck: {},
  share,
  origin: 'test',
});

const league2: League = {
  format: 'core',
  engineCommit: 'test',
  seededOn: '2026-01-01T00:00:00.000Z',
  members: [member('real:aaaa', 0.6), member('baseline-random:bbbb', 0.4)],
};

const league4: League = {
  format: 'core',
  engineCommit: 'test',
  seededOn: '2026-01-01T00:00:00.000Z',
  members: [
    member('a', 0.25),
    member('b', 0.25),
    member('c', 0.25),
    member('d', 0.25),
  ],
};

describe('leagueScore', () => {
  it('computes the share-weighted win rate (hand-computed)', () => {
    // W = 0.75·0.6 + 0.5·0.4 = 0.45 + 0.2 = 0.65
    const results: CandidateResults = {
      'real:aaaa': [1, 1, 1, 0],
      'baseline-random:bbbb': [1, 0],
    };
    const { score, perMember, coveredShare } = leagueScore(results, league2);
    expect(score).toBeCloseTo(0.65);
    expect(coveredShare).toBe(1);
    expect(perMember).toHaveLength(2);
    const a = perMember.find((m) => m.memberId === 'real:aaaa')!;
    expect(a.winRate).toBeCloseTo(0.75);
    expect(a.effectiveShare).toBeCloseTo(0.6);
    expect(a.contribution).toBeCloseTo(0.45);
    const b = perMember.find((m) => m.memberId === 'baseline-random:bbbb')!;
    expect(b.contribution).toBeCloseTo(0.2);
  });

  it('weights a 4-member league as Σ W_ij·P(j)', () => {
    const results: CandidateResults = {
      a: [1, 1, 1, 1], // 1.00
      b: [1, 0, 1, 0], // 0.50
      c: [1, 0, 0, 0], // 0.25
      d: [0, 0, 0, 0], // 0.00
    };
    // 0.25·(1 + 0.5 + 0.25 + 0) = 0.4375
    const { score } = leagueScore(results, league4);
    expect(score).toBeCloseTo(0.4375);
    const contributions = leagueScore(results, league4).perMember.reduce(
      (sum, m) => sum + m.contribution,
      0,
    );
    expect(contributions).toBeCloseTo(score);
  });

  it('renormalizes shares over the members actually played', () => {
    // only real:aaaa played (share 0.6): score collapses to its plain win rate
    const { score, coveredShare } = leagueScore(
      { 'real:aaaa': [1, 1, 1, 0] },
      league2,
    );
    expect(coveredShare).toBeCloseTo(0.6);
    expect(score).toBeCloseTo(0.75);
  });

  it('ignores unknown member ids and empty outcome lists', () => {
    const withoutGhost = leagueScore({ 'real:aaaa': [1, 0] }, league2);
    const withGhost = leagueScore(
      { 'real:aaaa': [1, 0], ghost: [1, 1, 1] },
      league2,
    );
    const empty = leagueScore({ 'real:aaaa': [] }, league2);
    expect(withGhost.score).toBeCloseTo(withoutGhost.score);
    expect(withGhost.perMember).toHaveLength(1);
    expect(empty.score).toBe(0);
    expect(empty.perMember).toHaveLength(0);
  });

  it('returns zero for an empty schedule', () => {
    const { score, perMember, coveredShare } = leagueScore({}, league2);
    expect(score).toBe(0);
    expect(perMember).toEqual([]);
    expect(coveredShare).toBe(0);
  });
});

describe('bootstrapCi', () => {
  it('is deterministic for a seeded rng', () => {
    const samples = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0];
    const a = bootstrapCi(samples, { reps: 400, rng: mulberry32(7) });
    const b = bootstrapCi(samples, { reps: 400, rng: mulberry32(7) });
    expect(a).toEqual(b);
  });

  it('contains the point estimate', () => {
    const samples = Array.from({ length: 50 }, (_, i) => (i % 5 < 3 ? 1 : 0));
    const { low, mean, high } = bootstrapCi(samples, {
      reps: 500,
      rng: mulberry32(42),
    });
    expect(mean).toBeCloseTo(0.6);
    expect(low).lessThanOrEqual(mean);
    expect(high).greaterThanOrEqual(mean);
  });

  it('degenerate samples give degenerate intervals', () => {
    expect(bootstrapCi(Array(20).fill(1))).toEqual({
      low: 1,
      high: 1,
      mean: 1,
    });
    expect(bootstrapCi(Array(20).fill(0))).toEqual({
      low: 0,
      high: 0,
      mean: 0,
    });
    expect(bootstrapCi([])).toEqual({ low: 0, high: 0, mean: 0 });
  });

  it('widens with the confidence level', () => {
    const samples = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 0 : 1));
    const ci95 = bootstrapCi(samples, { reps: 400, rng: mulberry32(11) });
    const ci99 = bootstrapCi(samples, {
      reps: 400,
      rng: mulberry32(11),
      level: 0.99,
    });
    expect(ci99.low).lessThanOrEqual(ci95.low);
    expect(ci99.high).greaterThanOrEqual(ci95.high);
  });
});

describe('bootstrapLeagueCi', () => {
  const results: CandidateResults = {
    'real:aaaa': [1, 1, 1, 0, 1, 0],
    'baseline-random:bbbb': [1, 0, 0, 1],
  };

  it('contains the point score and matches leagueScore', () => {
    const ci = bootstrapLeagueCi(results, league2, {
      reps: 400,
      rng: mulberry32(3),
    });
    expect(ci.score).toBeCloseTo(leagueScore(results, league2).score);
    expect(ci.mean).toBeCloseTo(ci.score);
    expect(ci.low).lessThanOrEqual(ci.score);
    expect(ci.high).greaterThanOrEqual(ci.score);
  });

  it('is deterministic for a seeded rng', () => {
    const a = bootstrapLeagueCi(results, league2, {
      reps: 300,
      rng: mulberry32(5),
    });
    const b = bootstrapLeagueCi(results, league2, {
      reps: 300,
      rng: mulberry32(5),
    });
    expect(a).toEqual(b);
  });

  it('returns zeros when nothing was played', () => {
    const ci = bootstrapLeagueCi({}, league2, { reps: 100 });
    expect(ci).toEqual({ low: 0, high: 0, mean: 0, score: 0, perMember: [] });
  });
});
