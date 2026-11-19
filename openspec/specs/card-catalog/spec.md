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
The app SHALL let the user add a card to the current deck (and increment its count) directly from the catalog, refusing to exceed the card's copy limit.

#### Scenario: Add beyond copy limit
- **WHEN** the user adds a card that already sits at its copy limit in the deck
- **THEN** the deck is unchanged and the limit is communicated
