# Tasks

- [x] Trace capture in `play.ts` (`--trace` via batch.ts) — ranked candidates,
      executed choice, turn + lore context
- [x] Shared feature extraction (`candidate-features.ts`)
- [x] Outcome-supervised logistic trainer (`ranker.ts`, deterministic)
- [x] Learned strategy (`learned-strategy.ts`)
- [x] Head-to-head gate (`rank-gate.ts`, parallel, CI rule)
- [x] Trace corpus + training + gate run with recorded verdict
- [x] ROADMAP M4 status

## Verdict (2026-11-21)

**FAIL — no improvement over the shipped bot.** 1,200 traced games →
57,766 decisions / 404k examples; loss 0.639. Head-to-head (128 games,
parallel): learned 0.484 vs shipped, CI [0.40, 0.57]. The 16-feature linear
model cannot out-rank the deck-aware heuristic — consistent with the M3
ceiling. Remaining paths (richer features, non-linear model,
advantage-weighted objectives) are recorded in ROADMAP M4; all behind the
same gate.
