# deck-persistence Specification

## Purpose
Decks survive page reloads and can travel: local persistence, plain-text import/export, and shareable URLs.

## Requirements

### Requirement: Persist the current deck locally
The app SHALL save the current deck (including declared inks and format) to localStorage on every change and restore it on load.

#### Scenario: Reload keeps deck
- **WHEN** the user edits a deck and reloads the page
- **THEN** the deck, declared inks, and format are restored exactly

### Requirement: Import and export plain-text decks
The app SHALL export a deck as plain text lines of `COUNTx Card Full Name` and import such lists, matching card names against the snapshot case-insensitively and reporting unmatched lines.

#### Scenario: Export then import round-trip
- **WHEN** a deck is exported and the text is re-imported
- **THEN** the imported deck is identical to the exported one

#### Scenario: Unknown card on import
- **WHEN** an imported list contains a line matching no card in the snapshot
- **THEN** the deck is imported without that line and the unmatched line is reported

### Requirement: Share decks via URL
The app SHALL encode the current deck in the URL query string such that opening the URL reconstructs the deck, and SHALL offer a copyable share link.

#### Scenario: Shared URL opens deck
- **WHEN** a user opens a share URL in a fresh browser
- **THEN** the encoded deck is loaded and displayed; the shared link survives reloads
