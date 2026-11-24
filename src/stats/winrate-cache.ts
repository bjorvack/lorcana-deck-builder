/**
 * localStorage cache for engine-verified winrate estimates (openspec change
 * cache-engine-winrate): a completed 64-game run takes ~65–75 s, so the
 * result is cached per (deck signature, engine commit, opponent pool,
 * budget) and reused on subsequent page loads instead of re-simulating.
 *
 * Storage: localStorage under versioned keys with an LRU index (bounded —
 * per-game logs make a single estimate ~100 KB, and the 5 MB origin quota
 * must not fill). Every access is try/catch-guarded: an unavailable or
 * corrupted localStorage degrades to "no cache" and the estimator runs.
 */

import type { EngineWinrateEstimate } from './engine-winrate';
import { fnv1a32 } from './engine-winrate';

const CACHE_VERSION = 1;
const CACHE_PREFIX = `winrate-estimate:v${CACHE_VERSION}:`;
const INDEX_KEY = 'winrate-estimate:v1:index';
/** keep the N most recent estimates — per-game logs make them ~100 KB each */
const CACHE_MAX_ENTRIES = 8;

export interface CacheKeyInputs {
  deckSignature: string;
  engineCommit: string;
  /** exact opponent decks used — a re-export invalidates the cache */
  opponents: unknown;
  games: number;
}

/** stable cache key for an estimate's inputs */
export function cacheKeyFor(inputs: CacheKeyInputs): string {
  const fingerprint = fnv1a32(
    JSON.stringify([
      inputs.deckSignature,
      inputs.engineCommit,
      inputs.opponents,
      inputs.games,
    ]),
  ).toString(16);
  return `${CACHE_PREFIX}${fingerprint}`;
}

function readIndex(): Array<{ key: string; savedAt: number }> {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as Array<{ key: string; savedAt: number }>)
      : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(index: Array<{ key: string; savedAt: number }>): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // quota or unavailable: the cache is best-effort by design
  }
}

/**
 * Load a cached estimate. Returns null on miss, corruption, or version
 * mismatch (the caller then runs the estimator and saves).
 */
export function loadCachedEstimate(key: string): EngineWinrateEstimate | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      cacheVersion?: number;
      estimate?: EngineWinrateEstimate;
    };
    if (parsed.cacheVersion !== CACHE_VERSION || !parsed.estimate?.ci)
      return null;
    touch(key);
    return parsed.estimate;
  } catch {
    return null;
  }
}

/** touch the LRU index for a key (most-recently-used ordering) */
function touch(key: string): void {
  const index = readIndex().filter((e) => e.key !== key);
  index.push({ key, savedAt: Date.now() });
  writeIndex(index);
}

/**
 * Save an estimate under a cache key, evicting the oldest entries beyond
 * CACHE_MAX_ENTRIES. Best-effort: quota errors are swallowed (the next run
 * simply re-simulates).
 */
export function saveCachedEstimate(
  key: string,
  estimate: EngineWinrateEstimate,
): void {
  try {
    const payload = JSON.stringify({ cacheVersion: CACHE_VERSION, estimate });
    // refuse to cache oversized estimates (corrupt or bloated logs) rather
    // than filling the origin quota
    if (payload.length > 400_000) return;
    localStorage.setItem(key, payload);
    const index = readIndex().filter((e) => e.key !== key);
    index.push({ key, savedAt: Date.now() });
    while (index.length > CACHE_MAX_ENTRIES) {
      const oldest = index.shift();
      if (oldest) localStorage.removeItem(oldest.key);
    }
    writeIndex(index);
  } catch {
    // quota exceeded: drop this save — the estimator re-runs next time
  }
}

/** remove every cached estimate and the LRU index (diagnostics/reset) */
export function clearEstimateCache(): void {
  try {
    for (const entry of readIndex()) localStorage.removeItem(entry.key);
    localStorage.removeItem(INDEX_KEY);
  } catch {
    // unavailable: nothing to clear
  }
}
