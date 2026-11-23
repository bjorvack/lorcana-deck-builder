# Tasks

## 1. Engine coverage audit

- [x] 1.1 Extend `scripts/training/arena/map.ts` to emit a per-card coverage status (fully scripted / partially scripted / unmapped) into `public/data/report.json`; verify with `npm run arena:map` that sample cards carry the new status field
- [x] 1.2 Add a self-play pool builder that excludes unmapped cards and fails the run when legal-pool coverage is below a configured threshold; verify with a unit test on a synthetic mapping (exclusion count + non-zero exit below threshold)
- [x] 1.3 Report how often partially scripted cards appear in generated decks; verify with a unit test computing the rate on a fixture deck list

## 2. IS-MCTS evaluator

- [x] 2.1 Implement IS-MCTS in `scripts/training/arena/` (determinization of opponent hand and deck order from a `mulberry32` stream, heuristic bot as rollout policy, configurable iteration budget, default 150); verify with a unit test that the same seed replays the same move and a smoke game completes
- [x] 2.2 Build the gate harness: paired-seed games vs the shipped heuristic bot from both seats, parallel via the `batch.ts` child-process pattern, bootstrap CI on the win rate; verify `npx tsx` harness runs ≥1,000 games and prints the CI
- [x] 2.3 Wire the gate verdict: evaluator becomes referee only when the 95% CI lower bound > 0.5; failed verdict recorded in the run report and `ROADMAP.md`; verify both the pass and fail paths in tests

## 3. League evaluation

- [x] 3.1 Create the league store and seeding: held-out real tournament decks (opponents only, never training targets) plus random-legal and smart-generator baselines; verify a seed run produces the league file and a test proves no candidate derives from held-out decks
- [x] 3.2 Implement scoring: meta-weighted win rate W_i = Σ W_ij·P(j) with bootstrap CI, paired-seed + common-random-number scheduling, and SPRT sequential stopping; verify with unit tests on the weighting math and SPRT stopping on synthetic results
- [x] 3.3 Extend the arena cache so paired schedules share a seed base recorded in each record, without invalidating existing entries; verify a test that identical requests reuse cached records and an engine-commit change does not
- [x] 3.4 Promote winning decks into the league with near-duplicate pruning by card-list distance; verify with a unit test on the distance threshold using fixture decks

## 4. MAP-Elites deck search

- [x] 4.1 Implement the archive with behaviour descriptors (average cost, inkable ratio, character/action/item mix, lore-per-turn proxy); verify with a unit test computing descriptors for fixture decks
- [x] 4.2 Implement mutation operators (swap one or a few cards) validated through `src/rules` so archived decks are legal by construction; verify with a property-style test that 100 mutations all pass full validation
- [x] 4.3 Wire the search loop (evaluate against league → place in cell → replace elite when fitter) with `batch.ts`-style parallelism; verify a small run (2 generations, population 8) completes and writes the archive
- [x] 4.4 Prove determinism: same seeds + engine commit produce a byte-identical archive; verify with an automated repeat-run diff test

## 5. Reporting and acceptance

- [x] 5.1 Write `public/data/selfplay.report.json` (engine pin, seeds, coverage numbers, league composition, archive statistics, all gate verdicts with bootstrap CIs); verify the committed file against a schema check after a full run
- [x] 5.2 Run the acceptance gate: self-play decks vs held-out real decks must have a 95% CI excluding 0.5 to be SHIPPED; a NOT SHIPPED verdict is recorded in the report and `ROADMAP.md`; verify the verdict field logic in tests and the recorded outcome in the report
- [x] 5.3 Full program checks pass: `npm run typecheck && npm run lint && npm test` clean

## Workflow follow-up

- Record the final gate verdicts in `ROADMAP.md` and commit `selfplay.report.json`.
- Archive via `npx openspec archive self-play-league --yes` once implementation is done.
- Phase 5 (learned generator on the archive, wired into smart mode) is a follow-up change.
