/**
 * League evaluation scheduler (self-play-league, task 3.2): ties paired
 * seeds, common random numbers, SPRT sequential stopping and league scoring
 * together. Pure scheduling logic — the game player is injected
 * (`opts.play`), so unit tests run against a fake and the CLI
 * (evaluate-candidate.ts) wires real arena games with the run.ts disk cache.
 *
 * Variance reduction (spec "Variance-reduced scheduling", design D4):
 * - Paired seeds: a deck and its twin/mutation share the same seed base per
 *   league member, so both see identical shuffles against the same opponent
 *   while the cache files land in their own pair directories.
 * - Common random numbers: one master seed + the member index derive every
 *   seed base (`memberSeedBase`, batch.ts's ×1000 spacing convention), so
 *   schedules are reproducible and aligned across members. With the default
 *   spacing, `gamesPerMember` must stay below 1,000 or member seed ranges
 *   would overlap.
 * - SPRT: members play in batches of `opts.batchSize`; when the cumulative
 *   wins/losses cross the Wald bounds the remaining games of that pairing
 *   are not simulated and the member is recorded as stopped.
 *
 * The referee comes from `opts` (default the shipped heuristic bot, design
 * D2a): league fitness uses the cheap heuristic referee; acceptance matches
 * may pass the IS-MCTS strategy object once its gate passes.
 *
 * Drawn/incomplete games (winner null) count as non-wins for the score and
 * are excluded from the SPRT likelihood ratio (binomial wins/losses only).
 */
import type { AutomatedActionStrategy } from '@tcg/lorcana-engine/automation';
import type { League, LeagueMember } from './league';
import type {
  BootstrapOptions,
  CandidateResults,
  LeagueBootstrapCi,
  LeagueScore,
} from './league-score';
import { bootstrapLeagueCi, leagueScore } from './league-score';
import { type SprtOptions, sprtDecision } from './sprt';

/** heuristic referee used unless the caller passes a stronger one (D2a) */
export const DEFAULT_REFEREE = 'best-deck-aware-lore-race';
export const DEFAULT_GAMES_PER_MEMBER = 32;
export const DEFAULT_BATCH_SIZE = 8;
/** member seed bases are spaced so per-member seed ranges never overlap */
export const MEMBER_SEED_SPACING = 1000;

/** seed base for league member `memberIndex`, derived from one master seed */
export function memberSeedBase(
  masterSeed: number,
  memberIndex: number,
): number {
  return masterSeed + memberIndex * MEMBER_SEED_SPACING;
}

/** the per-game seed inside a member schedule: `<seedBase>-<game>` */
export function seedForGame(seedBase: number, game: number): string {
  return `${seedBase}-${game}`;
}

export interface BatchGameRequest {
  /** candidate (or twin) deck — seat p1 */
  deckA: Record<string, number>;
  /** league member deck — seat p2 */
  deckB: Record<string, number>;
  seedBase: number;
  /** first game index of this batch (games run `from .. from+count-1`) */
  from: number;
  count: number;
  /** full member schedule size — lets cached players serve whole schedules */
  scheduleCount: number;
  referee: string | AutomatedActionStrategy;
}

export interface BatchGameResult {
  /** 'p1' = candidate/twin win, 'p2' = member win, null = incomplete */
  winner: string | null;
}

/** plays one batch of games; fake in tests, cached arena playGame in the CLI */
export type BatchPlayer = (request: BatchGameRequest) => BatchGameResult[];

export interface MemberResult {
  memberId: string;
  games: number;
  wins: number;
  losses: number;
  /** SPRT decided this pairing before the full game budget was used */
  stopped: boolean;
  seedBase: number;
  /** SPRT verdict ('accept' = candidate better); null while undecided */
  decision: 'accept' | 'reject' | null;
}

export interface DeckEvaluation {
  results: MemberResult[];
  score: LeagueScore;
  ci: LeagueBootstrapCi;
}

export interface EvaluationResult extends DeckEvaluation {
  /** paired mode: the twin evaluated on the same seed bases as the candidate */
  twin?: DeckEvaluation;
}

