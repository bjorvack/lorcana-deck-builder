import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import {
  determinizeHiddenZones,
  hashSeed,
  isMctsStrategy,
  type SimEngine,
} from './is-mcts';
import {
  bootstrapCi,
  evaluateGate,
  type GateGame,
  gateCacheName,
  gatePartsDirName,
  mergeGateGames,
  pairSetup,
  readGateCacheLines,
  remainingPairs,
  sweepOrphanedGateParts,
} from './is-mcts-gate';
import { MAX_ACTIONS, playGame, strategyById } from './play';

/** a fake simulator whose playout value depends on the determinized deck
 * order — the seam the determinism tests exercise */
function fakeEngineFactory(): (state: unknown) => SimEngine {
  // state holder in closure: SimEngine's surface has no state property
  let current: FakeState | undefined;
  return (state) => {
    const engine: SimEngine = {
      loadState(next) {
        current = next as FakeState;
      },
      getCurrentActorId: () => 'p1',
      getBoard: () => ({
        // lore from the FIRST instance id in the determinized deck:p2 —
        // re-dealing changes it, so seed changes change search values
        players: {
          p1: { lore: deckFingerprint(current) },
          p2: { lore: 0 },
        },
      }),
      takeAutomatedActionForCurrentActor: () => ({
        finalResult: { success: true },
      }),
    };
    engine.loadState(state);
    return engine;
  };
}

interface FakeState {
  ctx: {
    random: { seed: string };
    zones: {
      private: {
        zoneCards: Record<string, string[]>;
        cardIndex: Record<
          string,
          { zoneKey: string; index: number; ownerID: string }
        >;
      };
    };
  };
  G: { loreToWin: number };
}

function fakeState(deckP2: string[]): FakeState {
  const zoneCards: Record<string, string[]> = {
    'deck:p1': ['p1-a', 'p1-b', 'p1-c', 'p1-d'],
    'deck:p2': deckP2,
    'hand:p2': ['p2-x'],
    'hand:p1': ['p1-h'],
  };
  const cardIndex: FakeState['ctx']['zones']['private']['cardIndex'] = {};
  for (const [zoneKey, ids] of Object.entries(zoneCards)) {
    for (const [index, id] of ids.entries()) {
      cardIndex[id] = { zoneKey, index, ownerID: id.slice(0, 2) };
    }
  }
  return {
    ctx: {
      random: { seed: 'fake' },
      zones: { private: { zoneCards, cardIndex } },
    },
    G: { loreToWin: 20 },
  };
}

function deckFingerprint(state: FakeState | undefined): number {
  const first = state?.ctx.zones.private.zoneCards['deck:p2']?.[0] ?? '';
  let sum = 0;
  for (let i = 0; i < first.length; i++) sum += first.charCodeAt(i) * (i + 1);
  return sum % 7;
}

const fakeBase = (order: string[]) => ({
  name: 'fake-base',
  summarizeCandidates: () =>
    order.map((cardId) => ({ candidate: { family: 'playCard', cardId } })),
});

const fakeContext = (state: FakeState) => ({
  actorId: 'p1',
  opponentId: 'p2',
  turnNumber: 4,
  board: { players: { p1: { lore: 3 }, p2: { lore: 2 } } },
  authoritativeHints: { state },
});

const fakeCandidates = ['a', 'b', 'c'].map((cardId) => ({
  family: 'playCard',
  cardId,
}));

