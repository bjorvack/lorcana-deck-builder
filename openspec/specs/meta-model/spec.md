# meta-model Specification

## Purpose
The meta model calibrates the deterministic fingerprint against real tournament outcomes. Training happens offline; trained artifacts ship as static files and all inference runs client-side, so the app keeps working on GitHub Pages without external calls.

## Requirements

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

### Requirement: Train relation embeddings weekly

The weekly trainer SHALL train relation embeddings (skip-gram with negative sampling, fixed dimension, seeded) over the accumulated canonicalized tournament corpus, so relation suggestions reflect the current meta.

#### Scenario: Relations update with the weekly stream

- **WHEN** new tournament decklists are synced and the trainer runs
- **THEN** relation embeddings are retrained over the accumulated corpus

### Requirement: Support recency weighting

Relation training SHALL support recency weighting of tournament decks by event date as a parameter (decay half-life), defaulting off while the corpus is thin.

#### Scenario: Recency weighting is a parameter

- **WHEN** recency weighting is enabled with a half-life
- **THEN** newer events contribute more to relation training than older events

### Requirement: Gate relation embeddings on coherence

Relation embedding publication SHALL be gated by a holdout coherence check: a deck's own cards must average higher embedding similarity than random card pairs. Relation publication SHALL NOT be coupled to the calibration gate. Training SHALL be deterministic for a fixed corpus and seed.

#### Scenario: Coherence gate decides publication

- **WHEN** new tournament decklists are synced and the trainer runs
- **THEN** the coherence check alone decides whether relation embeddings publish, independently of calibration

#### Scenario: Deterministic training

- **WHEN** relation training runs twice on the same corpus with the same seed
- **THEN** the resulting embeddings are identical

### Requirement: Emit a capability-gated meta model artifact

The build pipeline SHALL emit a weekly meta model artifact (`meta-model.json`) version `'3'` containing relation embeddings (quantized), a `capabilities` block declaring which parts passed their gates, `dataThroughDate`, and `cardSchemaVersion`. The relation and calibration capabilities SHALL pass or fail independently: publication happens when either passes, and failed parts are omitted. The artifact MUST be self-contained: the running app MUST NOT call any external service to load or refresh the model. Version `'3'` additionally contains two per-card maps over the training corpus: playrate (share of training decks containing the card, quantized to one byte) and typical copies when played (integer 1–4, quantized).

#### Scenario: Independent capability gating

- **WHEN** training runs on a corpus where the relation coherence check passes but the calibration MAE gate fails
- **THEN** the artifact ships with `capabilities: { relations: true, calibration: false }` and the calibration fields are omitted

#### Scenario: Reasonable payload

- **WHEN** the meta model artifact is generated
- **THEN** its compressed size stays within a small static budget (target ≤ 300 KB) so GitHub Pages delivery stays fast

#### Scenario: Maps present and small

- **WHEN** the trainer emits a fresh artifact
- **THEN** the file reports version `'3'` and the playrate and typical-copies maps are present, quantized, with total artifact size within the emit size gate

#### Scenario: Version `'2'` artifact accepted

- **WHEN** the client loads a version `'2'` artifact
- **THEN** suggestions, archetypes, and relations work as before and the generator falls back to neutral novelty weighting

### Requirement: Canonical card identity for embeddings

Embedding training and client-side similarity SHALL use one identity per card: the latest print of a full name, resolved by newest release date (tiebreak: highest set code). Multiple prints of the same card SHALL alias to that canonical identity, so reprints never produce duplicate embeddings and wording/keyword/classification changes in a newer print flow in via the snapshot.

#### Scenario: Reprints collapse to one identity

- **WHEN** the snapshot contains multiple prints of the same full name
- **THEN** all prints resolve to the single canonical identity (the newest print) for embedding and similarity purposes

#### Scenario: Errata flows in

- **WHEN** a newer print of a card changes its wording or keywords
- **THEN** the canonical identity resolves to the newer print and subsequent text-feature derivation uses its content

### Requirement: Derive text-feature vectors client-side

The app SHALL compute per-card text-feature vectors in the browser as a deterministic pure function of card content, with feature vocabularies derived from the live snapshot — game keywords (the shift family collapsed to one dimension), gameplay tags, classifications, franchises, card type, cost band, ink, and scaled strength/willpower/lore — and L2 normalization. The computation SHALL be memoized per card-snapshot load. A card whose content is unchanged between snapshots SHALL produce an identical vector; brand-new cards SHALL be embeddable immediately without tournament history. Text vectors SHALL NOT ship in the artifact.

#### Scenario: Unchanged cards keep identical vectors

- **WHEN** text-feature vectors are computed for two consecutive card snapshots where a card's content fields are unchanged
- **THEN** that card's vector is identical

#### Scenario: Cold-start coverage

- **WHEN** a card snapshot adds cards from a new set
- **THEN** text-feature vectors exist for the new cards immediately, with no tournament data and no artifact update

#### Scenario: New keywords and classifications extend the space

- **WHEN** a new set prints a keyword or classification that does not exist in the current snapshot
- **THEN** the derived vocabulary includes it without a code change and its feature dimension participates in similarity

