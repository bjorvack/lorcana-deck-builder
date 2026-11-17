# Spec Delta

## Purpose

The meta model calibrates the deterministic fingerprint against real tournament outcomes. Training happens offline; trained artifacts ship as static files and all inference runs client-side, so the app keeps working on GitHub Pages without external calls.

## ADDED Requirements

### Requirement: Ship trained meta artifacts as static files

The build pipeline SHALL produce a meta model artifact (model version, archetype centroids with observed win rates, per-card meta weights, and optionally card co-occurrence embeddings) and ship it as a same-origin static file alongside the card data. Artifacts MUST be self-contained: the running app MUST NOT call any external service to load or refresh the model.

#### Scenario: Artifact loads with the app

- **WHEN** the app starts and a model artifact exists
- **THEN** the artifact is loaded from the same origin together with the card data

#### Scenario: Reasonable payload

- **WHEN** the model artifact is generated
- **THEN** its compressed size stays within a small static budget (target ≤ 300 KB) so GitHub Pages delivery stays fast

### Requirement: Identify archetype and meta-fit

The app SHALL compare the current deck's fingerprint and card composition against the shipped archetypes and report:

- the closest archetype (or a combination) with a similarity indication
- that archetype's observed tournament win rate from the artifact
- a viability score decomposed into a deterministic sim-strength component and a meta-alignment component, both shown to the user

#### Scenario: Steel song recognized

- **WHEN** a deck closely matches a shipped Steel Song archetype with a 54% observed win rate
- **THEN** the panel names that archetype, shows the similarity, and shows the 54% observed win rate

#### Scenario: Score decomposition is visible

- **WHEN** a viability score is displayed
- **THEN** the sim-strength and meta-alignment contributions are both visible, not only the combined number

### Requirement: Degrade gracefully without or with a stale model

The app SHALL function fully without a model artifact: all deterministic fingerprint and matchup metrics remain available, and meta-specific panel sections show a clear "meta model unavailable" state. The artifact SHALL carry a version and data-through date; when it is older than the card data snapshot, the app SHALL label meta results as stale rather than presenting them as current.

#### Scenario: No model artifact

- **WHEN** the app loads and no model artifact is present
- **THEN** deterministic metrics render normally, meta sections show an unavailable state, and no errors surface to the user

#### Scenario: Stale model

- **WHEN** the model's data-through date precedes the card data snapshot date
- **THEN** meta results are shown with a visible stale indicator

### Requirement: Suggest deck-completing cards

When the artifact includes card embeddings, the app SHALL suggest cards that commonly co-occur with the current deck's archetype in tournament lists — excluding cards already in the deck, cards illegal for the deck's format or inks, and cards over the copy limit — with each suggestion showing the affinity basis (archetype or co-occurrence).

#### Scenario: Suggestion respects legality

- **WHEN** suggestions are computed for an Amber/Sapphire Core Constructed deck
- **THEN** no suggested card is off-ink, format-illegal, or already present at its copy limit

#### Scenario: Suggestions unavailable without embeddings

- **WHEN** the artifact lacks embeddings
- **THEN** the suggestion section shows the same unavailable state as other meta sections
