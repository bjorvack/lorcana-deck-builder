# Tasks

## 1. Corpus

- [x] 1.1 Extend the MAP-Elites search by a pre-committed growth run (4 generations × population 8, seed 20261123, reusing cached league games) and verify ≥ 20 archive cells with the search summary + archive diff
- [x] 1.2 Build the masked-elites corpus builder (seeded masking of archive + promoted decks into seed→target pairs, holdout split by cell) and verify with unit tests on a fixture archive (pair shapes, holdout disjointness, determinism)
- [x] 1.3 Implement card-data-only feature extraction (cost, ink, type, keywords, stats, text-derived buckets) with a `featureSchemaVersion`; verify unit tests compute expected vectors for fixture cards
- [x] 1.4 Build the substitution-delta stratum: leave-one-out arena runs on elite decks (replace one card with pool candidates, paired seeds via the schedule, cached) producing (context, card-out → card-in, Δ) pairs; verify with a unit test on synthetic deltas + a small real run on one elite deck — PRE-COMMITTED scope: top-8 elites by fitness, 6 pool candidates each, 40 games per paired comparison
- [x] 1.5 Build the restricted-conditioning stratum: MAP-Elites-style search inside declared-ink and franchise-restricted pools (3 franchise subsets + 2 ink pools, small budgets), league-evaluated, kept above the 0.45 fitness threshold; verify the threshold logic + recorded per-pool coverage (thin pools drop out honestly) — PRE-COMMITTED pools: franchises Frozen, Aladdin, Lilo & Stitch; ink pools Ruby/Sapphire and Amethyst/Emerald; each 2 generations × population 6, games-per-member 8, master seeds 20261123+poolIndex
- [x] 1.6 Pool coverage guarantee: widen any thin restricted pool below the search threshold (union with its declared-ink pool, sizes recorded) and rerun; then a coverage sweep batching every still-unseen pool identity into forced-inclusion seed decks (~20/deck, ≤150 decks, league-evaluated, distinct `coverage` stratum, fitness recorded, no threshold); corpus reports pool-coverage % + occurrence histogram (≥1 per identity required, 0.3 training weight per D1b); verify with unit tests (unseen-card detection, widening rule, histogram math) + a small real sweep on a sample batch
- [x] 1.7 Pool-slice ablation stratum (D1c): 8 seeded random 50% slices of the legal self-play pool, searched with the 1.5 budget and thresholded at strict > 0.45; slice pairs capped at ~25% of corpus pairs; verify with unit tests (slice determinism, cap enforcement, threshold) + a real run over all 8 slices (detached, resumed from cache on interruption)

## 2. Resumability

- [x] 2.1 Make `map-elites.ts` resumable: load the existing archive at `--archive` (if present), merge valid leftover `.parts-*` dirs from prior interrupted runs (keyed by generation + candidate index), and skip already-placed work so a re-run with identical flags continues rather than restarts; verify with a test that kills/resumes a fake-player search at generation 1 and produces the same final archive as an uninterrupted run
- [x] 2.2 Make `is-mcts-gate.ts` resumable: sweep orphaned `.parts-*` dirs at startup (merge valid part files before spawning workers) and rely on the per-pair JSONL cache for game-level resume; verify by interrupting a small smoke run and re-running to completion with zero re-simulated games for finished pairs
- [x] 2.3 Extend the AGENTS.md detached-compute rule with the resume contract (same flags → continue, never restart) and verify every long-running CLI entry point (map-elites, is-mcts-gate, acceptance, league, future training) either resumes from checkpoints/cache or documents why it needs no checkpoint; verify by grepping entry points and running the resume tests

## 3. Model and training

- [x] 3.1 Implement the pure-TS DeepSets model (per-card encoder ≤32 hidden, masked mean pool, candidate scorer) with forward inference and seeded SGD training (softmax cross-entropy over masked candidates); verify a unit test trains on synthetic data to above-chance holdout accuracy
- [x] 3.2 Train on the corpus with holdout early stop; emit quantized `public/data/generator-model.json` ≤ 100 KB with `featureSchemaVersion`, gate flag, and training evidence; verify deterministic re-training (byte-identical artifact) and the size budget; persist the corpus to disk so training resumes from the artifact rather than rebuilding — interim artifact trains masked-elites + restricted strata; the final all-strata run (incl. D2a-weighted deltas) happens before the A/B gate

## 4. Runtime wiring

- [x] 4.1 Add the learned fill source to `src/generate/` (masked scoring over legal candidates, seeded top-K pick, needs-boost + local-search phases unchanged) with graceful fallback (missing/corrupt/schema-mismatch artifact → shipped fill); verify app unit tests cover both paths and legality
- [x] 4.2 Verify chaos mode and the suggest-fill default path are behaviorally unchanged; verify app tests + a generation smoke in both modes

## 5. Gate and verdict

- [ ] 5.1 Run the matched A/B gate (learned vs shipped fill, identical seed pools ~50% unrestricted + ~50% restricted conditioning with per-regime uplift, paired-seed league games, heuristic referee) with bootstrap uplift CI; verify the verdict logic in tests
- [ ] 5.2 Record the verdict: PASS → set the gate flag in the artifact so smart mode enables the learned path; FAIL → artifact ships without the flag and the shipped path stays default; either way write `public/data/generator.report.json` and the ROADMAP entry; verify the report file contents
- [ ] 5.3 Full program checks pass: `npm run typecheck && npm run lint && npm test` clean, including new tests

## 6. Schema-v2 feature contract

- [ ] 6.1 Features v2 in both implementations (training `features.ts` + runtime `learned-fill.ts`): base 24 dims + 24 curated keywords + 50 subtypes + 35 functional tags + `isDualInk`/`isSong` + all 531 name families (parse `name` on `" & "`, 1–3 names) + `referencesName` on the shared name index + `uniqueName` flag; `featureSchemaVersion: 2`; verify with hand-computed vectors, Hunny/Gaston/Shift fixtures, and the all-cards cross-implementation parity test
- [ ] 6.2 Interaction dims in both model paths (training pair construction + runtime scoring): `nameOverlap`, `shiftMatch`, `refNameMatch`, `nameTargetMatch`, `traitEngineMatch`, `traitTargetMatch`, `selfRefTrait`, `typeRefMatch` — computed from card data (names + text + subtypes), cached per identity; verify LeFou/Gaston, Grand Duke/4-subtypes, Hunny package, and Starlight Vial/Action fixtures fire the correct dims; widen model input to the v2 width (~700 dims, ~33k params) with param + size assertions
- [ ] 6.3 Retrain on the final five-strata corpus with the v2 features (deterministic, byte-identical re-run); emit the v2 artifact (≤ 100 KB, schema 2); verify holdout accuracy vs the schema-1 baseline recorded in task 5.2
- [ ] 6.4 Re-run the A/B gate with the v2 model over the three conditioning regimes; update the artifact gate flag + `generator.report.json` (schema-1 vs schema-2 comparison) + ROADMAP entry; verify the verdict logic; then full program checks (typecheck, lint, tests) and deploy code + artifact together

## Workflow follow-up

- Commit on `feature/learned-deck-generator`, open the PR, merge after required checks.
- If the gate FAILs, phase 5 ends with an honest recorded negative verdict (per issue discipline) — no default-path change.
- Record in ROADMAP as a follow-up gated change: win-weighted simulated pair-lift mining for lesser-played cards (smoothed lift + minimum support + held-out validation), retraining the interactions capability. LLM synergy labeling rejected on evidence (zero-shot quality; offline-by-design).
