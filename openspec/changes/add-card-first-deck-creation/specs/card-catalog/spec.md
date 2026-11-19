# Spec Delta

## Purpose
The add-card action enforces one legality check on every surface — Browse, deck search, suggestions — instead of each surface applying its own subset of rules. Illegal-add attempts are refused with the same explained reason everywhere.

## MODIFIED Requirements

### Requirement: Add cards to the deck from the catalog
The app SHALL let the user add a card to the current deck (and increment its count) from any surface, refusing — identically everywhere — any add that would violate format legality, per-full-name copy limits, or the two-ink rule (including dual-ink cards' both-inks requirement). Off-ink adds are refused with the off-ink reason rather than silently creating a violation. The same check SHALL back the deck view's search-to-add results, so only legal cards are offered.

#### Scenario: Add beyond copy limit
- **WHEN** the user adds a card that already sits at its copy limit in the deck
- **THEN** the deck is unchanged and the limit is communicated

#### Scenario: Off-ink add refused from the catalog
- **WHEN** the deck declares Ruby/Sapphire and the user adds an Amber card from the catalog
- **THEN** the deck is unchanged and the off-ink reason is communicated

#### Scenario: Search offers only legal cards
- **WHEN** the user searches in the deck view with declared inks Ruby/Sapphire
- **THEN** no off-ink, out-of-format, or copy-capped card appears as an addable result

#### Scenario: Same reason on every surface
- **WHEN** an add is refused on the catalog, in the deck view search, or from a suggestion
- **THEN** the communicated reason text is identical for the same rejection
