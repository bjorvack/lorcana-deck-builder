# Tasks

## 1. Tunable strategy

- [ ] 1.1 `arena/tunable-strategy.ts`: delegating re-ranker implementing the
      engine's `AutomatedActionStrategy` — base ordering, genome features,
      deterministic stable sort.
- [ ] 1.2 Genome codec: named dimensions, serialize/parse, neutral genome.
- [ ] 1.3 Vitest: neutral genome preserves the wrapped strategy's ordering;
      family bias reorders; determinism.

## 2. Search runner

- [ ] 2.1 `arena/weight-search.ts`: seeded hill-climb (gaussian mutants),
      fitness vs the shipped strategy over the panel, parallel mutant
      evaluation via child processes, fresh-seed head-to-head gate with CI,
      result JSON.
- [ ] 2.2 Vitest: fitness aggregation, mutation determinism, report shape.

## 3. Real run + verdict — done (verdict: shipped strategy stays)

- [x] 3.1 Reduced-budget search (4 iterations × 4 mutants × 24 games/eval):
  - incumbent (shipped ordering): 12/24;
  - fitness climbed 15 → 16 → 19 of 24 across iterations;
  - **fresh-seed gate: tuned 33/64 = 0.516, CI [0.396, 0.634] → FAIL** —
    statistically indistinguishable from the shipped bot.
- [x] 3.2 Diagnosis recorded: the fitness climb was **selection bias over
  evaluation seeds** (best-of-16 on 24-game samples inflates by ~1 noise σ;
  the fresh-seed gate correctly refused it). Lessons for future stages:
  fitness samples must be larger than the selection noise floor, and
  best-of-N selection needs a fresh-seed re-validation inside the loop, not
  only at the gate. The search harness itself is the deliverable — it is the
  machinery every later self-improvement stage (and the synergy re-test)
  runs through.
- [x] 3.3 ROADMAP M3 status updated.
