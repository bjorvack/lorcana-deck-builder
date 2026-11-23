/**
 * Wald sequential probability ratio test (SPRT) for a binomial win rate
 * (self-play-league, task 3.2). Lets a pairing stop as soon as the evidence
 * decides it — decided pairings stop early instead of burning the full game
 * budget.
 *
 * Hypotheses:
 *   H0: p = p0 (even match, default 0.5)
 *   H1: p = p1 (candidate clearly better, default 0.6)
 *
 * The log-likelihood ratio after w wins and l losses is
 *   llr = w·ln(p1/p0) + l·ln((1-p1)/(1-p0))
 * with Wald's bounds
 *   accept H1 ('accept')  when llr ≥ ln((1-β)/α)
 *   accept H0 ('reject')  when llr ≤ ln(β/(1-α))
 *   otherwise             'continue' (keep playing games).
 *
 * With α = β = 0.05 both bounds are ±ln(19) ≈ ±2.944, so with the defaults a
 * pairing is decided after ~17 straight wins or ~14 straight losses.
 */

export const DEFAULT_P0 = 0.5;
export const DEFAULT_P1 = 0.6;
export const DEFAULT_ALPHA = 0.05;
export const DEFAULT_BETA = 0.05;

export type SprtDecision = 'continue' | 'accept' | 'reject';

export interface SprtOptions {
  /** H0 win probability (default 0.5) */
  p0?: number;
  /** H1 win probability, p1 > p0 (default 0.6) */
  p1?: number;
  /** false-accept probability for H1 (default 0.05) */
  alpha?: number;
  /** false-reject probability for H1 (default 0.05) */
  beta?: number;
}

export interface SprtResult {
  decision: SprtDecision;
  /** log-likelihood ratio ln(L1/L0) accumulated so far */
  llr: number;
  /** llr ≥ upper → 'accept' (H1: candidate better) */
  upper: number;
  /** llr ≤ lower → 'reject' (H0: not better) */
  lower: number;
  games: number;
}

export function sprtDecision(
  wins: number,
  losses: number,
  opts: SprtOptions = {},
): SprtResult {
  const p0 = opts.p0 ?? DEFAULT_P0;
  const p1 = opts.p1 ?? DEFAULT_P1;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  const beta = opts.beta ?? DEFAULT_BETA;
  if (p0 <= 0 || p0 >= 1 || p1 <= 0 || p1 >= 1) {
    throw new Error(`SPRT requires 0 < p0, p1 < 1 (got p0=${p0}, p1=${p1})`);
  }
  if (alpha <= 0 || alpha >= 1 || beta <= 0 || beta >= 1) {
    throw new Error(
      `SPRT requires 0 < alpha, beta < 1 (got alpha=${alpha}, beta=${beta})`,
    );
  }
  const llr = wins * Math.log(p1 / p0) + losses * Math.log((1 - p1) / (1 - p0));
  const upper = Math.log((1 - beta) / alpha);
  const lower = Math.log(beta / (1 - alpha));
  let decision: SprtDecision = 'continue';
  if (llr >= upper) decision = 'accept';
  else if (llr <= lower) decision = 'reject';
  return { decision, llr, upper, lower, games: wins + losses };
}
