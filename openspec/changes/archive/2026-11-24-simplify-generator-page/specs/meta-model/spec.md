# meta-model Delta

## REMOVED Requirements

### Requirement: Offer archetype starter decks

When the artifact includes the calibration capability, the app SHALL offer
each archetype as a one-click starter deck: an editable deck built from the
archetype centroid's cards, with the archetype's dominant inks declared and
its name as the title. Starter decks SHALL pass validation to the extent the
centroid does, and SHALL behave like any other deck for edits and
regeneration.

**Reason**: the generator page is simplified to two paths (fresh 60-card deck
or complete the current cards); archetype evidence remains visible in the
analysis panel's archetype match, and the learned completion model makes
heuristic starter scaffolding unnecessary for the primary flows.

**Migration**: users lose the one-click starter entry point; archetype
identification (name, similarity, observed win rate) remains in the analysis
panel, and decks can still be imported/exported. The archetype centroids stay
in the artifact for analysis purposes.

## ADDED Requirements

### Requirement: Generator offers two creation paths

The generator page SHALL offer exactly two deck-creation paths: generating a
fresh 60-card deck (with the selected filters and completion model), or
completing the user's current cards. No archetype-starter entry point SHALL
be presented on the generator page.

#### Scenario: Fresh generation

- **WHEN** the user runs generation without the complete-current option
- **THEN** a fresh 60-card legal deck is produced via the selected fill source

#### Scenario: Complete current cards

- **WHEN** the user enables complete-current-cards and runs generation
- **THEN** the current cards are kept unchanged and the remainder is filled
