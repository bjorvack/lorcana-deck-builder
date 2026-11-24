import type { DeckState } from '../data/types';
import { mulberry32 } from './rng';

/**
 * Engine-verified winrate estimator (openspec change engine-winrate): plays
 * REAL full-rules Lorcana games in the browser — the user's completed deck vs
 * shipped baseline decks, the heuristic bot on both seats — through the
 * pinned-engine bundle built by `npm run engine:bundle`.
 *
 * Pre-committed budget: 4 opponent decks × 16 games (8 per seat,
 * seat-alternating) = 64 games, run in batches of 4 with a macrotask yield
 * between batches so the UI never blocks; the caller-owned run token is
 * checked before every batch and an aborted run discards everything. Seeds
 * are deterministic per deck (signature hash + opponent + game index), so the
 * same deck always produces the same estimate. The observed win rate ships
 * with a Wilson 95% confidence interval; every game's per-turn log is kept
 * for the panel's review disclosure.
 */

/** games per opponent deck (8 per seat, seat-alternating) */
export const GAMES_PER_OPPONENT = 16;
/** games played between macrotask yields */
export const ENGINE_BATCH_SIZE = 4;
/** shipped baseline decks (real held-out tournament members) */
export const OPPONENT_COUNT = 4;
export const ENGINE_GAMES = GAMES_PER_OPPONENT * OPPONENT_COUNT;

export interface WilsonInterval {
  low: number;
  high: number;
}

/** two-sided 95% normal quantile */
const Z_95 = 1.959963984540054;

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

// ---------------------------------------------------------------------------
// Opponent pool + bundle loading
// ---------------------------------------------------------------------------

export interface OpponentDeck {
  id: string;
  name: string;
  inks: string[];
  /** our canonical print id → count (the engine bundle resolves these) */
  cards: Record<string, number>;
  origin?: string;
}

export interface OpponentsArtifact {
  format: number;
  engineCommit: string;
  strategyId: string;
  generatedOn: string;
  decks: OpponentDeck[];
}

export const engineBundleUrl = (
  engineCommit: string,
  base = `${import.meta.env.BASE_URL ?? '/'}`,
): string => `${base}data/engine-bundle-${engineCommit.slice(0, 8)}.js`;

