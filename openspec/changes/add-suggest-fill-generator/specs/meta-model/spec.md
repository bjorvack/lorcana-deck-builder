# Spec Delta

## Purpose
The meta-model artifact gains the per-card popularity data the generator's novelty weighting needs: tournament playrate and typical copies when played, quantized to keep the artifact small. Artifact version bumps to `'3'`; clients tolerate stale versions.

## MODIFIED Requirements

### Requirement: Emit a capability-gated meta model artifact
The trainer SHALL emit `meta-model.json` version `'3'` containing, in addition to the existing capability-gated blocks (relation embeddings, calibration, card weights), two per-card maps over the training corpus:
- **playrate**: share of training decks containing the card (includes zero for cards never played), quantized to one byte
- **typical copies**: mean copy count across decks containing the card, quantized (integer 1–4)

The artifact SHALL stay within the existing emit size gate. The client parser SHALL accept versions `'2'` and `'3'`: on `'2'` (or any artifact lacking the maps) the client treats playrate as neutral and typical copies as unknown, rather than failing.

#### Scenario: Maps present and small
- **WHEN** the trainer emits a fresh artifact
- **THEN** the file reports version `'3'` and the two maps are present, quantized, with total artifact size within the emit size gate

#### Scenario: Version `'2'` artifact accepted
- **WHEN** the client loads a version `'2'` artifact
- **THEN** suggestions, archetypes, and relations work as before and the generator falls back to neutral novelty weighting

### Requirement: Suggest cards by fused similarity
The fused suggestion score SHALL be reusable beyond the suggestion panel: the scoring inputs (relation vectors, text-feature vectors, legality filters, playrate, typical copies) SHALL be exposed for the generator's per-iteration candidate scoring, so generation and suggestions compute similarity identically.

#### Scenario: Generator and panel agree on scores
- **WHEN** the same deck state and snapshot are scored by the suggestion panel and the generator's candidate scoring
- **THEN** a candidate's relation and text similarity components are identical in both paths
