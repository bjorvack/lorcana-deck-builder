# Proposal: cache-engine-winrate

## Why

The engine-verified winrate takes ~65–75 s of background simulation per deck. Revisiting the same deck (page reload, navigation away and back) re-runs the identical 64 games — the result is deterministic per deck, so it can be cached and reused verbatim.

## What Changes

- **localStorage cache for completed estimates** (`src/stats/winrate-cache.ts`): keyed by (deck signature, engine commit, opponent pool, game budget) — any change to those re-triggers the simulation honestly. LRU-capped at 8 entries (per-game logs make a single estimate ~100 KB and the origin quota must not fill), best-effort (quota/corruption/private-mode degrade to "no cache" and the estimator runs).
- The estimator checks the cache before simulating and saves on completion; a cached hit sets `cached: true` on the estimate and the panel labels it "(cached)".
- The 8.5 MB engine bundle is never loaded on a cache hit.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `deck-statistics` — the simulated winrate requirement gains the cache: a completed estimate SHALL be cached per (deck, engine, opponents, budget) and reused on subsequent loads; corruption/quota loss degrades to re-simulation.

## Impact

- `src/stats/winrate-cache.ts` (new), `src/stats/engine-winrate.ts` (cache check + save), `src/ui/EngineWinrateSection.tsx` ("(cached)" label), tests.
