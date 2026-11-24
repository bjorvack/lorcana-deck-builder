import type { DeckState } from '../data/types';
import { mulberry32 } from './rng';
import {
  cacheKeyFor,
  loadCachedEstimate,
  saveCachedEstimate,
} from './winrate-cache';

/**
 * Engine-verified winrate estimator (openspec changes engine-winrate +
 * parallel-engine-winrate + cache-engine-winrate): plays REAL full-rules
 * Lorcana games in the browser — the user's completed deck vs shipped
 * baseline decks, the heuristic bot on both seats — through the pinned-engine
 * bundle built by `npm run engine:bundle`.
 *
 * Pre-committed budget: 4 opponent decks × 16 games (8 per seat,
 * seat-alternating) = 64 games, played OFF the main thread by 2–4 module
 * workers (`engine-winrate.worker.ts`) so the page stays fully responsive;
 * progress streams per game. The caller-owned run token terminates all
 * workers on deck changes and an aborted run discards everything. Seeds are
 * deterministic per deck (signature hash + opponent + game index) and the
 * schedule partition cannot change any result — the same deck produces the
 * same estimate regardless of worker count. Results are cached in
 * localStorage (cache-engine-winrate) so subsequent page loads reuse the
 * completed run. The observed win rate ships with a Wilson 95% confidence
 * interval; every game's per-turn log is kept for the panel's review
 * disclosure. A main-thread fallback covers environments without Worker
 * support and the injected-playGame test path.
 */

/** games per opponent deck (8 per seat, seat-alternating) */
export const GAMES_PER_OPPONENT = 16;
/** games played between macrotask yields on the main-thread fallback */
export const ENGINE_BATCH_SIZE = 4;
/** shipped baseline decks (recent, mutually diverse tournament members) */
export const OPPONENT_COUNT = 4;
export const ENGINE_GAMES = GAMES_PER_OPPONENT * OPPONENT_COUNT;

/**
 * Worker count for the parallel run (openspec parallel-engine-winrate):
 * clamped to 2–4, leaving headroom for the page itself. Worker-less
 * environments fall back to the sequential main-thread path.
 */
export function workerCount(): number {
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(2, Math.min(4, cores - 2));
}

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
  /** true when served from the localStorage cache */
  cached: boolean;
}

export interface EngineWinrateOptions {
  /** run token — checked per game; true discards the whole run */
  shouldAbort?: () => boolean;
  /** completion callback for the loader ("Simulating X/Y games…") */
  onProgress?: (progress: { completed: number; total: number }) => void;
  /** per-game callback for the live tally and progressive games list */
  onGame?: (game: EngineGameSummary) => void;
  /** overrides the deck-signature-derived seed (tests) */
  seedBase?: number;
  /** overrides the shipped opponent pool (tests) */
  opponents?: OpponentsArtifact;
  /** overrides the bundle-driven game player (tests) */
  playGame?: EnginePlayGame;
  /** games between macrotask yields on the main-thread fallback (tests) */
  batchSize?: number;
  /** overrides the hardware-aware worker count (tests) */
  workerCount?: number;
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
 * Pool played game summaries into the estimate shape (pure — shared by the
 * worker path and the main-thread fallback).
 */
export function aggregateResults(
  games: EngineGameSummary[],
  engineCommit: string,
  cached = false,
): EngineWinrateEstimate {
  const wins = games.filter((g) => g.winner === g.seat).length;
  return {
    wins,
    games: games.length,
    winRate: games.length === 0 ? 0 : wins / games.length,
    ci: wilsonInterval(wins, games.length),
    engineCommit,
    played: games,
    cached,
  };
}

interface Task {
  scheduleIndex: number;
  deckA: Record<string, number>;
  deckB: Record<string, number>;
  seed: string;
  opponentId: string;
  opponentName: string;
  seat: 'p1' | 'p2';
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

  // cache check (cache-engine-winrate): a completed run for this deck +
  // engine + opponent pool + budget is reused verbatim — the heavy bundle
  // load and the 64 games never re-run on a hit
  const signature = deckSignature(deck);
  const cacheKey = cacheKeyFor({
    deckSignature: signature,
    engineCommit: pool.engineCommit,
    opponents: pool.decks,
    games: ENGINE_GAMES,
  });
  const cached = loadCachedEstimate(cacheKey);
  if (cached) return { ...cached, cached: true };

