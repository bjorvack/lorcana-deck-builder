# card-catalog Specification

## Purpose
The card catalog lets users browse, filter, and inspect every Lorcana card in the bundled snapshot inside the web app.

## Requirements

### Requirement: Browse all cards from the bundled snapshot
The app SHALL load its entire card catalog from the bundled snapshot files without any runtime API call, and SHALL render cards with image, name, cost, ink(s), type, stats, set, and rarity.

#### Scenario: First load without network
- **WHEN** a user opens the app with no network access beyond the static host
- **THEN** the full card catalog loads and is browsable

### Requirement: Filter the catalog
The app SHALL filter cards by franchise, ink (including dual-ink cards matching either or both selected inks), set, card type, cost, rarity, mechanic/gameplay tags, and free-text name search, with filters combinable.

#### Scenario: Franchise filter
- **WHEN** the user selects franchise "Frozen"
- **THEN** only cards whose franchise is Frozen are listed

#### Scenario: Dual-ink in ink filter
- **WHEN** the user filters by ink Amethyst
- **THEN** dual-ink Amethyst/Sapphire cards appear alongside pure Amethyst cards

#### Scenario: Combined filters
- **WHEN** the user combines ink Ruby, type Character, and cost 3
- **THEN** only Ruby characters with cost 3 are listed and the shown count matches the filtered set

### Requirement: Card detail view
The app SHALL show a detail view per card with full text, keywords, stats, set/collection info, franchise, tags, copy limit, format legality, prices when present, and a larger image.

#### Scenario: Inspect a dual-ink card
- **WHEN** the user opens the detail view of a dual-ink card
- **THEN** both inks and the dual-ink deck-building restriction (both inks must be the deck's two declared inks) are displayed

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
