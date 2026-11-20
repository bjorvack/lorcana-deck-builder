# Spec Delta

## MODIFIED Requirements

### Requirement: Share decks via URL
The app SHALL encode the current deck in the URL query parameter (`?d=`) and SHALL keep that parameter in sync on every deck change, such that the browser URL always reconstructs the current deck. A share URL opened in a fresh browser SHALL win over the locally saved deck on first load. The share action SHALL distribute the current URL, preferring the native share sheet and falling back to copying it to the clipboard.

#### Scenario: URL tracks deck changes
- **WHEN** the user edits the deck (cards, declared inks, format, or title)
- **THEN** the `?d` parameter is rewritten in place to encode the updated deck, and the back button does not step through individual edits

#### Scenario: Empty deck keeps a clean URL
- **WHEN** the deck is empty
- **THEN** the URL carries no `?d` parameter

#### Scenario: Shared URL opens deck
- **WHEN** a user opens a share URL in a fresh browser
- **THEN** the encoded deck is loaded and displayed, and edits made afterwards are reflected in the URL so a reload restores the deck including those edits

#### Scenario: Corrupt share payload falls back and self-heals
- **WHEN** the URL contains a `?d` value that does not decode to a deck
- **THEN** the locally saved deck is restored and the parameter is replaced with the encoding of that restored deck

#### Scenario: Share action fallback chain
- **WHEN** the user activates the share action
- **THEN** the native share sheet is used where the Web Share API is available; otherwise the current URL is copied to the clipboard; when both are unavailable the URL is displayed for manual copying
