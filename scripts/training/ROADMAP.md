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
| Generator AI | Synergy-aware candidate scoring for generate / suggest-fill | M2 |
| Bot: weight search | Tune shipped deck-aware strategy weights via tournaments | M3 |
| Bot: learned ranker | Custom engine strategy backed by a trained move-scoring model | M4 |
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

- **Interaction miner**: pair-lift / co-occurrence features from arena logs and
  tournament decks. Gate: synergy-ranked pairs beat random pairs on a holdout
  (mirrors the relations coherence gate).
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
- **Generator A/B**: synergy-aware generator must beat the current one at
  equal legality (arena win-rate uplift with confidence intervals, fixed
  seeds, fixed opponent panel).
- Arena sim-strength becomes a viability-profile feature; the existing
  calibration gate still decides what ships.

### M3 — Bot weight search (self-improvement, stage A)
Goal: a stronger opponent pool with zero ML infrastructure.

- Evolve/tune the shipped deck-aware strategy weights via tournaments
  (hill-climb / CMA-ES) over a fixed deck panel.
- Gate: tuned weights beat shipped weights head-to-head on the panel.

### M4 — Learned move ranker (self-improvement, stage B)
Goal: a custom engine strategy whose ranking is a trained model.

- Outcome-supervised ranker (state + candidate features → priority), trained
  on self-play logs; league training vs shipped strategies + past checkpoints
  to avoid degenerate self-play.
- Gate: beats the league average on a held-out deck panel; must not regress
  the calibration gate.
- Feasibility note: at ~4 games/s (parallelizable across cores), 10⁴-game
  training epochs are ~40 min single-threaded — stage B is practical locally;
  stage C is the first that needs a compute budget decision.

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
