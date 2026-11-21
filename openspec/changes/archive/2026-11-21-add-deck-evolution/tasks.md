# Tasks

- [x] 1. `arena/evolve.ts`: population + mutation operators + fitness +
      generational loop + disjoint-anchor gate + result/deck output.
- [x] 2. Vitest: mutation legality preservation, synergy-swap targeting,
      anchor split (fitness vs gate anchors disjoint), aggregation.
- [x] 3. Real e2e: 6 generations × 24 decks × 16 games (2,304 games + 64-game
      gate), 0 incomplete.
- [x] 4. ROADMAP: evolution verdict + meta-convergence status.

## Verdict (2026-11-21)

**PASS — the first positive training result.** Final top-4 evolved decks vs
held-out anchors (never trained against): 52/64 = 0.813, CI [0.70, 0.889].
Fitness means climbed 0.43 → 0.79 across 6 generations. The best deck
descends from panel-13 through 5 mutation generations and rebalances toward
underused panel cards (e.g. id 2026 at 4 copies vs 28 panel uses; 2011 at 4
vs 13) — selection pressure found a stronger composition without inventing
cards. Caveat recorded: the anchors are all bot-played meta decks; evolved
decks are validated for the bot-vs-bot arena, not (yet) human tournaments —
the TopDeck calibration anchor still governs real-world claims.

## Scaled run (2026-11-21, seed 424242)

10 generations x 40 decks (12 generator-seeded novelty decks added to the
panel-derived population) x 16 games: fitness means climbed 0.46 -> 0.84;
gate = top-4 vs held-out anchors: 56/64 = 0.875, CI [0.772, 0.935] -> PASS
(stronger than the v1 run's 0.813). Best deck descends from panel-01 through
9 mutation generations and shifts copies away from the most common panel
cards (id 2026: 4 copies vs 28 panel uses; 2379: 4 vs 3 uses). Caveats
unchanged: bot-vs-bot validation on 16 meta decks; generator-seeded decks
widened the search though selection still converged on panel-derived
compositions.
