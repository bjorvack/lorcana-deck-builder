# Design: learned-deck-generator

## Context

Phase 5 of issue #30. The archive (`scripts/training/data/arena/selfplay/archive-6de59de1-20261122.json`,
10 cells, fitness ≤ 0.609) and league (9 members) exist from the self-play change.
`meta-model.json` sits at its 300 KB gzip budget (300.9 KB) — no new payload fits.
The M4 ranker (`ranker.ts:112-208,304-426`) already implements hand-rolled
gradient descent (logistic + 32-unit tanh MLP) in pure TS — the precedent for
training without new dependencies. `src/meta/infer.ts` establishes per-capability
graceful degradation for corrupt artifacts. The suggest-fill loop
(`src/generate/suggest-fill.ts:349-568`) is seeded via `mulberry32` and exposes
`scoreCard`; the pool/legality plumbing lives in `src/generate/generator.ts` and
`src/rules/engine.ts` (`canAddCard`).

## Goals / Non-Goals

- Goals: a trained completion model from archive data only, wired into smart mode
  behind its gate, fully deterministic, with honest gate verdicts.
- Non-Goals: no UI changes; chaos mode untouched; no co-occurrence features; no
  changes to `meta-model.json`; no retraining loop at runtime.

## Decisions

- **D1 — Corpus = three gated strata.** (a) Masked elites: each archive/promoted
  deck yields many (seed → deck) pairs by masking 8–48 cards per sample
  (seeded); 10 decks × ~40 maskings ≈ 400 pairs. (b) **Substitution deltas**:
  leave-one-out arena runs — for elite decks, replace one card with a pool
  candidate and play the paired-seed comparison (existing mutation operators +
  schedule + cache), yielding (context, card-out → card-in, Δ) pairs; this is
  the advantage-weighted signal M4's ROADMAP identifies as the missing lever,
  borrowed from 17Lands-style per-card delta methodology. (c)
  **Restriction-conditioned decks**: MAP-Elites-style search inside declared-ink
  and franchise-restricted pools (the generator's filter machinery supports
  both), league-evaluated, kept only above a pre-committed fitness threshold
  (0.45) so baseline-quality decks never become imitation targets (EDHREC's
  popularity-bias lesson applied to self-play: weak targets drag the model
  toward the baseline the gate is trying to beat). Archive growth first:
  extend the MAP-Elites run by 4 generations × population 8 targeting ≥ 20
  cells before training.
- **D2 — Pure-TS DeepSets, no new deps.** Encoder: per-card MLP (features →
  16-dim), masked mean pool over the partial deck, scorer MLP over
  [candidate features ⊕ pooled context] → scalar. Hidden widths ≤ 32; int16
  quantization on emit (meta-model precedent). Trained with the ranker's
  SGD pattern: for each pair, positive gradient on target cards, negative on
  masked-illegal sample candidates; softmax cross-entropy over candidates.
- **D2a — Advantage weighting for substitution pairs (pre-committed).** Each
  substitution pair contributes loss weighted by its measured Δ on paired
  seeds: Δ > 0 → cardIn is a positive candidate with pair weight Δ; Δ < 0 →
  cardIn is a negative with pair weight |Δ|; |Δ| < 0.02 (below the M3 noise
  floor) → the pair is skipped. Same softmax-CE machinery, pair weight scales
  its contribution. Harmful swaps actively push the model away from cardIn in
  that context; near-zero deltas contribute nothing. The final training run
  (before the A/B gate) trains on all three strata under this scheme; the
  interim artifact trains on masked-elites + restricted imitation pairs only,
  which is recorded in its evidence block.
- **D1b — Coverage: thin pools widen, unseen cards get a sweep.** Restricted
  pools below the searchable-size threshold are not dropped: they widen (union
  with the declared-ink pool containing their franchise cards; original +
  widened sizes recorded) and rerun. After all strata, a coverage sweep covers
  any still-unseen pool identity: identities batched into forced-inclusion
  seed decks (~20 per deck, seeded), league-evaluated (heuristic referee,
  paired seeds, cache), entering a distinct `coverage` stratum with measured
  fitness per deck — legality is the only exclusion gate, no fitness
  threshold, because the goal is visibility: the model must have seen every
  card it can legally be asked about at runtime. Sweep pairs train at a
  pre-committed reduced weight (0.3, same machinery as D2a) so long-tail noise
  cannot outweigh gated evidence. The corpus reports pool-coverage % and a
  per-identity occurrence histogram (≥1 required, ≥3 targeted where budget
  allows). Budget pre-commitment: ≤ 150 sweep decks (~10 min league time).
