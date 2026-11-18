# Spec Delta

## ADDED Requirements

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

The build pipeline SHALL emit a weekly meta model artifact (`meta-model.json`) containing relation embeddings (quantized), a `capabilities` block declaring which parts passed their gates, `dataThroughDate`, and `cardSchemaVersion`. The relation and calibration capabilities SHALL pass or fail independently: publication happens when either passes, and failed parts are omitted. The artifact MUST be self-contained: the running app MUST NOT call any external service to load or refresh the model.

#### Scenario: Independent capability gating

- **WHEN** training runs on a corpus where the relation coherence check passes but the calibration MAE gate fails
- **THEN** the artifact ships with `capabilities: { relations: true, calibration: false }` and the calibration fields are omitted

#### Scenario: Reasonable payload

- **WHEN** the meta model artifact is generated
- **THEN** its compressed size stays within a small static budget (target ≤ 300 KB) so GitHub Pages delivery stays fast

### Requirement: Canonical card identity for embeddings

Embedding training and client-side similarity SHALL use one identity per card: the latest print of a full name, resolved by newest release date (tiebreak: highest set code). Multiple prints of the same card SHALL alias to that canonical identity, so reprints never produce duplicate embeddings and wording/keyword/classification changes in a newer print flow in via the snapshot.

#### Scenario: Reprints collapse to one identity

- **WHEN** the snapshot contains multiple prints of the same full name
- **THEN** all prints resolve to the single canonical identity (the newest print) for embedding and similarity purposes

#### Scenario: Errata flows in

- **WHEN** a newer print of a card changes its wording or keywords
- **THEN** the canonical identity resolves to the newer print and subsequent text-feature derivation uses its content

### Requirement: Derive text-feature vectors client-side

The app SHALL compute per-card text-feature vectors in the browser as a deterministic pure function of card content: game keywords, gameplay tags, card type, cost band, ink, and scaled strength/willpower/lore. The computation SHALL be memoized per card-snapshot load. A card whose content is unchanged between snapshots SHALL produce an identical vector; brand-new cards SHALL be embeddable immediately without tournament history.

#### Scenario: Unchanged cards keep identical vectors

- **WHEN** text-feature vectors are computed for two consecutive card snapshots where a card's content fields are unchanged
- **THEN** that card's vector is identical

#### Scenario: Cold-start coverage

- **WHEN** a card snapshot adds cards from a new set
- **THEN** text-feature vectors exist for the new cards immediately, with no tournament data and no artifact update

### Requirement: Suggest cards by fused similarity

When the artifact includes relation embeddings, the app SHALL rank candidate cards by a fused score — a documented weighted blend of relation-embedding similarity and client-side text-feature similarity — over the candidate pool canonicalized to one identity per card (latest print per full name), returning the top results.

#### Scenario: Both spaces contribute

- **WHEN** a candidate co-occurs with the deck in tournament lists and is also textually similar to the deck's cards
- **THEN** it ranks above candidates matching only one space

#### Scenario: Deterministic ranking

- **WHEN** suggestions are computed twice for the same deck and artifact
- **THEN** the ranking is identical

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