### Requirement: Suggest cards by fused similarity

When the artifact includes relation embeddings, the app SHALL rank candidate cards by a fused score — a documented weighted blend of relation-embedding similarity and client-side text-feature similarity — over the candidate pool canonicalized to one identity per card (latest print per full name), returning the top results. The scoring inputs (relation vectors, text-feature vectors, legality filters, playrate, typical copies) SHALL be reusable beyond the suggestion panel: the generator's per-iteration candidate scoring SHALL compute similarity identically.

#### Scenario: Both spaces contribute

- **WHEN** a candidate co-occurs with the deck in tournament lists and is also textually similar to the deck's cards
- **THEN** it ranks above candidates matching only one space

#### Scenario: Deterministic ranking

- **WHEN** suggestions are computed twice for the same deck and artifact
- **THEN** the ranking is identical

#### Scenario: Generator and panel agree on scores

- **WHEN** the same deck state and snapshot are scored by the suggestion panel and the generator's candidate scoring
- **THEN** a candidate's relation and text similarity components are identical in both paths

### Requirement: Suggestion filters enforce deck legality

Suggestions SHALL exclude cards already in the deck (by group identity — a different print of the same name counts as owned), cards illegal for the deck's format, cards outside the deck's declared inks, and cards already at their copy limit.

#### Scenario: Suggestion respects legality

- **WHEN** suggestions are computed for an Amber/Sapphire Core Constructed deck
- **THEN** no suggested card is off-ink, format-illegal, already in the deck at its group limit, or beyond its copy limit

### Requirement: Present suggestions with affinity basis

The app SHALL display suggestions with cost badge, ink dots, similarity value, and affinity basis label while the deck is **not yet a legal complete deck** (the building phase — additions only make sense there) and SHALL hide them once the deck is legal-complete, where the full analysis panel takes over. The section SHALL be hidden when the artifact lacks relation embeddings and SHALL show a quiet empty state when the candidate pool exhausts.

#### Scenario: Fusion is visible

- **WHEN** a suggestion is displayed
- **THEN** its similarity and affinity basis label are shown

#### Scenario: Suggestions belong to the building phase

- **WHEN** the deck is not yet a legal complete deck (incomplete or violating)
- **THEN** the suggestion section renders on its own, outside the full analysis panel
- **WHEN** the deck becomes legal-complete
- **THEN** suggestions are hidden

#### Scenario: Suggestions unavailable without embeddings

- **WHEN** the artifact lacks relation embeddings
- **THEN** the suggestion section shows the same unavailable state as other meta sections

### Requirement: Archetype starter decks
When the artifact includes the calibration capability, the app SHALL offer each archetype as a one-click starter deck: an editable deck built from the archetype centroid's cards, with the archetype's dominant inks declared and its name as the title. Starter decks SHALL pass validation to the extent the centroid does, and SHALL behave like any other deck for edits and regeneration.

#### Scenario: Open a starter deck
- **WHEN** the user opens an archetype as a starter deck
- **THEN** an editable deck is created from the centroid's cards with the archetype's inks declared and its name as the title

#### Scenario: Starter deck is legal
- **WHEN** a starter deck is created from a calibration-passing artifact
- **THEN** the deck carries zero copy-limit, off-ink, or dual-ink violations

#### Scenario: No calibration capability
- **WHEN** the artifact lacks archetypes
- **THEN** no starter-deck affordance is shown and deck creation works as without it

### Requirement: Interactions capability (gated pair-synergy mining)

The trainer SHALL mine card-pair synergy from the tournament corpus as
win-rate-weighted pair lift with support shrinkage, and SHALL publish a
per-card partner table in the artifact only when the pairs generalize to the
holdout split: the mean holdout lift of the selected pairs SHALL exceed the
mean holdout lift of a seeded random-pair baseline by the configured factor
(same threshold as the relations coherence gate). Mining SHALL be
deterministic: identical corpus and seed produce an identical payload.

#### Scenario: Synergy generalizes to future events

- **WHEN** pairs selected on the training split keep their lift advantage on
  the holdout split
- **THEN** the artifact ships with the `interactions` capability enabled and
  its gate metrics recorded

#### Scenario: Synergy does not generalize

- **WHEN** the selected pairs lose their advantage on the holdout split
- **THEN** the capability flag is false and no partner table ships, while
  other passing capabilities still publish

#### Scenario: Identical corpus reproduces identical mining

- **WHEN** the miner runs twice on the same corpus with the same seed
- **THEN** the produced partner table is byte-identical

### Requirement: Arena deck panel from the tournament corpus

The trainer SHALL be able to derive a panel of arena-eligible decks from the
tournament corpus: decks reduced to canonical identities, filtered to core
legality, engine-mapped identities and copy limits, deduplicated by deck
signature, ranked by win rate. Panel decks SHALL be written in the app's
plain-text deck format with a manifest recording their provenance.

#### Scenario: Panel decks are playable in the arena

- **WHEN** the panel builder runs on the current corpus
- **THEN** every emitted deck passes the arena runner's eligibility checks

#### Scenario: Duplicate lists collapse

- **WHEN** two corpus entries have the same deck signature
- **THEN** the panel contains one of them
