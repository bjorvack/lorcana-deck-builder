# Spec Delta

## Purpose
The meta-model artifact gains the per-card popularity data the generator's novelty weighting needs: tournament playrate and typical copies when played, quantized to keep the artifact small. Artifact version bumps to `'3'`; clients tolerate stale versions.

## MODIFIED Requirements

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
