# Design

## Context

The app is a Vite SPA deployed to GitHub Pages: static files only, no backend, and no runtime calls beyond same-origin fetches of `/data/*.json` (cards, sets, meta). We already ship a seeded Monte Carlo curve simulation (`src/stats/curve.ts`, greedy ink policy, 20k trials, fixed seed) and a weekly card-data pipeline (`scripts/pipeline.ts`) that commits snapshots to the repo. Card data includes text, keywords, tags, `deckRuleEffects`, subtypes, and `isSong` — enough to derive tempo effects by text parsing.

Tournament-outcome data is fetched offline from two documented APIs (no scraping): **TopDeck.gg** (key owned) and **Lorcanahunter** (OAuth2 application requested; contract below). All simulations respect the comprehensive rules (rev 2.3.0, Oct 2026): characters enter play drying, singers must be in play and dry, only exerted characters can be challenged, damage persists, locations pay lore automatically, Shift arrives dry, the on-the-play player skips the first draw, and a turn ending with an empty deck loses.

## Goals / Non-Goals

**Goals:**

- One deterministic fingerprint function per deck: fixed feature schema, seeded, < 50 ms for 60 cards, usable both as UI output and as model features later.
- Sim layers that stay honest: every number traceable to a stated policy; simplifications documented in the UI.
- Meta model trained offline on documented-API data, shipped as a static artifact ≤ 300 KB, degrading gracefully to sim-only.
- Phased delivery where each phase ships value on its own.

**Non-Goals:**

- A full Lorcana rules engine (no interactive responses, no attacker choices beyond greedy policy).
- Server-side anything; no model serving; no in-app training.
- Guaranteeing competitive accuracy of viability scores — these are decision-support estimates with visible assumptions, not ratings.
- Scraping sites that block or discourage it (inkdecks 403s plain clients, Mushu Report sits behind a Cloudflare JS challenge) — excluded by policy.

## Decisions

**D1 — Effect extraction via curated text parsing, keyed by card id.**
Parse card text once at data-load into a tempo-effects table: `selfDiscount` (regex `pay N ⬡ less to play this`), `singable` (`isSong`; singers are characters in play, so the sim tracks a board), `rampOnPlay` (unconditional "put the top card of your deck into your inkwell"), `additionalInkPerTurn` (CR 4.2.3.1 family), `inkDrops` (counter grants), `flexibleInk` ("put any card from your hand into your inkwell" — also inks cards without the inkwell icon). Conditional self-discounts (e.g. LeFou needing a Gaston) are skipped in v1. Shift **coverage** is computed from data (`card.name` shared between the Shift card and a character), not text parsing. Parsed results are spot-check tested against the real snapshot (One Jump Ahead ramps; Fishbone Quill flexible-inks; LeFou absent in v1).
*Alternative considered:* hand-maintained card table — accurate but rots with each set; parsing + tests scales with the weekly snapshot.