describe('is-mcts determinization', () => {
  it('re-deals hidden zones consistently and keeps public counts', () => {
    const state = fakeState(['p2-1', 'p2-2', 'p2-3', 'p2-4', 'p2-5']);
    determinizeHiddenZones(state, 'p1', 'p2', () => 0);
    const zones = state.ctx.zones.private.zoneCards;
    // hand keeps its count, deck keeps the rest, pool is preserved
    expect(zones['hand:p2']).toHaveLength(1);
    expect(zones['deck:p2']).toHaveLength(5);
    expect([...zones['hand:p2']!, ...zones['deck:p2']!].sort()).toEqual(
      ['p2-1', 'p2-2', 'p2-3', 'p2-4', 'p2-5'].concat(['p2-x']).sort(),
    );
    // card index follows the new zone membership: every re-dealt instance
    // lands in one of the two hidden zones at a consistent position
    const hand = zones['hand:p2'] ?? [];
    const deck = zones['deck:p2'] ?? [];
    for (const [zoneKey, ids] of [
      ['hand:p2', hand],
      ['deck:p2', deck],
    ] as const) {
      for (const [index, id] of ids.entries()) {
        expect(state.ctx.zones.private.cardIndex[id]!.zoneKey).toBe(zoneKey);
        expect(state.ctx.zones.private.cardIndex[id]!.index).toBe(index);
      }
    }
    expect(hand.length + deck.length).toBe(6);
  });

  it('is deterministic for a fixed rng stream and shuffles with a new one', () => {
    const source = ['p2-1', 'p2-2', 'p2-3', 'p2-4', 'p2-5', 'p2-6'];
    const a = fakeState(source);
    const b = fakeState(source);
    const lcg = (): (() => number) => {
      let x = 1;
      return () => {
        x = (x * 9301 + 49297) % 233280;
        return x / 233280;
      };
    };
    determinizeHiddenZones(a, 'p1', 'p2', lcg());
    determinizeHiddenZones(b, 'p1', 'p2', lcg());
    expect(a.ctx.zones.private.zoneCards['deck:p2']).toEqual(
      b.ctx.zones.private.zoneCards['deck:p2'],
    );
    const c = fakeState(source);
    determinizeHiddenZones(c, 'p1', 'p2', () => 0.999999);
    expect(a.ctx.zones.private.zoneCards['deck:p2']).not.toEqual(
      c.ctx.zones.private.zoneCards['deck:p2'],
    );
  });
});

describe('is-mcts strategy (fake simulator)', () => {
  it('replays the same ordering for the same seed and state', () => {
    const state = fakeState(['p2-1', 'p2-2', 'p2-3', 'p2-4', 'p2-5']);
    const run = (seed: string): string[] => {
      const factory = fakeEngineFactory();
      const strategy = isMctsStrategy(fakeBase(['a', 'b', 'c']), {
        seed,
        iterations: 12,
        createEngine: factory,
      });
      return strategy
        .summarizeCandidates(fakeContext(state), fakeCandidates)
        .map((s) => s.candidate.cardId!);
    };
    expect(run('seed-1')).toEqual(run('seed-1'));
  });

  it('usually re-orders for a different seed', () => {
    const state = fakeState([
      'p2-1',
      'p2-2',
      'p2-3',
      'p2-4',
      'p2-5',
      'p2-6',
      'p2-7',
    ]);
    const run = (seed: string): string[] => {
      const factory = fakeEngineFactory();
      const strategy = isMctsStrategy(fakeBase(['a', 'b', 'c']), {
        seed,
        iterations: 12,
        createEngine: factory,
      });
      return strategy
        .summarizeCandidates(fakeContext(state), fakeCandidates)
        .map((s) => s.candidate.cardId!);
    };
    const seeds = ['s1', 's2', 's3', 's4', 's5'].map(run);
    expect(new Set(seeds.map((order) => order.join(','))).size).toBeGreaterThan(
      1,
    );
  });

  it('keeps the base ordering for forced or terminal decisions', () => {
    const factory = fakeEngineFactory();
    // single candidate → no search
    const single = isMctsStrategy(fakeBase(['only']), {
      seed: 's',
      iterations: 5,
      createEngine: factory,
    }).summarizeCandidates(fakeContext(fakeState(['p2-1'])), [
      { family: 'playCard', cardId: 'only' },
    ]);
    expect(single.map((s) => s.candidate.cardId)).toEqual(['only']);
    // terminal board → no search
    const terminal = isMctsStrategy(fakeBase(['a', 'b', 'c']), {
      seed: 's',
      iterations: 5,
      createEngine: factory,
    }).summarizeCandidates(
      {
        ...fakeContext(fakeState([])),
        board: { winner: 'p1', players: { p1: { lore: 20 }, p2: { lore: 0 } } },
      },
      fakeCandidates,
    );
    expect(terminal.map((s) => s.candidate.cardId)).toEqual(['a', 'b', 'c']);
  });
});

