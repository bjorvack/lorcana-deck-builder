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

### Requirement: Relax set-only constraints gracefully
When the allowed pool cannot fill the deck, the generator SHALL progressively relax optional set-code restrictions and then report failure, but it SHALL NOT relax a selected franchise.

#### Scenario: Too-small set pool
- **WHEN** the chosen set pool has fewer than 60 eligible cards
- **THEN** the generator expands to the full pool of the chosen inks (keeping any franchise restriction), states this in the result, and still produces a legal deck

#### Scenario: Too-small franchise pool
- **WHEN** the chosen franchise pool has fewer than 60 eligible cards
- **THEN** the generator reports failure with a reason that names the selected franchise and does not silently fall back to unrelated cards

#### Scenario: Impossible request
- **WHEN** even the relaxed pool cannot produce a legal deck
- **THEN** the generator reports failure with the reason instead of an invalid deck

### Requirement: Show franchise unique-card availability
The generator and deck-statistics views SHALL display, for each franchise, the number of unique full-name cards available under the selected format and inks, accounting for card effects that exempt off-ink cards.

#### Scenario: Franchise dropdown shows pool size
- **WHEN** the user opens the franchise filter dropdown in the generator
- **THEN** each franchise option includes the count of unique full-name cards matching the selected format and inks

#### Scenario: Deck stats show franchise availability
- **WHEN** the user views the Franchises insight tab in the deck statistics
- **THEN** each franchise bar is labelled with the deck's copy count and the number of unique full-name cards available in the current format and inks

#### Scenario: Hunny Sage expands availability
- **WHEN** Christopher Robin - Hunny Sage is selected and the deck includes the Amethyst/Sapphire inks
- **THEN** Hunny characters outside those inks are still counted as available, but dual-ink cards missing a declared ink remain excluded

### Requirement: Learned completion in smart mode

When the learned completion model artifact exists and passed its A/B gate,
smart mode SHALL fill decks via the learned completion source (masked set-model
scoring over the current partial deck) followed by the existing needs-boost and
local-search refinement; otherwise it SHALL use the shipped suggest-fill fill.
Both paths SHALL produce fully legal 60-card decks, and the active completion
source SHALL be observable in generator debug output.

#### Scenario: Learned fill is used when gated in

WHEN smart mode runs with a valid, gate-passed model artifact
THEN the debug output names the learned completion source and the finished deck
is a legal 60-card deck.

#### Scenario: Shipped fill is used otherwise

WHEN smart mode runs without a valid or gate-passed model artifact
THEN the debug output names the shipped suggest-fill source and generation
succeeds identically to before.
