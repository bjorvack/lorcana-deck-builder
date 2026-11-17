# Spec Delta

## Purpose
The deck-rules engine validates any deck against Disney Lorcana Core Constructed (and Infinity) legality, including the dataset-driven rule exceptions, and explains every violation.

## ADDED Requirements

### Requirement: Validate core deck constraints
The engine SHALL validate: minimum 60 cards; at most the declared two inks across all cards; every card's ink within the declared inks; and per-full-name copy limits (default 4) grouped across art variants and rarity reprints.

#### Scenario: Under 60 cards
- **WHEN** a deck contains 59 cards
- **THEN** validation fails with a card-count violation naming 59/60

#### Scenario: Copy limit default
- **WHEN** a deck contains 5 copies of a card with no copy-limit exception
- **THEN** validation fails naming the card and the 4-copy limit

#### Scenario: Copy limit exception honored
- **WHEN** a deck contains 20 copies of a card whose copy limit is 99, or any number of copies of an unlimited card
- **THEN** no copy-limit violation is reported

#### Scenario: Copies grouped across prints
- **WHEN** a deck contains 2 copies of a normal print and 3 copies of a special-rarity print of the same full name
- **THEN** validation treats them as 5 copies of one card against the 4-copy limit

### Requirement: Validate dual-ink cards
A dual-ink card SHALL be legal in a deck only when both of its inks are the deck's two declared inks.

#### Scenario: Dual-ink matches both declared inks
- **WHEN** the deck declares Amethyst/Sapphire and contains a dual Amethyst/Sapphire card
- **THEN** the card is valid

#### Scenario: Dual-ink partially matches
- **WHEN** the deck declares Ruby/Steel and contains a dual Amethyst/Sapphire card
- **THEN** validation fails naming the dual-ink card and the both-inks requirement

### Requirement: Validate format legality
The engine SHALL support Core and Infinity formats: Core excludes cards outside allowed Core sets, cards with a ban date, and Quest-set cards; Infinity excludes only explicitly banned cards.

#### Scenario: Quest card in Core deck
- **WHEN** a Core-format deck contains a card from an Illumineer's Quest set
- **THEN** validation fails naming the card as not tournament-legal in Core

#### Scenario: Banned card
- **WHEN** a deck contains a card with a ban date for the selected format
- **THEN** validation fails naming the card as banned

#### Scenario: Rotated set
- **WHEN** a Core-format deck contains a card from a set whose rotation date has passed
- **THEN** validation fails naming the card as rotated out of Core

### Requirement: Honor text-driven deck-rule exemptions
Card text that modifies a deck-building rule SHALL be honored via structured deck-rule effects carried on the card. The engine SHALL first collect active effects from cards in the deck, then apply them during validation.

#### Scenario: Ink exemption active
- **WHEN** the deck contains Christopher Robin - Hunny Sage and an Emerald Hunny character of any declared ink pair
- **THEN** that Hunny character passes ink validation while any other off-ink card still fails

#### Scenario: Ink exemption absent
- **WHEN** the deck does not contain Christopher Robin - Hunny Sage and contains an off-ink Hunny character
- **THEN** the Hunny character fails ink validation like any other off-ink card

#### Scenario: Exemption scope is exact
- **WHEN** the deck contains Christopher Robin - Hunny Sage and a Hunny item or location outside the declared inks
- **THEN** the item/location fails ink validation, because the exemption covers Hunny characters only

#### Scenario: The exempting card obeys its own restriction
- **WHEN** the deck contains Christopher Robin - Hunny Sage but the declared inks are not Amethyst and Sapphire
- **THEN** Christopher Robin fails validation as a dual-ink card whose inks are not both declared

### Requirement: Explain violations
Validation SHALL return structured violations (rule, affected cards, human-readable reason) that the UI can render as an actionable list.

#### Scenario: Multiple violations listed together
- **WHEN** a deck is under 60 cards, has an off-ink card, and an over-limit card
- **THEN** the result lists all three violations with the cards involved, not just the first
