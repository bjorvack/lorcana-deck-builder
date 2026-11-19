# Spec Delta

## Purpose
The generator fills a legal 60-card deck from chosen inks and optional set/franchise restrictions, either completing a user's partial deck or starting from scratch, in smart and chaos modes.

## ADDED Requirements

### Requirement: Generate legal decks
The generator SHALL produce a deck that passes full validation: 60+ cards, declared inks respected (a dual-ink card only when both its inks are declared), per-card copy limits, and the selected format's legality.

#### Scenario: Generate from empty
- **WHEN** the user picks two inks with no other constraints and runs the generator
- **THEN** the result is a 60-card deck with zero validation violations

#### Scenario: Dual-ink in generated deck
- **WHEN** the generator adds a dual-ink card to a deck with declared inks A/B
- **THEN** the card's two inks are exactly A and B

### Requirement: Complete a partial deck
The generator SHALL accept a partial deck (possibly under 60 cards), keep the user's cards unchanged, and fill the remainder from the allowed pool.

#### Scenario: Partial deck completed
- **WHEN** the user provides 24 cards of a Ruby/Steel pool and runs the generator
- **THEN** the result contains all 24 original cards unchanged plus 36 filled cards, and validates legally

#### Scenario: Partial deck with off-ink card
- **WHEN** the partial deck contains a card outside the declared inks
- **THEN** the card is kept and the validation result reports it as a violation rather than silently removing it

### Requirement: Smart mode targets a playable build
Smart mode SHALL bias the fill toward an inkable ratio of roughly 40–43% of the deck, a cost curve concentrated around cost 2–4, and a type mix dominated by characters, subject to the allowed pool.

#### Scenario: Smart deck curve
- **WHEN** smart mode generates a deck from a full pool
- **THEN** inkable cards are at least 40% of the deck and the modal cost falls within 2–4

### Requirement: Chaos mode fills randomly
Chaos mode SHALL fill the deck by uniformly random selection from the allowed pool, still passing validation.

#### Scenario: Chaos deck legality
- **WHEN** chaos mode generates a deck from a full pool
- **THEN** the deck has 60 cards and zero validation violations

### Requirement: Relax constraints gracefully
When the allowed pool cannot fill the deck, the generator SHALL progressively relax restrictions (first optional set/franchise filters, then reporting failure) and SHALL tell the user which relaxation applied.

#### Scenario: Too-small pool
- **WHEN** the chosen franchise pool has fewer than 60 eligible cards
- **THEN** the generator expands to the full pool of the chosen inks, states this in the result, and still produces a legal deck

#### Scenario: Impossible request
- **WHEN** even the relaxed pool cannot produce a legal deck
- **THEN** the generator reports failure with the reason instead of an invalid deck
