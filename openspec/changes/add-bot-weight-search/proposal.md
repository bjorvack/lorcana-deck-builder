# Proposal

## Why

The roadmap's M3: improve the evaluator itself before trusting it with more
decisions. The shipped strategies are fixed heuristics; their candidate
ordering is the single lever the automation planner consumes. A tunable
strategy that re-ranks the shipped ordering by a weight vector gives us
stage-A self-improvement with zero ML infrastructure: hill-climb the weights
in the arena, gate on head-to-head wins vs the shipped bot.

This also matters downstream: the synergy A/B verdict showed blends fail when
the evaluator cannot exploit what the signal encodes — a stronger,
search-improved evaluator is the prerequisite for re-testing the synergy
blend and for any self-play deck discovery.

## What Changes

- New `scripts/training/arena/tunable-strategy.ts`: a delegating strategy —
  base ordering from the shipped `best-deck-aware-lore-race` strategy, re-ranked
  by a genome of interpretable feature weights (base-order respect, family
  biases for play/quest/challenge/ink, cost, lore, inkability, challenge kill
  potential, lore denial, tempo). A neutral genome (base=1, rest=0) reproduces
  the shipped bot exactly.
- New `scripts/training/arena/weight-search.ts`: seeded hill-climbing search
  (gaussian mutants, fitness = win rate vs the shipped strategy over the deck
  panel, mutants parallelized as child processes), ending with a fresh
  head-to-head gate run and a CI verdict; results written to
  `data/arena/weight-search/`.
- No app changes: this is training-side only.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

(none)

## Impact

- `scripts/training/arena/{tunable-strategy,weight-search}.ts` + tests.
- `scripts/training/data/arena/weight-search/`: search results (committed —
  small JSON).
- ROADMAP M3 status.