export async function loadOpponents(
  base = `${import.meta.env.BASE_URL ?? '/'}`,
): Promise<OpponentsArtifact | null> {
  try {
    const res = await fetch(`${base}data/winrate-opponents.json`, {
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    const artifact = (await res.json()) as OpponentsArtifact;
    return artifact.decks.length > 0 ? artifact : null;
  } catch {
    return null;
  }
}

/** per-turn log lines the bundle emits for the review disclosure */
export interface EngineGameLogTurn {
  turn: number;
  p1: string[];
  p2: string[];
  lore: { p1: number; p2: number };
}

export interface EngineGameResult {
  winner: 'p1' | 'p2' | null;
  turns: number;
  incomplete: boolean;
  log: EngineGameLogTurn[];
}

/** the bundle's createGame — injectable so tests can play fake games */
export type EnginePlayGame = (input: {
  deckA: Record<string, number>;
  deckB: Record<string, number>;
  seed: string;
  firstPlayer?: 'p1' | 'p2';
}) => Promise<EngineGameResult>;

interface EngineBundle {
  engineCommit: string;
  strategyId: string;
  attribution: string;
  createGame: EnginePlayGame;
}

let bundleCache: Promise<EngineBundle> | null = null;
let bundleCacheUrl: string | null = null;

/**
 * Lazily import the engine bundle once (an 8 MB artifact — deferred until the
 * first estimate) and cache it. The static-URL dynamic import is marked
 * @vite-ignore so Vite ships it as a runtime import of a public/ file rather
 * than trying to resolve it at build time.
 */
export function loadEngineBundle(url: string): Promise<EngineBundle> {
  if (bundleCache && bundleCacheUrl === url) return bundleCache;
  bundleCacheUrl = url;
  bundleCache = import(/* @vite-ignore */ url) as Promise<EngineBundle>;
  return bundleCache;
}

/** test seam: reset the cached bundle module */
export function resetEngineBundleCache(): void {
  bundleCache = null;
  bundleCacheUrl = null;
}

/** default game player: bundle createGame on the opponents artifact's commit */
export function bundlePlayGame(engineCommit: string): EnginePlayGame {
  return (input) =>
    loadEngineBundle(engineBundleUrl(engineCommit)).then((bundle) =>
      bundle.createGame(input),
    );
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

export interface EngineGameSummary {
  opponentId: string;
  opponentName: string;
  /** the seat the user's deck played */
  seat: 'p1' | 'p2';
  seed: string;
  winner: 'p1' | 'p2' | null;
  turns: number;
  log: EngineGameLogTurn[];
}

export interface EngineWinrateEstimate {
  wins: number;
  games: number;
  winRate: number;
  ci: WilsonInterval;
  engineCommit: string;
  /** per-game summaries, schedule order — the review disclosure's source */
  played: EngineGameSummary[];
}

export interface EngineWinrateOptions {
  /** run token — checked before each batch; true discards the whole run */
  shouldAbort?: () => boolean;
  /** batch completion callback for the loader ("Simulating X/Y games…") */
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** overrides the deck-signature-derived seed (tests) */
  seedBase?: number;
  /** overrides the shipped opponent pool (tests) */
  opponents?: OpponentsArtifact;
  /** overrides the bundle-driven game player (tests) */
  playGame?: EnginePlayGame;
  /** games between macrotask yields (tests) */
  batchSize?: number;
}

interface ScheduledGame {
  opponentIndex: number;
  gameIndex: number;
  seat: 'p1' | 'p2';
  seed: string;
}

/**
 * The full pre-committed schedule: seat-alternating games per opponent, each
 * seeded from mulberry32(deckSignature) consumed in schedule order — so the
 * seeds are a pure function of the deck and batch boundaries never shift them.
 */
export function scheduleGames(seedBase: number): ScheduledGame[] {
  const rng = mulberry32(seedBase);
  const schedule: ScheduledGame[] = [];
  for (let o = 0; o < OPPONENT_COUNT; o++) {
    for (let g = 0; g < GAMES_PER_OPPONENT; g++) {
      schedule.push({
        opponentIndex: o,
        gameIndex: g,
        // even games on the play seat, odd on the draw seat — both seats
        // sampled so seat bias cancels
        seat: g % 2 === 0 ? 'p1' : 'p2',
        seed: String(Math.floor(rng() * 0xffffffff)),
      });
    }
  }
  return schedule;
}

/**
 * Run the pre-committed 64-game budget and pool it into one estimate.
 * Resolves null when the run is aborted (no partial result is ever exposed),
 * when the opponents artifact or engine bundle is unavailable, or when the
 * deck has no resolvable cards.
 */
export async function estimateEngineWinrate(
  deck: DeckState,
  opts: EngineWinrateOptions = {},
): Promise<EngineWinrateEstimate | null> {
  const deckCards = Object.fromEntries(
    Object.entries(deck.cards).filter(([, count]) => count > 0),
  );
  if (Object.keys(deckCards).length === 0) return null;

  const pool = opts.opponents ?? (await loadOpponents());
  if (!pool) return null;
  const opponents = pool.decks.slice(0, OPPONENT_COUNT);
  if (opponents.length === 0) return null;

  const playGame = opts.playGame ?? bundlePlayGame(pool.engineCommit);
  const schedule = scheduleGames(opts.seedBase ?? fnv1a32(deckSignature(deck)));
  const batchSize = opts.batchSize ?? ENGINE_BATCH_SIZE;

  const games: EngineGameSummary[] = [];
  let wins = 0;
  for (let start = 0; start < schedule.length; start += batchSize) {
    if (opts.shouldAbort?.()) return null;
    // macrotask yield between batches: pending rendering/input gets a slot
    if (start > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const task of schedule.slice(start, start + batchSize)) {
      const opponent = opponents[task.opponentIndex]!;
      // seat swap: the user's deck leads as p1 on even games, mirrors as p2
      // on odd ones so first-player advantage cancels out of the estimate
      const [deckA, deckB] =
        task.seat === 'p1'
          ? [deckCards, opponent.cards]
          : [opponent.cards, deckCards];
      try {
        const result = await playGame({ deckA, deckB, seed: task.seed });
        const won = result.winner === task.seat;
        if (won) wins += 1;
        games.push({
          opponentId: opponent.id,
          opponentName: opponent.name,
          seat: task.seat,
          seed: task.seed,
          winner: result.winner,
          turns: result.turns,
          log: result.log,
        });
      } catch {
        // an unmapped/illegal deck list or engine error voids the run: a
        // partial winrate would overstate the deck
        return null;
      }
    }
    opts.onProgress?.({ completed: games.length, total: schedule.length });
  }

  return {
    wins,
    games: games.length,
    winRate: wins / games.length,
    ci: wilsonInterval(wins, games.length),
    engineCommit: pool.engineCommit,
    played: games,
  };
}