**D2 — One simulation core, layered.**
`curve.ts` v2 adds effective ink (base + ramp from earlier turns + additional-ink effects + ink drops), effective cost (self-reduction), a minimal board (characters with played-turn for drying; songs sung by dry in-play characters, singer's quest given up that turn), and flood (after the curve play, spend remaining ink most expensive first). The goldfish (`src/stats/goldfish.ts`) reuses the same draw/ink/play core and adds: questing from dry characters (turn after arrival), locations' automatic lore, challenge resolution against the opponent profile with keyword legality (Evasive/Alert, Bodyguard redirect, Ward vs effect targeting, Reckless), persistent damage, deck-out loss at end of own turn, and on-the-play/on-the-draw first-draw handling. Opponent profiles are static parameter tables (curve histogram, threat lore/turn, removals per turn window) seeded from the benchmarked official/competitive lists.
*Alternative considered:* two independent sims — duplicated logic, divergent policies; shared core keeps policies consistent and testable.

**D3 — Fingerprint is a plain serializable object with a schema version.**
`src/stats/fingerprint.ts` returns `{ version, curve, openingHand, redundancy, interaction, singerCoverage, shiftCoverage, tempoAxes, matchups }`. The UI renders it; phase 4 trains against it. Versioning lets the calibrator refuse fingerprints from older schemas.
*Alternative considered:* ad-hoc UI stats — would force retraining on every UI tweak.

**D4 — Meta data from two documented APIs; artifact = one JSON, fp16, versioned.**
Primary corpus: **Lorcanahunter API** (application pending; contract pinned from `/openapi/developer-v1.yaml`):
- OAuth2 client-credentials; access token 24 h; **refresh tokens rotate — reuse of an old refresh token revokes all app tokens**, so the fetcher persists the latest refresh token atomically (gitignored state file). 60 req/min, 10k/day, 429 with `Retry-After`.
- Endpoints: `GET /api/v1/tournaments` (filters eventType/format/date, ≤100/page), `GET /api/v1/tournaments/{id}` (standings with `omwPct`/`gwPct`/`ogwPct`, `isTopCut`, `decklistsAvailable`), `GET /api/v1/tournaments/{id}/decklists` (cards normalized: `setCode`, `number`, `cost`, `inkwell` — mapping to our snapshot by collector code, with their fields as fallback for snapshot lag), `GET /api/v1/archetypes` (per-archetype `deckCount`/`topCutCount`/`metaShare`; each standing's `deck.archetype` labels decks directly).
- Volume: ~17.9k decklists ≈ 180 paginated requests — a backfill fits the 10k/day budget easily.
Cross-check: **TopDeck.gg** (key owned; `game: "Lorcana"`, `format: "Core Constructed"`; winRate/opponentWinRate/metrics; ~600 lists/yr ≥32 players). Structure for embeddings: **api-lorcana.com** (open, no auth; decks in Dreamborn-style ids) and Dreamborn's public JSON. Excluded by policy: inkdecks (Cloudflare blocks plain clients, no API), Mushu Report (JS challenge), melee.gg (org-only credentials).
Training scripts under `scripts/training/` (Python + scikit-learn; dev-only): dedupe (same player/event), train per-card logistic weights and archetype centroids, embed via co-occurrence skip-gram (phase 5, PMI-weighted to counter staple dominance), backtest on the most recent holdout and record metrics in the artifact — the pipeline refuses to ship a model that does not beat the archetype-prior baseline. Output `/data/model.json`: `{ version, dataThroughDate, cardSchemaVersion, archetypes, cardWeights, embeddings? }` ≤ 300 KB compressed.
*Alternative considered:* ONNX/WASM runtime — unnecessary for dot products at this scale; JSON + plain JS inference keeps the bundle dependency-free.

**D5 — Viability score = sim strength + meta adjustment, both visible.**
Sim strength is derived from the fingerprint by a documented deterministic formula (weighted axes). Meta adjustment = calibrator output (phase 4: ridge/logistic on [fingerprint + counts]) minus sim prior, clamped. Both render separately so the ML never becomes a black box.
*Alternative considered:* single fused score — cheaper to display, hides whether a verdict comes from simulation or from meta fit.

**D6 — Analysis panel sits under the stats section and renders only for valid decks.**
The deck page's statsgrid gains the analysis panel(s); the panel renders only when `validateDeck` reports no violations for a complete deck — during deckbuilding it stays hidden rather than showing noisy numbers. Recomputation is memoized on deck identity like existing stats.

## Risks / Trade-offs

- [Text parsing misclassifies an effect (edge wording, new sets)] → curated spot-check tests per effect type run against the real snapshot in CI; unknown phrasing degrades to "no effect" (conservative), never to an illegal play.
- [CR 2.2 hand-alteration wording is ambiguous in community sources] → verify against the official comprehensive-rules PDF during phase 1 before implementing the opening-hand metric; document the chosen wording in the panel.
- [Lorcanahunter grant denied or delayed] → phase 4 starts from TopDeck + api-lorcana data alone; Lorcanahunter HTML pages are fetchable (Cloudflare pass-through verified) but treated only as a last-resort shallow fallback, not the pipeline.
- [Refresh-token rotation revokes the app on stale reuse] → the fetcher writes the newest refresh token atomically (temp file + rename) and re-authenticates on any 401.
- [Goldfish sim misleads (no interactive play)] → profiles and policies documented in tooltips; matchup outputs labeled "estimate vs baseline profile", never "win rate".
- [Tournament data volume is modest and the meta shifts weekly] → archetype-level stats ship before per-card weights; strong regularization; backtest gate; `dataThroughDate` surfaces staleness in the UI.
- [Compute cost of fingerprint + 3 matchups per deck edit] → single memoized computation per deck change; 20k-trial sims measured < 20 ms each today; trials tunable.

## Migration Plan

Phases ship independently in the order fingerprint core → goldfish → analysis panel → meta pipeline + panel wiring (+ suggestions). Rollback per phase is trivial: the panel is hidden if its inputs are absent; the model artifact is additive and optional. No data migration; `.data-cache/` gains tournaments caches (gitignored like the rest).

## Open Questions

- CR 2.2 exact hand-alteration wording — verify from the official PDF at phase-1 implementation time (blocked only on reading the PDF; choice documented in the panel).
- Lorcanahunter application approval — phase 4's fetcher is written against the pinned contract and integration-tested once credentials arrive; everything else proceeds.
