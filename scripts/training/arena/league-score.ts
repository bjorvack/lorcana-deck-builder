/**
 * League scoring (self-play-league, task 3.2) — pure math, no game playing.
 *
 * A candidate's meta-weighted win rate is W_i = Σ_j W_ij·P(j), where W_ij is
 * the candidate's win rate against league member j and P(j) is that member's
 * share. Members the candidate has not played (e.g. pairings stopped early by
 * SPRT) are excluded and the remaining shares are renormalized, so the score
 * stays a proper [0,1] win-rate-like quantity over the covered share.
 *
 * Confidence intervals are percentile bootstraps over per-member game
 * outcomes with a seeded rng — deterministic for identical inputs.
 */
import { mulberry32 } from '../prng';
import type { League } from './league';

/**
 * Per-member game outcomes from the candidate's perspective:
 * member id → list of 1 (win) / 0 (loss) per game played.
 */
export type CandidateResults = Record<string, number[]>;

export interface MemberScore {
  memberId: string;
  /** league share P(j) */
  share: number;
  games: number;
  wins: number;
  winRate: number;
  /** share renormalized over the covered (played) members */
  effectiveShare: number;
  /** winRate × effectiveShare — Σ contributions = score */
  contribution: number;
}

export interface LeagueScore {
  score: number;
  perMember: MemberScore[];
  /** sum of shares of members actually played (≤ 1) */
  coveredShare: number;
}

export function leagueScore(
  results: CandidateResults,
  league: League,
): LeagueScore {
  const byId = new Map(league.members.map((m) => [m.id, m]));
  const perMember: MemberScore[] = [];
  let coveredShare = 0;
  for (const [memberId, outcomes] of Object.entries(results)) {
    const member = byId.get(memberId);
    if (!member || outcomes.length === 0) continue;
    coveredShare += member.share;
    let wins = 0;
    for (const outcome of outcomes) if (outcome > 0) wins++;
    perMember.push({
      memberId,
      share: member.share,
      games: outcomes.length,
      wins,
      winRate: wins / outcomes.length,
      effectiveShare: 0,
      contribution: 0,
    });
  }
  // deterministic ordering regardless of results key order
  perMember.sort((a, b) => a.memberId.localeCompare(b.memberId));
  for (const entry of perMember) {
    entry.effectiveShare = coveredShare > 0 ? entry.share / coveredShare : 0;
    entry.contribution = entry.winRate * entry.effectiveShare;
  }
  const score = perMember.reduce((sum, entry) => sum + entry.contribution, 0);
  return { score, perMember, coveredShare };
}

export interface BootstrapOptions {
  /** resample count (default 1000) */
  reps?: number;
  /** seeded rng; default mulberry32(1) for reproducible intervals */
  rng?: () => number;
  /** confidence level (default 0.95) */
  level?: number;
}

export interface BootstrapCi {
  low: number;
  high: number;
  /** point estimate (mean of the samples / league score) */
  mean: number;
}

const percentile = (
  sorted: number[],
  level: number,
  reps: number,
): [number, number] => {
  const alpha = (1 - level) / 2;
  const lowIdx = Math.floor(alpha * reps);
  const highIdx = Math.min(reps - 1, Math.ceil((1 - alpha) * reps) - 1);
  return [sorted[lowIdx]!, sorted[highIdx]!];
};

/**
 * Percentile bootstrap CI for the mean of a sample (e.g. pooled 1/0 game
 * outcomes of a win rate). Seeded rng → deterministic.
 */
export function bootstrapCi(
  samples: number[],
  opts: BootstrapOptions = {},
): BootstrapCi {
  const reps = opts.reps ?? 1000;
  const level = opts.level ?? 0.95;
  const rng = opts.rng ?? mulberry32(1);
  const n = samples.length;
  if (n === 0) return { low: 0, high: 0, mean: 0 };
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[Math.floor(rng() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const [low, high] = percentile(means, level, reps);
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  return { low, high, mean };
}

export interface LeagueBootstrapCi extends BootstrapCi {
  score: number;
  perMember: MemberScore[];
}

/**
 * Bootstrap CI for the meta-weighted league score: resample each played
 * member's game outcomes independently (the resampling units), recompute the
 * weighted score per replicate and take percentiles. Seeded → deterministic.
 */
export function bootstrapLeagueCi(
  results: CandidateResults,
  league: League,
  opts: BootstrapOptions = {},
): LeagueBootstrapCi {
  const point = leagueScore(results, league);
  const reps = opts.reps ?? 1000;
  const level = opts.level ?? 0.95;
  const rng = opts.rng ?? mulberry32(1);
  if (point.perMember.length === 0) {
    return { low: 0, high: 0, mean: 0, score: 0, perMember: [] };
  }
  const played = point.perMember.map((entry) => ({
    id: entry.memberId,
    outcomes: results[entry.memberId]!,
  }));
  const scores: number[] = [];
  for (let r = 0; r < reps; r++) {
    const resampled: CandidateResults = {};
    for (const { id, outcomes } of played) {
      const sample: number[] = new Array(outcomes.length);
      for (let i = 0; i < outcomes.length; i++) {
        sample[i] = outcomes[Math.floor(rng() * outcomes.length)]!;
      }
      resampled[id] = sample;
    }
    scores.push(leagueScore(resampled, league).score);
  }
  scores.sort((a, b) => a - b);
  const [low, high] = percentile(scores, level, reps);
  return {
    low,
    high,
    mean: point.score,
    score: point.score,
    perMember: point.perMember,
  };
}
