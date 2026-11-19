# Spec Delta

## Purpose
Declared inks become optional input to generation: 0 inks means "derive them from the cards" (see card-first-creation). All other generation requirements — legality, partial completion, relaxation, and the suggest-fill loop — are unchanged.

## MODIFIED Requirements

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
