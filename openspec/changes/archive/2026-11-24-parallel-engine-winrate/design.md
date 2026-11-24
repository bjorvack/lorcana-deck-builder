# Design: parallel-engine-winrate

## Context

The engine-verified winrate (change engine-winrate, merged) plays 64 games
sequentially in a single module worker (~65–75 s). The games are statistically
independent: `scheduleGames(seedBase)` produces per-game seeds as a pure
function of the deck signature, and no game shares state with another. See
proposal.md for motivation.

## Goals / Non-Goals

- Goals: wall time ÷ worker count; live current-winrate tally; progressive
  completed-games list. Bit-identical results regardless of worker count.
- Non-Goals: no changes to the game schedule, seeds, bundle, opponent
  selection, Wilson CI, or the meta-model independence. No shared statistics
  across games (RAVE-style) — that would break the independence property the
  determinism guarantee rests on.

## Decisions

- **D1 — Schedule partition, results re-assembled in order.** Tasks carry
  their schedule index; workers get round-robin slices; completed summaries
  are collected into a schedule-indexed map and emitted in schedule order.
  The aggregate (`aggregateResults`) is unchanged.
- **D2 — Worker count: `clamp(2, 4, hardwareConcurrency − 2)`, fallback 2.**
  Memory per worker is the binding constraint (each parses the 8.5 MB bundle);
  4 is the ceiling. `Worker`-less environments and injected `playGame` (tests)
  keep the sequential main-thread path.
- **D3 — Per-game streaming.** The estimator gains `onGame(summary)`;
  `onProgress` (completed/total) stays. The panel appends rows and recomputes
  the running tally per game — no waiting for `done`.
- **D4 — Cancellation terminates all workers.** The run token terminates
  every worker; partial results are discarded (unchanged guarantee).

## Risks / Trade-offs

- [K × bundle parse + heap] → capped at 4 workers; desktop-class hardware
  target, mobile degrades to 2.
- [Out-of-order completion] → schedule-index re-assembly keeps the review
  disclosure ordered; tests pin the ordering.
- [Main-thread contention] → workers are off-thread; the page's main thread
  only renders.

## Open Questions

- None.
