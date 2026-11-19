# card-first-creation Specification

## Purpose
Card-first deck construction: the ink identity of a deck is derived from the cards chosen rather than declared up front. The generator can build a complete deck from zero declared inks (ink-emergent generation), and manually added cards auto-declare the deck's inks as they arrive — one card at a time until the deck has its 2 inks.

## Requirements

### Requirement: Inkless generation derives inks from cards
The generator SHALL produce a complete legal deck when no inks are selected. Generation SHALL proceed one card at a time: every candidate considered must be compatible with at least one viable 2-ink pair that still covers all cards already chosen; when exactly one viable pair remains, the deck's inks are decided. The completed deck SHALL declare the surviving pair and pass full validation.

#### Scenario: Inks emerge from the first cards
- **WHEN** generation starts with no inks and the seed card is a single-ink Ruby card
- **THEN** every subsequent pick is Amber/Ruby-compatible with Ruby, or introduces at most one additional ink, and the finished deck declares exactly the inks its cards require

#### Scenario: Dual-ink seed pins both inks
- **WHEN** the seed card is dual-ink Amethyst/Sapphire
- **THEN** the viable pair collapses to Amethyst/Sapphire immediately and the whole deck fits that pair

#### Scenario: Result explains the ink decision
- **WHEN** an inkless generation completes
- **THEN** the result notes state which cards decided the inks

#### Scenario: Inkless deck passes validation
- **WHEN** the generator runs with no inks selected on the full pool
- **THEN** the result passes full validation with zero violations

### Requirement: Slider and options unchanged in inkless mode
Inkless generation SHALL honor the same novelty slider, seed determinism, partial-deck completion, copy limits, and relaxation behavior as ink-declared generation.

#### Scenario: Same seed reproduces the inkless deck
- **WHEN** the same seed, slider position, and empty ink selection run twice
- **THEN** both runs produce identical decks, inks included

### Requirement: Adding cards auto-declares inks
When the deck has no inks declared and the user adds a card, the app SHALL auto-declare that card's ink (both for dual-ink cards). When one ink is declared and a card requires a second, the app SHALL auto-declare the second ink. Auto-declaration SHALL keep the deck within the two-ink rule and be reflected immediately in the ink picker.

#### Scenario: First card declares its ink
- **WHEN** the deck has no inks and the user adds a Ruby card
- **THEN** Ruby becomes declared and the card is valid

#### Scenario: Second ink emerges
- **WHEN** the deck declares only Ruby and the user adds a Sapphire card
- **THEN** Sapphire joins the declared inks and the card is valid

#### Scenario: Third ink is refused
- **WHEN** the deck declares Ruby/Sapphire and the user adds an Amber card from any surface
- **THEN** the add is refused with the off-ink reason and the deck is unchanged
