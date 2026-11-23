# Proposal: learned-deck-generator

## Why

The self-play archive now holds curated, gate-verified decks (10 cells, acceptance SHIPPED 0.5625, CI [0.5156, 0.6120]) — enough to attempt phase 5 of issue #30: a small set model that learns deck completion from that archive and takes over smart-mode filling, so the generator consumes learned signal instead of heuristics alone. This is the last phase of the issue's design.

## What Changes

- **Training corpus (gated strata)**: (a) masked elites — (seed → deck) pairs derived from the MAP-Elites archive and promoted league decks; (b) **arena-measured substitution deltas** — leave-one-out arena runs (replace card X with candidate Y on paired seeds) producing advantage-weighted (context, card-out → card-in, Δ) pairs, the M4 ROADMAP's missing advantage-weighted signal; (c) restriction-conditioned decks — MAP-Elites-style search inside declared-ink, franchise-restricted, and franchise-feasibility-checked pools, league-evaluated, kept above a pre-committed fitness threshold; (d) **pool-slice ablations** — completions searched inside 8 seeded random 50% subsets of the card pool, threshold-gated, so the model learns per-card utility instead of memorizing full-pool staples (popularity-bias debiasing; capped at ~25% of corpus pairs); (e) a **coverage sweep** so every self-play pool identity appears in at least one pair. No co-occurrence statistics; features derive from card data only.
- **Set model**: a small pure-TypeScript DeepSets-style model (per-card encoder → masked mean pool → per-candidate scorer), trained in-repo following the M4 ranker's hand-rolled gradient-descent precedent. No new runtime dependencies.
- **Artifact**: weights emitted quantized to a **separate** `public/data/generator-model.json` (`meta-model.json` is at its 300 KB gzip budget and takes no new payload).
- **Smart-mode wiring**: `src/generate/` smart mode gains a learned completion source — seed cards → masked completion (legality as a mask from `src/rules`, never learned) → existing local-search/needs-loop refinement. Chaos mode unchanged. Graceful degradation: absent/corrupt model falls back to the current suggest-fill behavior (per-capability pattern of `src/meta/infer.ts`).
- **Gate**: pre-committed A/B — matched decks generated via learned completion vs the shipped suggest-fill loop on identical seed pools **covering both unrestricted and restricted conditioning (declared inks, franchise filters)**, played against the league on fresh seeds; shipped only if the uplift win-rate 95% CI lower bound > 0. A FAIL verdict is recorded in `ROADMAP.md` and the default path keeps the shipped behavior.
- **Explicitly deferred (recorded in ROADMAP)**: win-weighted simulated pair-lift mining for lesser-played cards (EDHREC-style long-tail lift from self-play game data) — it re-trains the shipped interactions artifact and needs its own gated change. LLM-based synergy labeling rejected on evidence (zero-shot quality too low; offline-by-design repo).

## Capabilities

### New Capabilities

- `learned-deck-completion` — the trained completion model: training corpus contract, model/artifact shape, legality masking, deterministic inference, and its A/B gate.

### Modified Capabilities

- `deck-generation` — smart mode may use the learned completion source when the model artifact exists and passed its gate, with clean fallback.

## Impact

- `scripts/training/` — new corpus/model training modules (arena reuse: cache, league, mutations, schedule), archive growth run, substitution-delta arena runs, restricted-pool search runs.
- `public/data/generator-model.json` — new committed artifact (quantized weights, budgeted size).
- `src/generate/` — smart-mode completion source + model loading/degradation; app tests. No UI changes; chaos mode untouched.
- `ROADMAP.md` — gate verdict + deferred long-tail lift follow-up; `generator.report.json` — training + gate evidence.
- Risk: with 10 archive decks the corpus is small; the multi-strata corpus and the gate exist precisely to refuse a weak model, and archive growth mitigates it.
