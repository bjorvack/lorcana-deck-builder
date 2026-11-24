# Design: cache-engine-winrate

## Context

The engine-verified winrate (change engine-winrate) takes ~65–75 s per deck.
The result is deterministic per deck — the same inputs always produce the same
64 games — so a completed estimate is safely reusable.

## Goals / Non-Goals

- Goals: subsequent page loads show the cached estimate instantly (no bundle
  load, no games); bounded storage; honest invalidation.
- Non-Goals: no IndexedDB migration (localStorage suffices at the LRU cap);
  no cross-device sync; no caching of in-flight (aborted) runs.

## Decisions

- **D1 — Key = hash(deck signature, engine commit, opponents, budget).**
  fnv1a32 over the JSON of the four inputs; any change (deck edit, arena
  engine bump, opponents re-export, budget change) produces a new key and the
  simulation runs fresh — invalidation is structural, not timestamp-based.
- **D2 — Versioned payload + LRU cap.** Payload `{cacheVersion: 1, estimate}`;
  version mismatch → miss. LRU cap 8 entries (per-game logs ≈ 100 KB each);
  the index (`winrate-estimate:v1:index`) tracks recency; eviction removes the
  oldest entry's payload. Oversized payloads (> 400 KB) are not cached.
- **D3 — Best-effort everywhere.** Every localStorage access is try/catch
  guarded: private mode, quota, or corruption degrade to "no cache" and the
  estimator runs. The panel never shows a stale or partial result: only fully
  completed runs are saved.
- **D4 — Cache check inside the estimator.** `estimateEngineWinrate` checks
  after loading the opponent pool but BEFORE the bundle import — a cache hit
  never loads the 8 MB bundle. The cached estimate carries `cached: true` and
  the panel labels it "(cached)".

## Risks / Trade-offs

- [Hash collisions across decks] → fnv1a32 over the full input JSON;
  collisions would need identical 64-char signatures — practically impossible;
  the payload still stores the deck signature and the panel keys on the deck
  object.
- [Stale opponents] → the opponents JSON is part of the key: a re-export
  invalidates every cached estimate honestly.

## Open Questions

- None.
