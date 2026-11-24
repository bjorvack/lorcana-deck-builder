# Proposal: parallel-engine-winrate

## Why

The engine-verified winrate runs 64 games sequentially in a single worker (~65–75 s). The games are statistically independent — each game's seed comes from the schedule, a pure function of the deck signature — so the schedule can be split across multiple workers without changing any result. Users also shouldn't wait for the full run to see signal: the running tally (current winrate) and the list of completed games are informative while the simulation is in progress.

## What Changes

- **Parallel workers (2–4, hardware-aware)**: the 64-game schedule is partitioned across K module workers (K = clamp(2, 4, hardwareConcurrency − 2), fallback 2) — wall time drops to ~65/K seconds. Determinism is preserved exactly: per-game seeds are schedule-ordered and independent; results are re-assembled in schedule order.
- **Live current winrate**: while the run is in progress, the section shows the running tally — "Current: 62% (8 of 13 games)" — updating per finished game.
- **Progressive game list**: the per-game rows (win/loss, opponent, seat, turns, expandable log) appear as games complete, not only after the run.
- The estimator's public API shape is unchanged; the panel's cancellation/loader behavior is unchanged.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `deck-statistics` — the simulated winrate requirement gains: parallel worker execution (2–4, hardware-aware, results identical to sequential), a live current-winrate display during the run, and a progressive completed-games list.

## Impact

- `src/stats/engine-winrate.ts` (schedule partition + multi-worker spawn + ordered aggregation), `src/ui/EngineWinrateSection.tsx` (live tally + progressive list), tests.
- No spec-level determinism/cancellation changes; no model or bundle changes.
