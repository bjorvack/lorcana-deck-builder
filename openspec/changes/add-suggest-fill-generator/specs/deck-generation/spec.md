# Spec Delta

## Purpose
The generator's fill behavior changes from static score-and-fill with smart/chaos modes to the slider-driven suggest-fill loop. Legality, partial-deck completion, and graceful relaxation are unchanged; the fill-strategy requirements are replaced.

## MODIFIED Requirements

### Requirement: Slider-driven fill replaces smart/chaos modes
The generator SHALL fill decks via the suggest-fill loop driven by the novelty slider (see the suggest-fill-generation capability). The `smart` and `chaos` mode options SHALL be removed; previous smart-mode playability targets (inkable ratio, cost-curve concentration, character-dominant type mix) continue to apply as needs boosts inside the loop, subject to the slider position and pool.

#### Scenario: Playability targets preserved
- **WHEN** the generator fills a deck at the middle slider position from a full pool
- **THEN** inkable cards are at least 40% of the deck, the modal cost falls within 2–4, and characters dominate the type mix

#### Scenario: Mode option removed
- **WHEN** the generator is invoked with the previous `mode: 'chaos'` option
- **THEN** the option is rejected by the type contract; equivalent behavior is available at the slider's novel end

### Requirement: Chaos behavior subsumed by the novel end
Uniform random filling SHALL no longer be a distinct mode. The slider's novel end SHALL approximate exploratory behavior (novelty-weighted, high-temperature sampling) while still passing validation.

#### Scenario: Novel-end deck legality
- **WHEN** the generator runs at the slider's novel end from a full pool
- **THEN** the deck has 60 cards and zero validation violations, and contains cards absent from the tournament corpus

## REMOVED Requirements

### Requirement: Chaos mode fills randomly
**Reason** Chaos mode duplicated the novel end of the new slider with a cruder scorer; a separate uniform-random mode would add a third fill strategy to maintain for no user value.
**Migration** Use the generator at the slider's novel end (novelty weighting + high temperature), which produces exploratory decks that still respect legality, copy limits, and the copy policy.
