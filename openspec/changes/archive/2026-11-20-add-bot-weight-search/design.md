# Design

## The seam

The automation planner consumes strategy output as an **ordered** candidate
list — `summarizeCandidates(context, candidates)` fully controls move
preference, and each summary carries the candidate (family + card instance
ids + targets) plus the planning context (board, deck profiles, card
definitions, turn bucket). The shipped `DeckAwareStrategyConfig` is closed
(no injectable weights), so tuning means re-ranking above it, not patching it.

## Tunable strategy

`TunableStrategy.summarizeCandidates`:

1. delegate to the wrapped shipped strategy → base ordering (index = rank);
2. score each summary: `w.base · (1 − rank/N) + Σ w_i · feature_i`;
3. stable sort descending, tie-break by base rank (deterministic).

Features (normalized):

| feature | source |
|---|---|
| familyBias.playCard / quest / challenge / ink | candidate family |
| cost | card definition cost / 10 |
| lore | character lore / 3 (quest candidates) |
| inkable | definition inkable (play candidates) |
| killPotential | (attacker.strength − defender.willpower) / 5 (challenge) |
| denyLore | defender lore / 3 (challenge) |
| tempo | (my lore − opponent lore) / 20, interacted with the challenge bias |

Neutral genome (`base = 1`, all else 0) → base ordering preserved → byte-equal
behavior to the shipped bot (regression-tested). The genome is 12 floats —
interpretable, printable, serializable.

## Search

Seeded hill-climbing (`mulberry32`, Box–Muller gaussians):

- start from the neutral genome (the incumbent);
- per iteration: `mutants` gaussian perturbations (σ = 0.25), each evaluated
  by playing `gamesPerEval` games vs the shipped strategy over the panel
  (seeded panel pairs, seat-balanced);
- mutants evaluate in parallel child processes (seed-split per seed, like
  batch.ts/ab.ts — each child handles its own seed slice);
- keep the best; final gate: best genome vs shipped with a fresh seed range
  and CI (PASS = CI low > 0).

Fitness determinism: same genome + seed base → identical win count (the
strategy is a pure function; games are seeded).

## Gate and records

Results land in `scripts/training/data/arena/weight-search/<hash>/result.json`:
best genome, fitness history, gate stats, and the search config. The gate
verdict follows the pre-committed rule: ship the tuned genome only if it beats
the shipped strategy with CI low > 0; otherwise record the negative result and
keep the shipped strategy as the evaluator (the search itself is the
deliverable — it is the harness for all later self-improvement stages).

## Budget

Default CLI: 8 iterations × 6 mutants × 24 games/eval (~1,150 games ≈ 10–20
min locally with 6 workers) + a 128-game gate. `--iterations/--mutants/
--games-per-eval` scale it; a reduced budget (4/4/24) fits a single e2e run.
