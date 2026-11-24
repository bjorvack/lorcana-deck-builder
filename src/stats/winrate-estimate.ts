import type { Card, DeckState } from '../data/types';
import { RACE_MAX_TURNS, simulateRace } from './goldfish';
import type { OpponentProfile } from './profiles';

/**
 * Seeded winrate-probability estimator (deck-winrate-probability): pools
 * independent goldfish-race batches into a 2,000-trial estimate with a Wilson
 * 95% confidence interval. Runs asynchronously — one `simulateRace` call per
 * chunk with a macrotask yield between chunks so the UI never blocks — and is
 * cancelled through a caller-owned abort token checked before each chunk.
 *
 * Seeding is batched, not stream-split: `simulateRace` draws a data-dependent
 * number of rng values per trial (challenge/evasive/removal rolls, variable
 * game length), so the generator state at a chunk boundary is not a fixed
 * offset in the stream and a chunked run cannot reproduce one continuous
 * 2,000-trial run without instrumenting the simulator. Instead each chunk
 * seeds its own generator from `chunkSeed(seedBase, chunk)`; the pooled result
 * is a 5×400 independent-batch estimate that stays a pure function of the deck
 * (deterministic per deck, the property the spec requires).
 */

export const WINRATE_CHUNKS = 5;
export const WINRATE_TRIALS_PER_CHUNK = 400;
export const WINRATE_PROFILE_ID: OpponentProfile['id'] = 'midrange';

/** two-sided 95% normal quantile */
const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion. Returns [0, 0] for a
 * zero-trial sample; bounds are clamped to the probability range.
 */
export function wilsonInterval(
  wins: number,
  trials: number,
  z: number = Z_95,
): WilsonInterval {
  if (trials <= 0) return { low: 0, high: 0 };
  const p = wins / trials;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) /
    denom;
  return {
    // p = 0 or 1: the bounds meet the point estimate exactly, but the float
    // round-trip leaves ~1e-19 residue — pin the mathematical bound
    low: p <= 0 ? 0 : Math.max(0, center - half),
    high: p >= 1 ? 1 : Math.min(1, center + half),
  };
}

/** FNV-1a 32-bit over the string's UTF-16 code units (seed hashing) */
export function fnv1a32(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Canonical content signature of the deck's card list — the estimate depends
 * only on the resolved cards, so title/inks/format are deliberately excluded
 * and the signature is stable across title-only edits.
 */
export const deckSignature = (deck: DeckState): string =>
  Object.entries(deck.cards)
    .map(([id, count]) => `${Number(id)}:${count}`)
    .sort()
    .join(',');

/** per-chunk seed: mixes the deck's seed base with the chunk index */
export const chunkSeed = (seedBase: number, chunk: number): number =>
  fnv1a32(`${seedBase}:${chunk}`);

export interface WinrateEstimate {
  profileId: OpponentProfile['id'];
  wins: number;
  /** pooled trials across all chunks */
  trials: number;
  winRate: number;
  ci: WilsonInterval;
}

export interface WinrateEstimateOptions {
  /** run token — checked before each chunk; true discards the whole run */
  shouldAbort?: () => boolean;
  chunks?: number;
  trialsPerChunk?: number;
  /** overrides the deck-signature-derived seed (tests) */
  seedBase?: number;
  profileId?: OpponentProfile['id'];
  maxTurns?: number;
  onThePlay?: boolean;
}

/**
 * Pool `chunks` × `trialsPerChunk` goldfish races into one estimate.
 * Resolves null when the run is aborted (no partial result is ever exposed)
 * or when no deck card resolves to the catalog.
 */
export async function estimateWinrate(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: WinrateEstimateOptions = {},
): Promise<WinrateEstimate | null> {
  const chunks = opts.chunks ?? WINRATE_CHUNKS;
  const trialsPerChunk = opts.trialsPerChunk ?? WINRATE_TRIALS_PER_CHUNK;
  const profileId = opts.profileId ?? WINRATE_PROFILE_ID;
  const maxTurns = opts.maxTurns ?? RACE_MAX_TURNS;
  const onThePlay = opts.onThePlay ?? true;
  const seedBase = opts.seedBase ?? fnv1a32(deckSignature(deck));

  let wins = 0;
  for (let chunk = 0; chunk < chunks; chunk++) {
    if (opts.shouldAbort?.()) return null;
    // macrotask yield between chunks: pending rendering/input gets a slot
    if (chunk > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const race = simulateRace(deck, byId, profileId, {
      trials: trialsPerChunk,
      seed: chunkSeed(seedBase, chunk),
      maxTurns,
      onThePlay,
    });
    if (!race) return null;
    // winRate·trials recovers the integer win count (wins ≤ trials, so the
    // float round-trip is far below 0.5)
    wins += Math.round(race.winRate * trialsPerChunk);
  }

  const trials = chunks * trialsPerChunk;
  return {
    profileId,
    wins,
    trials,
    winRate: wins / trials,
    ci: wilsonInterval(wins, trials),
  };
}