export interface EvaluateOptions {
  /** injected game player */
  play: BatchPlayer;
  /** master seed: member seed bases derive from it + the member index */
  masterSeed: number;
  /** max games per member (default 32; keep below MEMBER_SEED_SPACING) */
  gamesPerMember?: number;
  /** games between SPRT checks (default 8) */
  batchSize?: number;
  /** referee strategy id or object (default the shipped heuristic bot) */
  referee?: string | AutomatedActionStrategy;
  /** paired mode: also evaluate this related deck on the same seed bases */
  twinDeck?: Record<string, number>;
  /** forwarded to sprtDecision */
  sprt?: SprtOptions;
  /** forwarded to bootstrapLeagueCi */
  bootstrap?: BootstrapOptions;
}

interface MemberSchedule {
  result: MemberResult;
  /** 1 win / 0 non-win per game, in play order */
  outcomes: number[];
}

function runMemberSchedule(
  deckA: Record<string, number>,
  member: LeagueMember,
  memberIndex: number,
  opts: {
    play: BatchPlayer;
    masterSeed: number;
    gamesPerMember: number;
    batchSize: number;
    referee: string | AutomatedActionStrategy;
    sprt?: SprtOptions;
  },
): MemberSchedule {
  const seedBase = memberSeedBase(opts.masterSeed, memberIndex);
  const outcomes: number[] = [];
  let wins = 0;
  let losses = 0;
  let stopped = false;
  let decision: 'accept' | 'reject' | null = null;
  for (let from = 0; from < opts.gamesPerMember; from += opts.batchSize) {
    const count = Math.min(opts.batchSize, opts.gamesPerMember - from);
    const played = opts.play({
      deckA,
      deckB: member.deck,
      seedBase,
      from,
      count,
      scheduleCount: opts.gamesPerMember,
      referee: opts.referee,
    });
    for (const game of played) {
      if (game.winner === 'p1') {
        wins += 1;
        outcomes.push(1);
      } else {
        // p2 win or incomplete: a non-win for the score, and — for null
        // winners — no SPRT evidence either way
        if (game.winner === 'p2') losses += 1;
        outcomes.push(0);
      }
    }
    const sprt = sprtDecision(wins, losses, opts.sprt);
    if (sprt.decision !== 'continue') {
      decision = sprt.decision;
      // a decision on the final batch is not an early stop
      stopped = from + count < opts.gamesPerMember;
      break;
    }
  }
  return {
    result: {
      memberId: member.id,
      games: outcomes.length,
      wins,
      losses,
      stopped,
      seedBase,
      decision,
    },
    outcomes,
  };
}

function evaluateDeck(
  deckA: Record<string, number>,
  league: League,
  opts: EvaluateOptions,
): DeckEvaluation {
  const gamesPerMember = opts.gamesPerMember ?? DEFAULT_GAMES_PER_MEMBER;
  if (!Number.isInteger(gamesPerMember) || gamesPerMember < 1) {
    throw new Error(
      `gamesPerMember must be a positive integer (got ${gamesPerMember})`,
    );
  }
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(
      `batchSize must be a positive integer (got ${opts.batchSize})`,
    );
  }
  const results: MemberResult[] = [];
  const outcomesByMember: CandidateResults = {};
  league.members.forEach((member, index) => {
    const schedule = runMemberSchedule(deckA, member, index, {
      play: opts.play,
      masterSeed: opts.masterSeed,
      gamesPerMember,
      batchSize,
      referee: opts.referee ?? DEFAULT_REFEREE,
      sprt: opts.sprt,
    });
    results.push(schedule.result);
    if (schedule.outcomes.length > 0) {
      outcomesByMember[member.id] = schedule.outcomes;
    }
  });
  return {
    results,
    // leagueScore renormalizes shares over the members actually played
    score: leagueScore(outcomesByMember, league),
    ci: bootstrapLeagueCi(outcomesByMember, league, opts.bootstrap),
  };
}

/**
 * Evaluate a candidate deck against the league: per member, play up to
 * `gamesPerMember` games in batches with SPRT sequential stopping, then score
 * with the meta-weighted league score and a bootstrap CI (shares renormalize
 * over the members actually played). With `opts.twinDeck`, the twin is
 * evaluated on the same per-member seed bases so its games share the
 * candidate's shuffles (paired seeds, design D4).
 */
export function evaluateCandidateVsLeague(
  candidateDeck: Record<string, number>,
  league: League,
  opts: EvaluateOptions,
): EvaluationResult {
  const candidate = evaluateDeck(candidateDeck, league, opts);
  if (!opts.twinDeck) return candidate;
  return { ...candidate, twin: evaluateDeck(opts.twinDeck, league, opts) };
}