describe('is-mcts full game (real engine)', () => {
  it('completes a game without exceeding MAX_ACTIONS', async () => {
    const cards = loadCards();
    const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
    const { createRecordCardCatalog } = await import(
      '@tcg/shared/cards/catalog'
    );
    const { deterministicCardsMaps } = await import('./play');
    const { prepareDeck } = await import('./deck-io');
    const catalog = await loadEngineCatalog();
    const cardMap = buildCardMap({
      cards,
      alias,
      canonicalByGroup,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const fixtureA = prepareDeck(
      resolve(import.meta.dirname, 'fixtures', 'deck-a.txt'),
      cards,
      alias,
    );
    const fixtureB = prepareDeck(
      resolve(import.meta.dirname, 'fixtures', 'deck-b.txt'),
      cards,
      alias,
    );
    const toEngine = (deck: Record<string, number>): Record<string, number> =>
      Object.fromEntries(
        Object.entries(deck).map(([identity, count]) => [
          cardMap.byIdentity[identity]!.engineId,
          count,
        ]),
      );
    const cardsMaps = deterministicCardsMaps(
      [
        { owner: 'p1', cards: toEngine(fixtureA.cards) },
        { owner: 'p2', cards: toEngine(fixtureB.cards) },
      ],
      catalog.byId,
    );
    const base = strategyById(
      'best-deck-aware-lore-race',
    ) as unknown as Parameters<typeof isMctsStrategy>[0];
    const strategy = isMctsStrategy(base, {
      seed: 'is-mcts-test-1',
      // tiny budget so the suite stays fast; determinism is covered above
      iterations: 2,
      maxPlayoutActions: 4,
      playoutTurns: 0,
      cardsMaps,
      cardCatalog: createRecordCardCatalog('lorcana:cards', catalog.byId),
    });
    const record = playGame({
      catalog,
      cardMap,
      deckA: fixtureA.cards,
      deckB: fixtureB.cards,
      strategyA: strategy,
      strategyB: 'best-deck-aware-lore-race',
      seed: 'is-mcts-test-1',
    });
    expect(record.actions).toBeLessThanOrEqual(MAX_ACTIONS);
    expect(record.turns).toBeGreaterThan(0);
    expect(record.strategies.p1).toBe('is-mcts(i2)');
  }, 120_000);
});

describe('gate verdict logic', () => {
  const synthetic = (wins: number, games: number): GateGame[] =>
    Array.from({ length: games }, (_, i) => ({
      pair: Math.floor(i / 2),
      seat: i % 2 === 0 ? 'p1' : 'p2',
      winner:
        i < wins ? (i % 2 === 0 ? 'p1' : 'p2') : i % 2 === 0 ? 'p2' : 'p1',
      seed: `1-${Math.floor(i / 2)}`,
    }));

  it('passes when the bootstrap CI lower bound clears 0.5', () => {
    const verdict = evaluateGate(synthetic(640, 1000), {
      iterations: 150,
      seedBase: 1,
      engineCommit: 'a'.repeat(40),
      bootstrapResamples: 2_000,
      bootstrapSeed: hashSeed('test'),
    });
    expect(verdict.wins).toBe(640);
    expect(verdict.seats.p1.games).toBe(500);
    expect(verdict.seats.p2.wins).toBe(320);
    expect(verdict.ci.low).toBeGreaterThan(0.5);
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.referee).toBe('is-mcts');
  });

  it('fails at parity and keeps the heuristic bot as referee', () => {
    const verdict = evaluateGate(synthetic(500, 1000), {
      iterations: 150,
      seedBase: 1,
      engineCommit: 'a'.repeat(40),
      bootstrapResamples: 2_000,
      bootstrapSeed: hashSeed('test'),
    });
    expect(verdict.winRate).toBe(0.5);
    expect(verdict.ci.low).toBeLessThanOrEqual(0.5);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.referee).toBe('best-deck-aware-lore-race');
  });

  it('bootstraps a deterministic CI around the observed rate', () => {
    const samples = Array.from({ length: 100 }, (_, i) => (i < 65 ? 1 : 0));
    const first = bootstrapCi(samples, { resamples: 2_000, seed: 42 });
    const second = bootstrapCi(samples, { resamples: 2_000, seed: 42 });
    expect(first).toEqual(second);
    expect(first.low).toBeGreaterThan(0.5);
    expect(first.high).toBeLessThan(0.8);
  });

  it('balances panel deck pairs deterministically', () => {
    expect(pairSetup(0, 16)).toEqual({ a: 0, b: 3 });
    expect(pairSetup(0, 16)).toEqual(pairSetup(0, 16));
    const { a, b } = pairSetup(1, 16);
    expect(a).not.toBe(b);
  });
});

