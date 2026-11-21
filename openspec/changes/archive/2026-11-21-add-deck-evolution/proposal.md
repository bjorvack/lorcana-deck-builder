# Proposal

## Why

The roadmap's remaining promise: use the arena to make deck generation
*actually better*, not just different. Tournament data only evidences meta
decks; the arena can measure any deck — so deck-level evolution (generate →
play → select → mutate) can discover and validate decks beyond the meta,
directly attacking the meta-convergence problem recorded in the ROADMAP.

The failed experiments (synergy blend, weight search, learned ranker) all
shared a ceiling: the fixed evaluator cannot be out-learned per-move. Deck
evolution changes the level of the optimization: selection pressure over
whole decks needs no move-level insight — a deck that wins under the fixed
evaluator is a better deck *for that evaluator*, and the head-to-head gate
against the original panel decides whether that translates.

## What Changes

- New `scripts/training/arena/evolve.ts`: an evolutionary deck optimizer —
  population seeded from the meta panel, mutation operators guided by the
  trained interactions table (synergy swaps) plus legality-preserving random
  swaps/count adjustments, fitness = arena win rate vs an anchor subset of
  the original panel, generational selection with elites.
- Fresh-seed head-to-head gate: the final evolved top decks vs the original
  panel decks (CI rule, pre-committed: PASS = CI low > 0.5).
- Results (fitness history, best decks, verdict) in
  `scripts/training/data/arena/evolution/`.
- No app changes in this change; evolved decks are training-side artifacts
  (shipping them as product features is a follow-up).

## Capabilities

(none — training-side only)

## Impact

- `scripts/training/arena/evolve.ts` + tests.
- `scripts/training/data/arena/evolution/`: generation reports + final decks.
- ROADMAP: evolution verdict; meta-convergence status update.