  const schedule = scheduleGames(opts.seedBase ?? fnv1a32(signature));
  const tasks: Task[] = schedule.map((task, scheduleIndex) => {
    const opponent = opponents[task.opponentIndex]!;
    // seat swap: the user's deck leads as p1 on even games, mirrors as p2
    // on odd ones so first-player advantage cancels out of the estimate
    const [deckA, deckB] =
      task.seat === 'p1'
        ? [deckCards, opponent.cards]
        : [opponent.cards, deckCards];
    return {
      scheduleIndex,
      deckA,
      deckB,
      seed: task.seed,
      opponentId: opponent.id,
      opponentName: opponent.name,
      seat: task.seat,
    };
  });

  // production path: the schedule is partitioned across 2–4 module workers
  // (games are independent — per-game seeds come from the schedule, so the
  // partition cannot change any result); summaries are re-assembled in
  // schedule order. opts.playGame (tests) or a Worker-less environment falls
  // back to the chunked main-thread loop.
  if (!opts.playGame && typeof Worker !== 'undefined') {
    return runParallel(pool.engineCommit, cacheKey, tasks, opts);
  }

  const playGame = opts.playGame ?? bundlePlayGame(pool.engineCommit);
  const batchSize = opts.batchSize ?? ENGINE_BATCH_SIZE;
  const games: EngineGameSummary[] = [];
  for (let start = 0; start < tasks.length; start += batchSize) {
    if (opts.shouldAbort?.()) return null;
    // macrotask yield between batches: pending rendering/input gets a slot
    if (start > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const task of tasks.slice(start, start + batchSize)) {
      try {
        const result = await playGame({
          deckA: task.deckA,
          deckB: task.deckB,
          seed: task.seed,
        });
        games.push({
          opponentId: task.opponentId,
          opponentName: task.opponentName,
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
    opts.onProgress?.({ completed: games.length, total: tasks.length });
  }

  const estimate = aggregateResults(games, pool.engineCommit);
  saveCachedEstimate(cacheKey, estimate);
  return estimate;
}

/**
 * Parallel path: the schedule is partitioned across `workerCount()`
 * module workers (games are independent — per-game seeds come from the
 * schedule, so the partition cannot change any result); per-game summaries
 * stream back for the live tally, and the pooled estimate is assembled in
 * schedule order. Aborting terminates every worker.
 */
export function runParallel(
  engineCommit: string,
  cacheKey: string,
  tasks: Task[],
  opts: EngineWinrateOptions,
): Promise<EngineWinrateEstimate | null> {
  const workers = Math.min(opts.workerCount ?? workerCount(), tasks.length);
  return new Promise((resolve) => {
    const byIndex = new Map<number, EngineGameSummary>();
    const spawned: Worker[] = [];
    const finish = (result: EngineWinrateEstimate | null) => {
      for (const w of spawned) w.terminate();
      resolve(result);
    };
    // deck changed mid-run: terminate everything, discard partial results
    const checkAbort = (): boolean => {
      const aborted = opts.shouldAbort?.() ?? false;
      if (aborted) finish(null);
      return aborted;
    };

    const sliceSize = Math.ceil(tasks.length / workers);
    for (let w = 0; w < workers; w++) {
      const slice = tasks.slice(w * sliceSize, (w + 1) * sliceSize);
      if (slice.length === 0) continue;
      const worker = new Worker(
        new URL('./engine-winrate.worker.ts', import.meta.url),
        { type: 'module' },
      );
      spawned.push(worker);
      worker.onmessage = (event: MessageEvent) => {
        if (checkAbort()) return;
        const message = event.data as
          | { type: 'game'; index: number; summary: EngineGameSummary }
          | { type: 'done' }
          | { type: 'error'; message: string };
        if (message.type === 'game') {
          byIndex.set(message.index, message.summary);
          opts.onGame?.(message.summary);
          opts.onProgress?.({ completed: byIndex.size, total: tasks.length });
          return;
        }
        if (message.type === 'error') {
          // an unmapped/illegal deck list or engine error voids the run
          finish(null);
          return;
        }
        if (byIndex.size === tasks.length) {
          // re-assemble in schedule order for the review disclosure
          const estimate = aggregateResults(
            tasks.map((t) => byIndex.get(t.scheduleIndex)!),
            engineCommit,
          );
          saveCachedEstimate(cacheKey, estimate);
          finish(estimate);
        }
      };
      worker.onerror = () => finish(null);
      worker.postMessage({
        type: 'run',
        bundleUrl: engineBundleUrl(engineCommit),
        games: slice,
      });
    }
  });
}
