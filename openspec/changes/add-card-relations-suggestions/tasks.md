# Tasks

Tasks are ordered by dependency; each group lands its own tests and keeps `tsc`/`vitest` green.

## Phase 1 — Canonical card registry

- [x] 1.1 Create `scripts/training/canonical.ts`: build the canonical registry from `cards.min.json` (group by `groupKey`, canonical = newest `releasedAt`, tiebreak highest `setCode`) with `resolve(printId)` alias mapping; export a client-side equivalent helper fed by the app's card list. Verify: unit tests — multi-print full names collapse to the newest print; single-print cards resolve to themselves; snapshot spot-check (promo vs original print)

## Phase 2 — Weekly trainer (relations + calibration)

- [x] 2.1 Add SGNS relation training to `scripts/training/train.ts`: canonicalize deck lists through the registry, train dim-32 embeddings (seeded, 5 negative samples, ~10 epochs), holdout coherence gate (own-card similarity ≥ 1.1× random-pair similarity). Verify: unit tests — determinism across runs; synthetic two-family dataset passes coherence; empty corpus → gate rejects
- [x] 2.2 Restructure the artifact: `meta-model.json` with `capabilities: { relations, calibration }`, per-gate metrics, relation embeddings (Int16 + per-vector scale, base64) and calibration fields; publication when either gate passes (failing parts omitted); existing emit-model size gate unchanged. Verify: unit tests — both gates pass → both present; calibration fails → relations still shipped; neither passes → nothing emitted
- [x] 2.3 Run training on the real TopDeck corpus; record the gate outcome and artifact size in the change's benchmark notes. Verify: measured note; artifact (if emitted) passes the 300 KB check

## Phase 3 — Client text features + suggestions

- [x] 3.1 Add text-feature vector computation to `src/meta/infer.ts`: deterministic features from keywords/tags/type/cost band/ink/scaled stats, L2-normalized, memoized per snapshot. Verify: unit tests — identical vectors for unchanged content; new card embedded immediately; dimension/shape stable
- [x] 3.2 Add `suggestCards()` to `src/meta/infer.ts`: canonicalize the deck, fuse relation + text similarity (0.6/0.4, documented), filter by format/declared inks/group copy limit/already-in-deck, return top 8 with basis labels. Verify: unit tests with a fixture model — off-ink/illegal/owned/exhausted-limit cards excluded; ranking follows fused score; missing relation embeddings falls back to text-only ranking
- [x] 3.3 Load `meta-model.json` through the existing meta-model loading path with per-capability handling (relations present/absent, calibration present/absent, stale). Verify: unit tests for each capability/staleness combination

## Phase 4 — Panel suggestions + verification

- [x] 4.1 Add the "Suggested additions" section to the analysis panel: top 8 rows (cost badge, ink dots, name, similarity, basis label, add-on-click wired to the existing deck handler), hidden when relation embeddings are absent, quiet empty state when the pool exhausts. Verify: component render tests — suggestions render with basis; hidden without embeddings; add button adds a legal card
- [x] 4.2 Live verification: dev server with the emitted artifact — suggestions appear for a valid deck, respect filters, and match the offline ranking; screenshot recorded in the change notes. Verify: manual/browser check recorded

## Workflow follow-up

- Re-run the benchmark notes after the Lorcanahunter corpus lands (relations retrain weekly; no task needed — the pipeline handles it)
- README: extend the meta model section with the suggestions feature when shipped