- **D1c — Pool-slice ablations (user directive).** 8 seeded random slices, each
  a 50% subset of the legal self-play pool (seed 20261123+900+index), searched
  with the 1.5 budget (2 gens × pop 6, 8 games/member) and thresholded at
  strict > 0.45 like all conditioned strata. Purpose: popularity-bias
  debiasing — with the staples absent, completions must come from the rest, so
  the model learns per-card utility instead of memorizing full-pool answers
  (training-time counterpart of the EDHREC lift lesson). Safe for the model
  because scoring is candidate-relative: the legality mask at inference mirrors
  the slice's absences, so there is no contradictory supervision. Guardrails:
  slice targets stay league-gated, and slice pairs are capped at ~25% of
  corpus pairs so full-pool elite evidence stays dominant. Slices are training
  augmentation only — the A/B gate tests user-facing regimes, not slice
  conditioning.
- **D2b — Schema-v2 feature contract: card identity + computed interactions
  (user directive).** `featureSchemaVersion` bumps to 2; input width ~700 dims:
  v1's 24 base dims, +24 curated keywords (Shift — 341 cards — is invisible to
  v1's text-derived flags), +50 subtype/classification dims (incl. Hunny),
  +35 functional tag dims, +`isDualInk`/`isSong`, +all 531 name families as
  exact one-hot dims (user directive: no tail hashing; single-card names fold
  into one `uniqueName` flag), +`referencesName` block on the same index
  (517 cards reference a known name in text, greedy longest-match with span
  removal). Name parsing splits `name` on
  `" & "` (1–3 names — Flotsam & Jetsam, Hamish, Hubert & Harris), version
  excluded (separate field). The model must not *learn* the crisp
  candidate↔seed relations the data hands us (D4 principle) — they are
  computed at scoring time in both implementations as interaction dims:
  `nameOverlap`, `shiftMatch` (341 Shift cards require same-name board match),
  `refNameMatch`/`nameTargetMatch` (LeFou↔Gaston), `traitEngineMatch`/
  `traitTargetMatch` (Grand Duke→Prince/Princess/King/Queen; the Hunny package:
  Christopher Robin + Magical Hunny Staff + Winnie the Pooh & Piglet),
  `selfRefTrait`, and card-type reference matching (Starlight Vial wants
  Actions — type one-hots alone don't express it). Shared 531-name index for
  isNamed/referencesName remains as context shaping. Sizing: ~33k params,
  ~66 KB quantized (budget 100 KB). Overfit risk on rare families is real at
  ~5.6k pairs — holdout early stop + the A/B gate arbitrate; schema-1's
  verdict (task 5.2) is the recorded baseline. Old artifact + new code =
  schema-mismatch fallback, so code and artifact deploy together.
- **D2c — Shape stability across set arrivals (user directive).** Open-vocabulary
  blocks (name families, subtypes, keywords, tags) use SIGNED FEATURE HASHING
  into fixed buckets (names 512, subtypes 64, keywords 32, tags 64; FNV-1a 32
  over the lowercased string, identical in both implementations), giving a
  frozen input width of 707 dims / ~34k params / ~70 KB artifact. A new set
  therefore never changes the model shape: snapshot refresh → coverage gate →
  corpus rebuild → retrain (weights only) → A/B re-run → redeploy; no schema
  bump, no runtime change. Trade-off recorded: ~26% of current name families
  share a bucket (context-shaping blur), while the crisp candidate↔seed
  matching lives in the exact interaction dims (D2b), which collisions cannot
  corrupt. `featureSchemaVersion` bumps only on semantic feature changes; the
  measured per-block collision rate ships in the training evidence so bucket
  growth stays evidence-driven (a deliberate bucket-count change is a real
  schema bump). The D2b reference block is dropped — its role is carried by
  the exact interaction dims. `featureSchemaVersion` bumps to 2; input width ~700 dims:
  v1's 24 base dims, +24 curated keywords (Shift — 341 cards — is invisible to
  v1's text-derived flags), +50 subtype/classification dims (incl. Hunny),
  +35 functional tag dims, +`isDualInk`/`isSong`, +all 531 name families as
  exact one-hot dims (user directive: no tail hashing; single-card names fold
  into one `uniqueName` flag), +`referencesName` block on the same index
  (517 cards reference a known name in text, greedy longest-match with span
  removal). Name parsing splits `name` on
  `" & "` (1–3 names — Flotsam & Jetsam, Hamish, Hubert & Harris), version
  excluded (separate field). The model must not *learn* the crisp
  candidate↔seed relations the data hands us (D4 principle) — they are
  computed at scoring time in both implementations as interaction dims:
  `nameOverlap`, `shiftMatch` (341 Shift cards require same-name board match),
  `refNameMatch`/`nameTargetMatch` (LeFou↔Gaston), `traitEngineMatch`/
  `traitTargetMatch` (Grand Duke→Prince/Princess/King/Queen; the Hunny package:
  Christopher Robin + Magical Hunny Staff + Winnie the Pooh & Piglet),
  `selfRefTrait`, and card-type reference matching (Starlight Vial wants
  Actions — type one-hots alone don't express it). Shared 531-name index for
  isNamed/referencesName remains as context shaping. Sizing: ~33k params,
  ~66 KB quantized (budget 100 KB). Overfit risk on rare families is real at
  ~5.6k pairs — holdout early stop + the A/B gate arbitrate; schema-1's
  verdict (task 5.2) is the recorded baseline. Old artifact + new code =
  schema-mismatch fallback, so code and artifact deploy together.
- **D2c — Shape stability across set arrivals (user directive).**- **D3 — Separate artifact, budgeted.** `public/data/generator-model.json`
  ≤ 100 KB raw; emits `featureSchemaVersion`, training evidence, quantized
  weights. Training seeded → byte-identical re-runs (asserted by test).
- **D4 — Legality as a mask at inference.** Candidates come from the pool
  already filtered by `canAddCard` under the current ink state; the model only
  ranks. Pick = seeded softmax top-K over masked candidates (suggest-fill
  sampling precedent, `sampleTopK`).
- **D5 — Runtime integration point.** A `LearnedFillSource` beside the
  suggest-fill loop: smart mode calls it per pick when enabled
  (artifact present ∧ schema match ∧ gate-passed flag recorded in the artifact),
  else delegates to the existing scoring path. Degradation mirrors
  `src/meta/infer.ts` per-capability try/catch. Needs boosts and the final
  local-search swap phase run after either source.
- **D6 — Gate mirrors ab.ts and covers the real conditioning surface.** Matched
  A/B: same seed pool, learned-vs-shipped fill, decks played against the
  league (heuristic referee) with paired seeds; PASS = uplift win-rate 95% CI
  low > 0. The seed pool is ~50% unrestricted, ~50% restricted (declared inks,
  franchise filters) with per-regime uplift reported — a model that only wins
  the easy case must not gate in. On FAIL: ROADMAP verdict, artifact ships
  without the gate flag so runtime stays on the shipped path (honest
  degradation, no silent enable).
- **D7 — Long-tail interaction mining is deferred, not dropped.** Simulated
  win-weighted pair-lift for lesser-played cards (EDHREC's synergy→lift
  migration shows contextual lift surfaces long-tail value that popularity
  metrics miss) would re-train the shipped interactions artifact — it needs
  smoothing/minimum-support for sparse pairs, win-weighting to avoid mining
  bot-mediated quirks, and validation against held-out real decks. Recorded in
  ROADMAP as a follow-up gated change; out of scope here. LLM-based synergy
  labeling is rejected on evidence (UrzaGPT et al.: untuned/zero-shot LLMs
  fail at fine-grained card quality; repo is offline-by-design).

## Risks / Trade-offs

- [Tiny corpus → overfit] → tiny model (≤ ~4k params), quantized, early stop on
  holdout pairs (elites split by cell); gate is the arbiter.
- [Archive growth compute under the IS-MCTS gate] → cached league games, SPRT,
  parallel 3; measured before the full run.
- [Smart-mode regression] → app tests assert legality + fallback paths; chaos
  untouched; feature-schema version check prevents stale-artifact misbehavior.
- [Gate-referee bias] → same D2a caveat as the league: heuristic referee;
  recorded in the report.

## Migration Plan

Artifact + code land together; runtime default flips only when the artifact
carries the gate-passed flag. Rollback: remove/replace the artifact — runtime
degrades to the shipped fill automatically.

## Open Questions

- None blocking. Hidden widths and masking schedule are training hyperparameters
  owned by the gate, not the spec. If restricted pools prove too thin to produce
  threshold-passing decks, those strata drop out and the report records their
  coverage honestly.
