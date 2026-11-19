# Proposal

## Why

The dashboard describes what a deck *contains* (inkability, curve, on-curve simulation) but not whether it can *win*: there is no clock speed, no resilience to interaction, no mulligan quality, and no sense of how the deck relates to decks that actually place at tournaments. Players must judge viability by intuition. We can compute a far better playability signal entirely client-side, and calibrate it against real tournament outcomes using an offline-trained model shipped as a static artifact — the app runs on GitHub Pages, so everything must render without external calls.

## What Changes

- **Phase 1 — Fingerprint core (deterministic):** extend the curve simulation to model Sing (songs played by exerting a dry in-play character with sufficient cost — available the turn after the singer lands), self cost reduction ("pay N ⬡ less"), ramp and the other ink-economy families (additional ink per turn, ink drop counters, flexible inking of uninkable cards), and flooding (spend leftover ink on additional plays). Add deterministic playability metrics: opening-hand quality under the game's real hand-alteration rule, redundancy (P(core card by turn t)), interaction density, singer coverage, and Shift coverage. These compose into a per-deck **fingerprint** (fixed feature schema, seeded, reproducible).
- **Phase 2 — Lore-race goldfish:** simulate the deck racing to 20 lore against three scripted opponent baselines (aggro / midrange / control profiles with parameterized curves and removal density); output win estimate and lore-by-turn distribution.
- **Phase 3 — Deck analysis panel:** UI panel under the existing statistics section, rendered only for complete, rule-legal decks, presenting the viability profile (Tempo / Consistency / Resilience / Interaction / Reach), matchup bars vs the three baselines, and per-metric drill-downs with tooltips explaining each number.
- **Phase 4 — Meta calibration (offline-trained, bundled):** fetch tournament outcomes and decklists from documented APIs — **Lorcanahunter** (primary corpus, OAuth2 application requested; ~17.9k decklists incl. DLC/CCQ events, per-deck archetype labels, normalized card fields) with **TopDeck.gg** as cross-check and api-lorcana.com/Dreamborn lists as embedding structure; train per-card meta weights and archetype centroids; ship weights as a static `/data/model.json`; client shows archetype match and a viability score decomposed into sim strength + meta alignment. Graceful fallback to sim-only scores when the model is absent or stale.
- **Phase 5 — Synergy suggestions (optional):** card co-occurrence embeddings from the same training run; "cards that complete this deck" nearest-neighbor suggestions.

Non-goals: no runtime network calls beyond the existing same-origin data fetches; no full rules engine (simulations use documented greedy policies and opponent profiles, not interactive play); no in-app training.

## Capabilities

### New Capabilities

- `deck-fingerprint`: deterministic playability analysis of a deck — fingerprint computation (seeded simulations and aggregates), lore-race matchup estimates vs archetype baselines, and the deck analysis panel that presents the viability profile. Covers phases 1–3.
- `meta-model`: offline-trained meta calibration shipped as static artifacts — archetype identification, meta-adjusted viability scoring, synergy suggestions, artifact freshness signaling, and sim-only fallback when artifacts are missing or stale. Covers phases 4–5.

### Modified Capabilities

- `deck-statistics`: the curve-consistency requirement is extended — the simulation must model Sing, self cost reduction, ramp ink, and flooding instead of assuming exactly one ink and one play per turn at full cost. Per-turn outputs skip turns the deck has no matching cost for (already specified) and the on-curve headline must remain stable across renders (fixed seed).

## Impact

- **Code:** `src/stats/curve.ts` (sim v2), new `src/stats/fingerprint.ts`, `src/stats/goldfish.ts`, `src/meta/infer.ts` (client inference), new offline training scripts under `scripts/training/` (Python or tsx), `scripts/pipeline.ts` (model artifact step), `src/ui/DeckView.tsx` + `src/ui/charts.tsx` (analysis panel), `src/data/load.ts` (model artifact fetch).
- **Data/artifacts:** new static `/data/model.json` (centroid + weights + embeddings, fp16, target ≤ 300 KB); TopDeck.gg dataset summarized into a committed training artifact (raw fetch cached in `.data-cache/`, not committed).
- **Build/CI:** training runs offline (local or GitHub Actions with the TopDeck key as a secret); GitHub Pages deployment unchanged — all runtime inference is client-side math (< 50 ms per deck).
- **Dependencies:** none at runtime (plain JS math); training may use Python (scikit-learn) or tsx — dev-only.
