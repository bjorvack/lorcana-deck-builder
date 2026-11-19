# Spec Delta

## Purpose
The trained archetype data gains a user-facing role: any archetype in the artifact can be opened as a one-click starter deck to clone and adjust, giving deck creation a non-blank starting point. The artifact format is unchanged — this is a client capability over existing centroid data.

## ADDED Requirements

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