describe('gate resume: orphaned part sweep (task 2.2)', () => {
  const config = {
    commit8: 'deadbeef',
    iterations: 150,
    games: 8,
    seedBase: 7,
  };
  const game = (
    pair: number,
    seat: 'p1' | 'p2',
    winner: string | null,
  ): GateGame => ({
    pair,
    seat,
    winner,
    seed: `7-${pair}`,
  });
  const writeJsonl = (path: string, lines: string[]): void => {
    writeFileSync(path, `${lines.join('\n')}\n`);
  };

  it('merges orphaned parts into their config caches, dedupes, and deletes the swept dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'is-mcts-gate-resume-'));
    try {
      const cachePath = join(dir, gateCacheName(config));
      writeJsonl(
        cachePath,
        [
          game(0, 'p1', 'p1'),
          game(0, 'p2', 'p2'),
          game(1, 'p1', 'p1'),
          game(1, 'p2', 'p1'),
        ].map((g) => JSON.stringify(g)),
      );

      // orphan from a killed run: pairs 2–3 complete, one corrupt line and
      // one duplicate line that must not survive the merge
      const partsDir = join(dir, gatePartsDirName(999999, config));
      mkdirSync(partsDir, { recursive: true });
      writeJsonl(join(partsDir, 'gate-0.jsonl'), [
        JSON.stringify(game(2, 'p1', 'p1')),
        'not-json',
        JSON.stringify(game(2, 'p1', 'p1')),
        JSON.stringify(game(2, 'p2', 'p1')),
        JSON.stringify(game(3, 'p1', 'p2')),
        JSON.stringify(game(3, 'p2', 'p2')),
      ]);
      // a second config's orphan merges into its own cache, not this run's
      const other = {
        commit8: 'deadbeef',
        iterations: 200,
        games: 4,
        seedBase: 7,
      };
      const otherDir = join(dir, gatePartsDirName(999998, other));
      mkdirSync(otherDir, { recursive: true });
      writeJsonl(join(otherDir, 'gate-1.jsonl'), [
        JSON.stringify(game(0, 'p1', 'p2')),
        JSON.stringify(game(0, 'p2', 'p2')),
      ]);

      const sweep = sweepOrphanedGateParts(dir, {
        isProcessAlive: () => false,
      });
      expect(sweep.sweptDirs).toBe(2);
      expect(sweep.mergedGames).toBe(6);
      expect(existsSync(partsDir)).toBe(false);
      expect(existsSync(otherDir)).toBe(false);

      const merged = readGateCacheLines(cachePath);
      // the merged cache passes the pre-existing ≥-lines hit rule
      expect(merged.length).toBeGreaterThanOrEqual(config.games);
      const keys = merged.map((g) => `${g.pair}:${g.seat}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(
        merged
          .filter((g) => g.pair === 2)
          .map((g) => g.seat)
          .sort(),
      ).toEqual(['p1', 'p2']);
      // finished pairs replay nothing
      expect(remainingPairs(merged, 4)).toEqual([]);
      expect(readGateCacheLines(join(dir, gateCacheName(other)))).toHaveLength(
        2,
      );
      // re-merging the same games is a no-op
      expect(mergeGateGames(merged, merged)).toEqual(merged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never sweeps live processes; partial caches resume pair-wise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'is-mcts-gate-resume-live-'));
    try {
      const partsDir = join(dir, gatePartsDirName(424242, config));
      mkdirSync(partsDir, { recursive: true });
      writeJsonl(join(partsDir, 'gate-0.jsonl'), [
        JSON.stringify(game(2, 'p1', 'p1')),
      ]);

      const sweep = sweepOrphanedGateParts(dir, { isProcessAlive: () => true });
      expect(sweep.sweptDirs).toBe(0);
      expect(existsSync(partsDir)).toBe(true);

      // partial cache: only pair 0 finished of 4 — pairs 1..3 must simulate
      const cachePath = join(dir, gateCacheName(config));
      writeJsonl(cachePath, [
        JSON.stringify(game(0, 'p1', 'p1')),
        JSON.stringify(game(0, 'p2', 'p1')),
      ]);
      const partial = readGateCacheLines(cachePath);
      expect(remainingPairs(partial, 4)).toEqual([1, 2, 3]);
      // a pair with only one seat cached is not finished
      const halfPair = [
        game(0, 'p1', 'p1'),
        game(0, 'p2', 'p1'),
        game(1, 'p1', 'p2'),
      ];
      expect(remainingPairs(halfPair, 3)).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
