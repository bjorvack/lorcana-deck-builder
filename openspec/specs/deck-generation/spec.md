# deck-generation Specification

## Purpose
The generator fills a legal 60-card deck from chosen inks and optional set/franchise restrictions, either completing a user's partial deck or starting from scratch, in smart and chaos modes.

## Requirements

### Requirement: Generate legal decks
The generator SHALL accept 0, 1, or 2 selected inks. With 1–2 inks, behavior is unchanged: the deck passes full validation against the declared inks. With 0 inks, the generator derives the deck's inks from its cards (ink-emergent generation, see the card-first-creation capability) and the finished deck declares exactly the inks its cards require. An empty selection SHALL no longer be an error.

#### Scenario: Generate from empty
- **WHEN** the user picks two inks with no other constraints and runs the generator
- **THEN** the result is a 60-card deck with zero validation violations

#### Scenario: Dual-ink in generated deck
- **WHEN** the generator adds a dual-ink card to a deck with declared inks A/B
- **THEN** the card's two inks are exactly A and B

#### Scenario: Zero inks generates instead of erroring
- **WHEN** the user runs the generator with no inks selected
- **THEN** a 60-card deck is produced with zero validation violations and its derived inks declared

#### Scenario: One or two inks behave as before
- **WHEN** the user runs the generator with 1 or 2 inks selected
- **THEN** every card in the result fits the declared inks (dual-ink cards only under both)

#### Scenario: Two declared inks are both used
- **WHEN** the user picks 2 inks and runs the generator on a pool containing both inks
- **THEN** the finished deck contains cards of each declared ink — both inks are represented, not merely declared

### Requirement: Complete a partial deck
The generator SHALL accept a partial deck (possibly under 60 cards), keep the user's cards unchanged, and fill the remainder from the allowed pool.

#### Scenario: Partial deck completed
- **WHEN** the user provides 24 cards of a Ruby/Steel pool and runs the generator
- **THEN** the result contains all 24 original cards unchanged plus 36 filled cards, and validates legally

#### Scenario: Partial deck with off-ink card
- **WHEN** the partial deck contains a card outside the declared inks
- **THEN** the card is kept and the validation result reports it as a violation rather than silently removing it

### Requirement: Smart mode targets a playable build
The generator SHALL fill decks via the suggest-fill loop driven by the novelty slider (see the suggest-fill-generation capability), replacing the static `smartScore` fill. Previous smart-mode playability targets (inkable ratio, cost-curve concentration, character-dominant type mix) continue to apply as needs boosts inside the loop, subject to the slider position and pool.

#### Scenario: Smart deck curve
- **WHEN** the generator fills a deck at the middle slider position from a full pool
- **THEN** inkable cards are at least 40% of the deck, the modal cost falls within 2–4, and characters dominate the type mix

#### Scenario: Deck evolves with its suggestions
- **WHEN** a deck contains cards that the relation or text space ties to specific partners
- **THEN** those partners appear among the scored candidates with elevated scores before unrelated cards

### Requirement: Relax constraints gracefully
When the allowed pool cannot fill the deck, the generator SHALL progressively relax restrictions (first optional set/franchise filters, then reporting failure) and SHALL tell the user which relaxation applied.

#### Scenario: Too-small pool
- **WHEN** the chosen franchise pool has fewer than 60 eligible cards
- **THEN** the generator expands to the full pool of the chosen inks, states this in the result, and still produces a legal deck

#### Scenario: Impossible request
- **WHEN** even the relaxed pool cannot produce a legal deck
- **THEN** the generator reports failure with the reason instead of an invalid deck
