# Training AI Roadmap

Offline training components (`scripts/training/`). Everything here runs locally
and offline — the shipped app stays deterministic and API-free (see
`openspec/specs/meta-model`). Like `train.ts`, each AI publishes only behind
its own gate; failing gates omit the capability from the artifact.

The **arena** (M1) is the shared validator underneath everything below: a
headless AI-vs-AI match runner on the vendored
[TheCardGoat `tcg-engines`](https://github.com/TheCardGoat/tcg-engines) (MIT)
Lorcana engine. Spike-verified on this machine (2026-11-20, upstream pin
`6de59de1`): ~4 games/s single-threaded under Node + tsx, fully deterministic
once card instance ids are keyed deterministically, 0 execution errors across
20 full games.

## Components

| Component | Role | Status |
|---|---|---|
| Goldfish (`src/stats/goldfish.ts`) | Deterministic lore-race vs scripted baselines; ships in-app | Shipped |
| Arena (`scripts/training/arena/`) | Headless AI-vs-AI evaluation; JSONL game logs + matchup win rates | M1 |
| Interaction miner | Card-pair synergy from arena logs + tournament decks (TopDeck, dotGG) | M2 |
| Inductive card encoder | Content → embedding model ("card shape") so brand-new cards suggest correctly before any observations exist | M2 |
| Generator AI | Synergy-aware candidate scoring for generate / suggest-fill | M2 (infrastructure shipped; blend default-off — A/B verdict below) |
| Bot: weight search | Tune shipped deck-aware strategy weights via tournaments | M3 (harness shipped; verdict below) |
| Bot: learned ranker | Custom engine strategy backed by a trained move-scoring model | M4 (v1/v2 shipped; FAIL verdict — see M4 section) |
| Bot: RL policy | Policy-gradient over the engine-validated candidate space | M5 (exploratory) |

## Milestones and gates

### M1 — Arena (validator foundation)
Goal: a trustworthy, reproducible evaluation surface.

- Vendor the engine (pinned commit, minimal subset: lorcana-engine,
  lorcana-types, lorcana-cards data, bot-core/shared deps).
- Card-ID mapping: our lorcanajson catalog ↔ engine canonical IDs —
  **functionality-level identity** (`canonicalAlias()`: reprints/rarities/
  promos collapse to one entry; Quest variants stay distinct), `set{code}-
  {number}` join on the canonical print with lorcast external-ID fallback;
  mapping coverage reported alongside the data validation report.
- Headless runner: two automated seats (`takeAutomatedActionForCurrentActor`
  loop with `getCurrentActorId`), selectable per-seat strategy, seeded,
  deterministic instance-id keying (spike finding — required), termination via
  board winner / deadlock-concede.
- Batch CLI: N games per matchup → JSONL game records in
  `scripts/training/data/arena/`, cached per (deckA, deckB, seeds, strategy
  pair, engine version).
- Exit criteria: deterministic replay test green; ~4 games/s single-threaded
  (measured); core-set mapping coverage ≥ 97% (spike-measured 86% naive join;
  misses are Epic-rarity printings awaiting an upstream bump plus
  Quest/promo key normalization).

### M2 — Better deck generation (first product goal)
Goal: the generator picks cards that work together; brand-new sets suggest
correctly before the engine (or tournaments) ever see them.

- **Interaction miner** (`synergy-capability.ts`, SHIPPED): win-rate-weighted
  pair lift with support shrinkage, temporal holdout gate (lift ratio vs
  seeded random baseline, threshold 1.1). On the 2026-11-20 corpus (12,304
  lists / 1,038 events) the gate passed at margin 3.59 — 7,041 pairs, 1,328
  per-card partner lists shipped in `meta-model.json` (artifact at 300.9 KB
  gzip of the 300 KB budget — headroom is thin; watch on growth).
  Gate: synergy-ranked pairs beat random pairs on the holdout (mirrors the
  relations coherence gate). Arena A/B validation of generator changes is the
  hand-off to `add-synergy-deck-generation`.
- **Arena panel + matchup batch** (`arena/panel.ts`, `arena/batch.ts`,
  SHIPPED): a panel of real meta decks (tournament winners, deduped,
  arena-eligible) and a deterministic round-robin batch runner — the
  evaluation surface for generator A/B gates.
- **Inductive card encoder** (the "card shape" model): map intrinsic card
  content — cost/strength/willpower/lore, ink, type, keywords, subtypes,
  franchise, parsed text — into the interaction-embedding space, trained to
  predict observed embeddings/contexts. **One vector per card identity**
  (D1 `canonical.ts`): reprints, rarities and promos inherit it; only
  functionality changes create a new identity. New cards get embeddings by
  inference from content, so the *website* generator/suggest-fill can suggest
  them on day zero, independent of engine coverage. Generator ranks by
  confidence-weighted fusion: observed embedding when it exists (tournament
  co-occurrence arrives within weeks; arena pair-lift follows engine bumps),
  content-predicted otherwise.
  Gate: temporal generalization — train on sets < N, encoder-predicted
  neighbors must match later-observed co-occurrence neighbors on set N.
- **Generator A/B** (`arena/ab.ts`, SHIPPED): matched-variant decks (same
  seeds/inks, only the scoring differs) played against the meta panel with
  seat-balanced games; PASS = positive 95% CI lower bound on the win-rate
  uplift.
- **A/B verdict (2026-11-20)**: the synergy blend FAILED the gate — 0.25 and
  0.1 shares both measured −4.1% uplift (CIs spanning zero) vs the plain
  baseline; a sensitivity probe found no weight-dependent outcome flips.
  Pair lift from tournament co-occurrence encodes human-exploited synergies
  the fixed heuristic bots cannot play out. **The blend ships off**
  (`SYNERGY_WEIGHT = 0`, opt-in via `SuggestFillOptions.synergyWeight`);
  revisit with the M4 learned ranker, whose bots could actually exploit
  synergy lines — that would also let the miner eat arena-log evidence for
  off-meta pairs, attacking the meta-convergence problem directly.
  Exploration cost (novelty 1.0 vs panel): −0.006 — off-meta generation is
  free under bot control, so the gate for exploration value is synergy
  quality, not deck strength.
- Arena sim-strength becomes a viability-profile feature; the existing
  calibration gate still decides what ships.

### M3 — Bot weight search (self-improvement, stage A)
Goal: a stronger opponent pool with zero ML infrastructure.

- **Status (2026-11-20)**: the search harness shipped
  (`arena/tunable-strategy.ts` + `arena/weight-search.ts`) — a delegating
  re-ranker over the shipped ordering with a 11-dim interpretable genome,
  hill-climbed against the shipped bot. **Verdict: the reduced-budget search
  found no real improvement** — fitness gains were selection bias over
  evaluation seeds; the fresh-seed gate read 0.516 (CI [0.396, 0.634]) and
  correctly refused to ship. Lesson recorded: fitness samples must exceed
  the selection noise floor, and best-of-N selection needs in-loop
  fresh-seed re-validation. The shipped strategy remains the evaluator;
  a full-budget search (64+ games/eval) is the next knob before concluding
  the feature set itself is exhausted.

**Bridge from M2 (exploration cost, 2026-11-20):** the A/B harness doubles as
the exploration meter — `arena/ab.ts --novelty 1` plays fully off-meta
generated decks (zero-playrate cards boosted, text-space scoring) against the
same meta panel at the same seeds. The measured uplift vs the default-novelty
run quantifies what exploration costs in win rate; that number decides when
arena-driven deck discovery (self-play fitness over diverse candidates, with
the meta panel as fixed anchor) is worth building.

### Deck evolution (meta convergence, first positive training result)

**Status (2026-11-21)**: `arena/evolve.ts` shipped — evolutionary deck
optimization with the arena as fitness: population seeded from the meta
panel, mutations guided by the trained interactions table (synergy swaps) +
legality-preserving random swaps/count adjustments, selection with elites.
**Verdict: PASS — confirmed at scale.** v1: 6 generations × 24 decks;
final top-4 beat the held-out anchor set 0.813 (CI [0.70, 0.889]); fitness
means 0.43 → 0.79. v2 (scaled, generator-seeded diversity: 10 generations ×
40 decks incl. 12 novelty-1.0 generator decks): **0.875 (CI [0.772, 0.935])**,
fitness means 0.46 → 0.84. Evolution consistently rebalances toward
underplayed panel cards (id 2026 at 4 copies vs 28 panel uses; 2379 at 4 vs
3). Caveats: validated under bot-vs-bot play on 16 meta decks (the TopDeck
calibration anchor still governs real-world claims); generator-seeded decks
widened the search but selection still converged on panel-derived
compositions. Next knobs: larger populations, generator-seeded diversity,
and evolving with the interaction miner eating evolved-deck evidence.


### M4 — Learned move ranker (self-improvement, stage B)
Goal: a custom engine strategy whose ranking is a trained model.

- **Status (2026-11-21)**: the full v1/v2 pipeline shipped — move-level trace
  capture (`play.ts --trace`), shared candidate features, outcome-supervised
  logistic trainer (`ranker.ts`: winners' choices positive, losers' choices
  anti-examples; 1,200 games → 57,766 decisions / 404k examples), learned
  strategy, head-to-head gate (`rank-gate.ts`).
- **Verdicts: v1/v2 FAIL, v3 approaches parity.** v1 (16 features): learned
  0.484 vs shipped, CI [0.40, 0.57], loss 0.639. v2 (20 features — board
  composition): 0.484 again, loss 0.623. v3 (24 features — board stat
  aggregates + advantage-weighted regression: examples weighted by
  exp(final lore margin / beta) instead of binary win/loss label flips):
  **0.527 (CI [0.466, 0.588])** at 256 gate games. **v4 (linear + interaction
crosses cost/lore/inkable × turn, 1,000-game gate): 0.506 (CI [0.475,
0.537])** — regressed to parity; the crosses added capacity but no signal.
Outcome-supervised linear ranking on bot-game features is exhausted at this
scale: capacity is not the bottleneck, the 24-feature signal and the
outcome labels are. **Hidden-layer test (M4 v5, 2026-11-22)**: a 32-unit
tanh MLP (interaction crosses in, early stopping on a game-level validation
split) gates at 0.506 (CI [0.475, 0.537]) — statistically identical to the
linear model. Architecture is confirmed not to be the constraint; the
remaining lever is the objective/data (advantage-weighted value estimation
or human-game data), not layers.
- **Remaining paths need stronger medicine**: advantage-weighted objectives
  (per-state value estimates), non-linear models, or human-game data — each
  behind the same gate, and only worth the compute alongside a decision to
  invest in M4-scale ML infrastructure. Until then the shipped deck-aware
  heuristic remains the evaluator, and the synergy blend stays off (its
  re-test requires an evaluator that can play synergies out).
- Original design notes (league training vs shipped strategies + past
  checkpoints; 10⁴-game epochs ~40 min locally) remain valid for a future
  attempt with the richer machinery above.

### M5 — RL policy (exploratory)
Only if M4 plateaus. Compute-gated; revisit when M4 data exists.

## Self-play league (issue #30)

First end-to-end loop run (smoke-then-verify budget: MAP-Elites 2 generations ×
population 6, 768 league games; acceptance top-4 elites vs the 4 held-out real
decks, 24 games per pairing, SPRT enabled, 384 games on fresh seed bases ≥
master + 50,000,000).

- **Verdict: SHIPPED** — aggregate self-play-vs-held-out-real win rate
  **0.5625** (216/384), 95% bootstrap CI **[0.5156, 0.6120]**; the CI lower
  bound beats 0.5. Per-deck win rates: 0.573 / 0.646 / 0.490 / 0.542.
- **Referee: `best-deck-aware-lore-race` (fallback)** — the IS-MCTS referee
  gate (i75, ≥1,000 paired-seed games) had produced no verdict file at run
  time (still running), so the report records it as PENDING and acceptance
  used the shipped heuristic bot with `refereeFallback: true` (design D2a).
  A SHIPPED verdict under the fallback referee is provisional until the
  IS-MCTS gate concludes; if the gate passes, the acceptance gate should be
  re-run under the IS-MCTS referee.
- **Engine commit**: `6de59de1` (league + archive + card map all in era
  6de59de1; pool coverage 2675/2785 fully-scripted identities = 0.9605).
- **Date**: 2026-11-23 (first completed end-to-end run; the loop's
  interrupted first attempt started 2026-11-22 — warm cache carried over).
- **Archive**: `scripts/training/data/arena/selfplay/archive-6de59de1-20261122.json`
  (10 cells, fitness min 0.297 / median 0.5 / max 0.609; 1 deck promoted into
  the league, 2 near-duplicate offers correctly pruned at distance 4).
- **Report**: `public/data/selfplay.report.json` (committed run summary).
- **Caveat (from the proposal)**: the self-play result is valid for this
  simulator and these bots only — it is not evidence about the real
  tournament meta. Real decks remain the fixed sanity-check opponents;
  engine meta ≠ real meta.

## Learned deck completion (learned-deck-generator, phase 5 of issue #30)

Final pipeline run (tasks 5.1/5.2): five-strata corpus, D2a-weighted
all-strata retrain, matched A/B gate, verdict + report.

- **Verdict: SHIPPED** — the matched A/B (learned vs shipped suggest-fill,
  identical seeds/conditioning/meta model, heuristic referee, full 10-member
  league, paired seeds, 8 games/member) measured aggregate learned win rate
  **0.6583** (632/960) vs shipped **0.5146** (494/960): uplift **+0.1438**,
  95% cluster-bootstrap CI **[+0.0229, +0.2635]** — CI low > 0 with zero
  illegal decks across all 12 matched deck-pairs. Gate flag set in the
  artifact; smart mode may use the learned fill.
- **Per-regime uplift (reported, not gated)**: unrestricted **+0.2906**
  CI [+0.1594, +0.4125]; declared inks **+0.0594** CI [−0.1750, +0.2906];
  franchise filter **+0.0813** CI [−0.0469, +0.2906]. The restricted-regime
  CIs span zero (4 deck-pairs per regime — 320 games — is a small sample);
  the point estimates are positive in every regime, but the gate decision
  rests on the pre-committed aggregate rule, and the restricted-regime
  evidence is thin. The two Frozen pairs generated identical decks under
  both fills (the learned model changed nothing there) and contribute zero
  uplift — recorded, not excluded.
- **Corpus**: 5,634 pairs across five strata — masked-elites 1,428,
  restricted 1,428, pool-slice 1,386 (33 of 36 slice decks; the ~25% cap
  recomputed against the FINAL corpus dropped the 3 lowest-fitness decks,
  share 0.2460), coverage 1,344 (weight 0.3), substitution-delta 48. The
  rebuild without slices reproduced the committed 4,248-pair corpus
  byte-identically; the final corpus rebuild is byte-identical across runs;
  the deck-exact holdout gained only pool-slice keys (29 holdout cells).
- **Retrain (D2a weighting)**: substitution pairs weight the loss by the
  measured |Δ| (Δ>0 → cardIn positive at weight Δ; Δ<0 → cardOut positive
  and cardIn negative at weight |Δ|; |Δ| < 0.02 skipped — 7 of 48 deltas
  skipped, 26 trained + 15 holdout). Holdout accuracy **0.5796** vs the
  interim masked-elites-only artifact's 0.5536; holdout loss 2.8983
  (400 epochs, best 400). Artifact `public/data/generator-model.json`
  (7,749 bytes ≤ 100 KB budget, featureSchemaVersion 1, seed 20261123,
  byte-identical re-run asserted; only the gate block differs from the
  trained PENDING artifact).
- **Engine commit**: `6de59de1`. **Date**: 2026-11-23.
- **Report**: `public/data/generator.report.json`; A/B evidence in
  `scripts/training/data/generator/learned-ab-6de59de1.json` (seed bases
  30.0 M generation / 30.1 M play / 30.2 M bootstrap — disjoint from all
  prior documented ranges).
- **Caveat (simulator vs real meta)**: as with the self-play verdict, this
  gate measures the learned fill under the heuristic referee inside this
  simulator against the self-play league — it is not evidence about the
  real tournament meta. The runtime ships a live-trial loader
  (`loadLearnedModelForSite`) that bypasses the gate flag for site-wide
  testing; if the gate had FAILed, that forced path would be reverted.

### Schema-v2 feature contract (task 6.x) — verdict SHIPPED

- **Verdict: SHIPPED** — the schema-2 model beats the gate on both
  pre-committed legs: aggregate uplift **+0.1542**, 95% CI
  **[+0.0146, +0.2833]** (low > 0), and zero decks failing full validation.
  Per-regime: unrestricted **+0.2750** CI [+0.1844, +0.3781]; declared inks
  **−0.0063** CI [−0.2656, +0.1844] (spans zero — 4 deck-pairs is a small
  sample, recorded); franchise **+0.1938** CI [−0.0125, +0.4563]. The gate
  decision rests on the pre-committed aggregate rule, as for schema-1.
- **Harness legality fix (task 6.4, recorded for honesty)**: the first v2
  gate run mis-classified a spec'd conditioning relaxation as an illegal
  deck ("Not enough cards in the filtered pool — expanded to the full pool"
  on the Frozen pair at seed 30,000,008, learned arm) and returned
  NOT_SHIPPED on it. Per the generation spec ("Relax constraints gracefully")
  a relaxed deck that passes FULL validation is legal; the A/B harness now
  classifies legality as full validation only (deckProblems / ineligible /
  size / generation failure) and records relaxations per arm for visibility
  (`relaxedDecks: 1`, `learnedRelaxations` on the pair). The correction was
  re-evaluated WITHOUT re-simulation: the re-run with identical flags served
  every game from the arena cache (identical tallies) and flipped the
  verdict to SHIPPED. Unit tests pin both sides: relaxed-but-valid → legal;
  validation-violating → gate-fail.
- **Deployment**: the v2 artifact
  (`scripts/training/data/generator/generator-model-v2-6de59de1.json`,
  SHIPPED, ciLow 0.0146, 95,288 bytes) carries the flipped gate flag with
  all other content byte-identical to the trained PENDING artifact. The
  deployed `public/data/generator-model.json` stays the schema-1 SHIPPED
  artifact until the orchestrator's commit swaps it — schema-2 code cannot
  read a schema-1 artifact, so until that swap the learned path degrades to
  the shipped suggest-fill fill (the design's schema-mismatch fallback);
  code + artifact land together in the PR.
- **Features v2 (D2b as amended: signed feature hashing)**: the
  user-directed amendment replaced vocabulary-indexed one-hot blocks with
  SIGNED FEATURE HASHING into frozen buckets (FNV-1a 32-bit over the
  lowercased string; bucket = h % width, sign = (h >>> 8) & 1; own names and
  text-referenced family names accumulate into the same block): 24 base +
  32 keyword + 64 subtype + 64 tag + 2 (dual-ink/song) + 512 name + 1
  uniqueName = **699 dims**, + 8 exact interaction dims (nameOverlap,
  shiftMatch, refNameMatch, nameTargetMatch, traitEngineMatch,
  traitTargetMatch, selfRefTrait, typeRefMatch) = 707 candidate width, 723
  scorer input. The model SHAPE is frozen across set arrivals — no schema
  churn on new-set vocabularies; a deliberate bucket change is a real
  schema bump, evidence-driven via the measured collision rates recorded in
  the artifact + report: families 328/531 colliding (61.8%, 342/512 buckets
  used), subtypes 28/50 (56%), keywords 11/24 (45.8%), tags 15/35 (42.9%),
  full name-block load 1311/1400 (93.6% over all parsed names incl. unique).
  Params 34,529 (~34k); artifact 95,288 bytes ≤ 100 KB budget.
- **Retrain**: same five-strata corpus (`corpus-6de59de1-20261123.json`,
  5,634 pairs, schema stamp bumped 1→2 — the corpus is feature-agnostic),
  seed 20261123, byte-identical re-run asserted. Holdout accuracy
  **0.6863** vs the schema-1 baseline **0.5796** (+0.1067); holdout loss
  2.8508 (400 epochs, best 400). The sparse-forward training path (memoized
  nonzero feature indices — v2 vectors are ~98% zeros; skipping exact zeros
  in ascending order is bit-identical to dense) kept the v2 retrain at
  ~10 min under contention vs 883 s for the 24-dim schema-1 run; both
  implementations are parity-pinned across all 3,556 snapshot cards.
- **A/B (same regimes/pairs/seeds as schema-1)**: vs schema-1 — unrestricted
  +0.2906 → +0.2750; declared inks +0.0594 → −0.0063; franchise +0.0813 →
  +0.1938; aggregate +0.1438 (SHIPPED, ciLow 0.0229) → +0.1542 (SHIPPED,
  ciLow 0.0146). Zero identical deck-pairs (schema-1 had 2 Frozen no-ops —
  the v2 model actually acts inside Frozen, which is where the recorded
  relaxation fired). The declared-inks regime flipped sign with a CI
  spanning zero on both runs — thin-regime noise, not a regression signal.
  Evidence: `scripts/training/data/generator/learned-ab-v2-6de59de1.json`.
- **Report**: `public/data/generator.report.json` (schema-1 vs schema-2
  comparison block; harness-fix note; deployment rule). **Date**: 2026-11-23.
- **Caveat (simulator vs real meta)**: unchanged from the schema-1 verdict
  above — the gate measures learned-vs-shipped fill under the heuristic
  referee against the self-play league, not the real tournament meta.

## Engine lifecycle (new sets)

- **Our catalog**: weekly `data.yml` lorcanajson refresh — new sets appear in
  the app and goldfish immediately.
- **Vendored engine**: bumped explicitly, not automatically. Bump procedure:
  pin new upstream commit → regenerate mapping → determinism + throughput
  checks → coverage delta in the validation report. Upstream typically
  supports a new set within days; we adopt on our schedule.
- **The gap is handled by eligibility, not fallback**: decks containing cards
  the engine cannot resolve are arena-ineligible until the next bump (the
  engine's fallback card definition is never used silently — placeholder
  games would poison win-rate data). Cache keys carry the engine version, so
  records never mix eras; the miner stratifies by engine version.
- **Website suggestions are never blocked** by engine coverage: the inductive
  encoder (M2) covers new cards from content alone.

## Non-goals

- No runtime network calls; artifacts ship as static files.
- Goldfish stays for instant deterministic in-app metrics.
- The arena improves the model; tournament data (TopDeck) remains the
  calibration anchor — engine meta ≠ real meta.
- InkTable is a manual QA tool, not an integration target (closed source,
  human-vs-AI only, no API).

## Fast referee — IS-MCTS certified (issue #30 follow-up)

The i75 referee gate completed: **PASS** — IS-MCTS beat the shipped
heuristic bot from both seats over 1,000 paired-seed games, win rate
**0.674** (674/1000; seat balance 333/500 vs 341/500 — no seat bias),
bootstrap 95% CI **[0.645, 0.703]** (Wilson [0.644, 0.702]), CI low
well above 0.5. Per design D2a, `is-mcts @ i75` is now a certified
referee identity. The schema-2 SHIPPED verdict (heuristic-refereed)
stands; a re-refereed acceptance match under the search-strength
referee is the optional next rung (~19 h at ~1.66 games/min, or a
pre-committed reduced budget). The `fast-ismcts-referee` variant
(1.13× measured, playout-bound per profile) was shelved by decision —
implementation preserved uncommitted in the `.worktrees/fast-mcts`
worktree. Engine commit `6de59de1`, 2026-11-24.
