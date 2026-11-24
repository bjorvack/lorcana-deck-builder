# Tasks

## 1. Parallel estimator

- [x] 1.1 Partition the schedule across 2–4 module workers (hardware-aware `workerCount()`, round-robin slices, schedule-index-tagged tasks); re-assemble completed summaries in schedule order; unit tests: worker-count bounds, partition coverage, identical aggregate + ordering vs a sequential run (the spec's parallel-vs-sequential scenario)

## 2. Live display

- [x] 2.1 Stream per-game summaries to the panel (`onGame`); render the current winrate tally ("Current: X% (W of G games)") and the progressive completed-games list with expandable logs while the run is in progress; tests: tally updates per game, rows appear progressively and stay schedule-ordered, cancellation clears everything

## 3. Checks

- [x] 3.1 Full checks: `npm run typecheck && npm run lint && npm test` clean; `npm run build` (worker chunks)

## Workflow follow-up

- Orchestrator: commit on `feature/engine-winrate`, PR, CI, merge.
