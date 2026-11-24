# Tasks

## 1. Estimator

- [x] 1.1 Implement `src/stats/winrate-estimate.ts`: chunked cancellable race-batch runner around `simulateRace` (5 × 400 trials, per-chunk mulberry32 seeds derived from the deck-signature hash, run-token cancellation, macrotask yields between chunks, Wilson CI helper) + `winrate-estimate.test.ts` (determinism per deck, chunk-equivalence vs a single 2,000-trial run, cancellation discards results, Wilson CI math)

## 2. Display

- [x] 2.1 Replace the "Meta fit" viability block in `src/ui/AnalysisPanel.tsx` with the "Winrate" section (async effect keyed by deck signature, run-token cancellation, Wilson CI + trials + opponent profile shown; archetype match line kept; remove `metaAdjustedViability` usage and its now-dead tests) + tests: renders estimate after completion, never renders an abandoned run's result, archetype line unchanged, works without meta model
- [x] 2.2 Full checks: `npm run typecheck && npm run lint && npm test` clean; verify `src/ui` coverage thresholds still hold

## Workflow follow-up

- Orchestrator: commit on `feature/deck-winrate-probability`, PR, CI, merge.
