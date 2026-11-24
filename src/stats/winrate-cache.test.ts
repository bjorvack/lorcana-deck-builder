import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EngineGameSummary,
  EngineWinrateEstimate,
} from './engine-winrate';
import {
  cacheKeyFor,
  clearEstimateCache,
  loadCachedEstimate,
  saveCachedEstimate,
} from './winrate-cache';

const estimate = (winRate: number): EngineWinrateEstimate => ({
  wins: Math.round(winRate * 64),
  games: 64,
  winRate,
  ci: { low: winRate - 0.1, high: winRate + 0.1 },
  engineCommit: '6de59de1',
  played: [],
  cached: true,
});

const keyFor = (deck: string): string =>
  cacheKeyFor({
    deckSignature: deck,
    engineCommit: '6de59de1',
    opponents: [{ id: 'opponent-0' }],
    games: 64,
  });

/** in-memory localStorage stand-in (the vitest node env has none) */
function stubMemoryStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe('cacheKeyFor', () => {
  it('is deterministic per deck and changes with every key input', () => {
    const a = keyFor('1:30,2:30');
    expect(a).toBe(keyFor('1:30,2:30'));
    expect(a).not.toBe(keyFor('1:20,2:40'));
    expect(a).not.toBe(
      cacheKeyFor({
        deckSignature: '1:30,2:30',
        engineCommit: 'ffffffff',
        opponents: [{ id: 'opponent-0' }],
        games: 64,
      }),
    );
    expect(a).not.toBe(
      cacheKeyFor({
        deckSignature: '1:30,2:30',
        engineCommit: '6de59de1',
        opponents: [{ id: 'opponent-1' }],
        games: 64,
      }),
    );
  });
});

describe('load/save round-trip', () => {
  beforeEach(() => stubMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('returns null on a miss and the estimate on a hit', () => {
    const key = keyFor('1:30,2:30');
    expect(loadCachedEstimate(key)).toBeNull();
    saveCachedEstimate(key, estimate(0.55));
    expect(loadCachedEstimate(key)?.winRate).toBe(0.55);
  });

  it('serves the cached flag through the round-trip', () => {
    const key = keyFor('cached-flag');
    saveCachedEstimate(key, estimate(0.6));
    expect(loadCachedEstimate(key)?.cached).toBe(true);
  });

  it('corrupt payloads degrade to null', () => {
    const key = keyFor('corrupt');
    localStorage.setItem(key, '{not json');
    expect(loadCachedEstimate(key)).toBeNull();
  });
});

describe('LRU eviction', () => {
  beforeEach(() => stubMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('evicts the oldest entries beyond the cap', () => {
    for (let i = 0; i < 12; i++) {
      saveCachedEstimate(keyFor(`deck-${i}`), estimate(0.5));
    }
    // 12 saves with a cap of 8: the 4 oldest are evicted
    expect(loadCachedEstimate(keyFor('deck-0'))).toBeNull();
    expect(loadCachedEstimate(keyFor('deck-3'))).toBeNull();
    expect(loadCachedEstimate(keyFor('deck-11'))).not.toBeNull();
  });

  it('a cache hit refreshes recency (LRU, not FIFO)', () => {
    for (let i = 0; i < 8; i++)
      saveCachedEstimate(keyFor(`lru-${i}`), estimate(0.5));
    // touch the oldest — it becomes most-recently used
    expect(loadCachedEstimate(keyFor('lru-0'))).not.toBeNull();
    saveCachedEstimate(keyFor('lru-new'), estimate(0.5));
    // lru-0 survives the eviction that removes lru-1
    expect(loadCachedEstimate(keyFor('lru-0'))).not.toBeNull();
    expect(loadCachedEstimate(keyFor('lru-1'))).toBeNull();
  });
});

describe('clearEstimateCache', () => {
  beforeEach(() => stubMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('removes every estimate and the index', () => {
    saveCachedEstimate(keyFor('clear-1'), estimate(0.5));
    clearEstimateCache();
    expect(loadCachedEstimate(keyFor('clear-1'))).toBeNull();
  });
});

describe('unavailable localStorage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('degrades to no cache', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('unavailable');
      },
      removeItem: () => {},
    });
    expect(loadCachedEstimate(keyFor('x'))).toBeNull();
    expect(() => saveCachedEstimate(keyFor('x'), estimate(0.5))).not.toThrow();
  });
});

describe('cache version', () => {
  beforeEach(() => stubMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('a payload from a different cache version is a miss', () => {
    const key = keyFor('versioned');
    saveCachedEstimate(key, estimate(0.5));
    const raw = localStorage.getItem(key)!;
    const parsed = JSON.parse(raw) as { cacheVersion: number };
    parsed.cacheVersion = 0;
    localStorage.setItem(key, JSON.stringify(parsed));
    expect(loadCachedEstimate(key)).toBeNull();
  });
});

describe('guard branches (quota, corruption, oversize)', () => {
  beforeEach(() => stubMemoryStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('a corrupted index is treated as empty', () => {
    localStorage.setItem('winrate-estimate:v1:index', '{not an array');
    saveCachedEstimate(keyFor('after-corrupt-index'), estimate(0.5));
    expect(loadCachedEstimate(keyFor('after-corrupt-index'))?.winRate).toBe(
      0.5,
    );
  });

  it('an index-write failure does not lose the saved estimate', () => {
    const realSetItem = localStorage.setItem.bind(localStorage);
    // fail only the index write — the payload write succeeds
    vi.stubGlobal('localStorage', {
      ...localStorage,
      setItem: (k: string, v: string) => {
        if (k === 'winrate-estimate:v1:index') {
          throw new Error('quota');
        }
        realSetItem(k, v);
      },
    });
    expect(() =>
      saveCachedEstimate(keyFor('index-fail'), estimate(0.5)),
    ).not.toThrow();
    expect(loadCachedEstimate(keyFor('index-fail'))?.winRate).toBe(0.5);
  });

  it('oversized payloads are not cached (origin-quota guard)', () => {
    const bloated = estimate(0.5);
    // ~700 KB of per-game log lines → past the 400 KB payload guard
    bloated.played = Array.from({ length: 64 }, (_, i) => ({
      ...(bloated.played[0] as EngineGameSummary),
      opponentId: `opp-${i}`,
      log: Array.from({ length: 30 }, (_, t) => ({
        turn: t,
        p1: ['x'.repeat(150)],
        p2: ['y'.repeat(150)],
        lore: { p1: 1, p2: 0 },
      })),
    }));
    const key = keyFor('oversized');
    saveCachedEstimate(key, bloated);
    expect(loadCachedEstimate(key)).toBeNull();
  });

  it('clearEstimateCache tolerates a throwing storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {},
      removeItem: () => {
        throw new Error('unavailable');
      },
    });
    expect(() => clearEstimateCache()).not.toThrow();
  });
});
