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
- **Verdict: FAIL at both feature sets.** v1 (16 features): learned 0.484 vs
  shipped, CI [0.40, 0.57], loss 0.639. v2 (20 features — board composition
  ink/hand/play both sides): 0.484 again, loss 0.623. Outcome-supervised
  linear ranking over bot-game features is exhausted at this scale.
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
