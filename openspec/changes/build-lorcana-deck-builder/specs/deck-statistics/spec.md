# Spec Delta

## Purpose
Deck statistics turn any card set (current deck or filtered catalog pool) into the numbers players use to judge a build.

## ADDED Requirements

### Requirement: Compute core deck statistics
For any deck or filtered pool the app SHALL compute: total card count; inkability percentage (cards with the inkwell icon) overall and per cost value; ink color distribution; cost distribution; card-type distribution; rarity distribution; franchise distribution; and average strength/willpower/lore over characters.

#### Scenario: Inkability split
- **WHEN** statistics are computed for a 60-card deck where 24 cards are inkable
- **THEN** inkability is reported as 24 cards (40%) with a per-cost breakdown available

#### Scenario: Cost curve
- **WHEN** statistics are computed for a deck
- **THEN** the cost distribution shows, for each cost value present, how many cards are inkable versus not

### Requirement: Compute tag distribution
The app SHALL compute counts per mechanic/gameplay tag (e.g. removal, draw, ramp) for any deck or filtered pool.

#### Scenario: Removal count in a deck
- **WHEN** a deck contains 6 cards tagged removal
- **THEN** the statistics show removal: 6 (counting card copies)

### Requirement: Statistics update live
The app SHALL recompute statistics whenever the deck changes and display them alongside the deck.

#### Scenario: Add a card
- **WHEN** the user adds a copy of a card to the deck
- **THEN** all affected statistics (count, curve, inks, types, tags) update without a manual refresh
