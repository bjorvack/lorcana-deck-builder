# Design

## Level change: selection over decks, not moves

The failed per-move learners (weight search, learned ranker) hit a ceiling:
the fixed evaluator cannot be out-predicted move-by-move. Evolution changes
the optimization level — **whole decks are the genome, arena win rate is the
fitness** — so improvement comes from selection pressure, not from predicting
the evaluator's choices. This is the best-practice approach for deck
optimization with a deterministic simulator.

## Population and mutation

- Population 24: seeded from the meta panel (top win-rate decks) plus
  synergy-mutated copies.
- Mutations (legality-preserving, checked against 60-card / 2-ink / copy-limit /
  mapped-identity constraints; illegal mutants discarded):
  - **random swap** — replace 1–3 copies of a random identity with legal
    random replacements sharing a deck ink;
  - **synergy swap** — drop the identity with the lowest trained partner
    affinity to the rest of the deck; add the best legal trained partner of
    the deck's most-connected card;
  - **count adjust** — push a core card toward its copy limit, trim another.

## Fitness and the generalization gate

- **Fitness (selection)**: win rate vs anchor set A — the 8 highest-win-rate
  original panel decks, 16 seat-balanced games per candidate. Deterministic
  per (deck signature, generation, seed).
- **Gate (ship decision)**: the final top-4 evolved decks vs anchor set B —
  the 8 panel decks NOT used for fitness. PASS = mean evolved win rate over
  those 256 fresh-seed games has CI low > 0.5. Training anchors and gate
  anchors are disjoint, so "beating the meta" must generalize beyond the
  opponents the evolution optimized against — the exact discipline the
  weight-search verdict taught us (in-loop selection needs out-of-loop
  validation).

## Records

`data/arena/evolution/<hash>/result.json`: fitness history per generation,
final population with deck text, gate verdict, and mutation provenance.
Evolved decks also render as plain-text deck files for inspection.
