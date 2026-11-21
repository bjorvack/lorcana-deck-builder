# Design

## Trace capture

With `playGame({ trace: true })`, each planner decision appends to the
record's `moves`: the turn, the actor, per-seat lore, the planner's ranked
candidates (family + engine card refs), and the executed candidate's index
(matched by reference against the planner's ordered list, field-compare
fallback). Traces flow through `batch.ts --trace` into JSONL records.

## Features

`candidate-features.ts` — 16 dims: family one-hots (8), card stats
(cost/10, lore/3, strength/5, willpower/5, inkable, isCharacter), turn/20,
lore differential /20. One implementation used by the trainer (resolving
engine card refs through our catalog via the arena card map) and the runtime
strategy (resolving through the engine's `getCardDefinition`) — weights
transfer exactly.

## Training

Outcome-supervised logistic regression: each traced decision contributes the
executed candidate as the positive example and the considered alternatives as
negatives; when the acting player's deck LOST, labels invert. Full-batch
gradient descent (400 iterations, lr 0.5, L2 1e-4) — deterministic, no
randomness. This is outcome-tilted imitation: learn what winners pick and
losers should have avoided.

## Gate

`rank-gate.ts`: learned strategy vs the shipped bot over the panel, parallel
child workers, seat-balanced by parity. PASS = win-rate CI low > 0.5. The
verdict is recorded either way — this closes the M4 question "can
outcome-supervised linear ranking beat the shipped heuristic" that the M3
negative result left open.
