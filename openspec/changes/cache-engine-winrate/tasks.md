# Tasks

## 1. Cache module

- [ ] 1.1 Implement `src/stats/winrate-cache.ts` (key builder, load/save with version + LRU cap 8, clear) + `winrate-cache.test.ts` (round-trip, deterministic keys, invalidation on any key input, LRU eviction order, corruption → null, quota → silent skip)

## 2. Integration

- [ ] 2.1 Wire the cache into `estimateEngineWinrate` (check after the opponents load, before the bundle import; save on completion; `cached` flag on the estimate) + tests: hit → no games played and no bundle load, miss → run + save, deck change → different key, opponents re-export → different key

## 3. Panel

- [ ] 3.1 Label a cache-served estimate "(cached)" in `EngineWinrateSection` + test

## 4. Checks

- [ ] 4.1 Full checks: `npm run typecheck && npm run lint && npm test` clean

## Workflow follow-up

- Orchestrator: commit on a branch, PR, CI, merge, archive.
