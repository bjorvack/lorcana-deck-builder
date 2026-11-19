# Spec Delta

## Purpose
The generator's fill behavior changes from static score-and-fill with smart/chaos modes to the slider-driven suggest-fill loop. Legality, partial-deck completion, and graceful relaxation are unchanged; the fill-strategy requirements are replaced.

## MODIFIED Requirements

### Requirement: Smart mode targets a playable build
The generator SHALL fill decks via the suggest-fill loop driven by the novelty slider (see the suggest-fill-generation capability), replacing the static `smartScore` fill. Previous smart-mode playability targets (inkable ratio, cost-curve concentration, character-dominant type mix) continue to apply as needs boosts inside the loop, subject to the slider position and pool.

#### Scenario: Smart deck curve
- **WHEN** the generator fills a deck at the middle slider position from a full pool
- **THEN** inkable cards are at least 40% of the deck, the modal cost falls within 2–4, and characters dominate the type mix

#### Scenario: Deck evolves with its suggestions
- **WHEN** a deck contains cards that the relation or text space ties to specific partners
- **THEN** those partners appear among the scored candidates with elevated scores before unrelated cards

## REMOVED Requirements

### Requirement: Chaos mode fills randomly
**Reason** Chaos mode duplicated the novel end of the new novelty slider with a cruder scorer; a separate uniform-random mode would add a third fill strategy to maintain for no user value.
**Migration** Use the generator at the slider's novel end (novelty weighting + high temperature), which produces exploratory decks that still respect legality, copy limits, and the copy policy.
