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
