# Tasks

## 1. Client parsing — done

- [x] 1.1 `src/meta/infer.ts`: `InteractionPartners` type + validated parsing
      (per-field degradation); interactions-only artifacts accepted; old
      artifacts unchanged.

## 2. Scoring — done

- [x] 2.1 `src/meta/score.ts`: `partners` on `ScoringContext`;
      `deckIdentityIds`, `deckSynergyEdges`, `synergyScore` (both evidence
      directions, normalized 0–1).
- [x] 2.2 `src/generate/suggest-fill.ts`: 0.25 synergy share blended into the
      similarity portion before curve pressure; absent capability → identical
      scores (regression-tested); both fill and D7-replacement loops thread
      the per-iteration identity/edge sets.

## 3. Tests — done

- [x] 3.1 Parser: valid payload, corrupt tuple → degrade, interactions-only
      artifact accepted.
- [x] 3.2 Synergy lookup: both directions, normalization, absent capability.
- [x] 3.3 suggest-fill: partnered candidate preferred when completing a deck
      around its anchor; absent-capability invariance.

## 4. A/B gate — done (verdict: blend ships OFF)

- [x] 4.1 `arena/ab.ts`: matched-variant generation + seat-balanced panel
      matchups + Wilson/normal-approximation reporting (aggregation unit
      tested); parallel seed-split workers (~2–4 min per run);
      `--synergy-weight` makes the blend share an A/B input.
- [x] 4.2 Verdicts (512 games/variant vs the meta panel):
  - novelty 0.5, weight 0.25: synergy 0.563 vs baseline 0.604 → uplift
    −0.041, CI [−0.101, +0.019] → **no benefit**.
  - novelty 0.5, weight 0.1: −0.041 again (tally equality with the 0.25 run
    is an ~8% coincidence; a sensitivity probe confirmed the weights produce
    different decks and 8/64 outcome flips).
  - novelty 1.0, weight 0.25: −0.006 (CI spans zero) — at full exploration
    the playrate inversion dominates and meta-derived partner evidence rarely
    applies, as expected.
  - Sensitivity probe: 0.25 vs 0.1 decks flip only 8/64 game outcomes and
    win 28 vs 26 — no weight in [0.1, 0.25] helps.
- [x] 4.3 Decision (pre-committed rule): **`SYNERGY_WEIGHT` default 0** — the
  blend ships off. Mechanism: pair lift from tournament co-occurrence
  reflects human-exploited synergies that the fixed heuristic bots cannot
  play out, so blending displaces curve/consistency picks without payoff.
  The capability, parser, lookup and A/B harness all ship; blending is
  opt-in via `SuggestFillOptions.synergyWeight` for experiments. Revisit
  when a synergy-aware evaluator exists (M4 learned ranker).

## 5. Docs

- [x] 5.1 ROADMAP M2 status (generator synergy infrastructure shipped,
  blend default-off with the A/B evidence; M4 is the revisit point).
- [x] 5.2 `vendor/effect-probe.ts`: move-log diagnostic (playCard / ink /
  challenge / resolveBag all fire in automated games).

