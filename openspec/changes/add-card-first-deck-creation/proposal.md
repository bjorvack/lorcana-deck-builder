# Proposal

## Why

Deck creation is ink-first in every flow — the generator refuses to run without declared inks, the deck-view search gates on them, and the generator only replaces decks wholesale — while the category-leading Lorcana builder (Dreamborn) and the broader TCG UX research converge on card-first creation: start from cards you like, let the ink identity emerge, validate live, and suggest next additions everywhere. Our three creation surfaces also enforce three different legality rules (generator blocks; deck search gates; Browse adds silently illegal cards), which is both a UX inconsistency and a correctness gap.

## What Changes

- **Card-first generation without declared inks**: `GenerateOptions.inks` becomes optional; with 0 inks the suggest-fill loop starts with all 15 ink pairs viable and, one card at a time, constrains the candidate pool to cards compatible with at least one surviving pair until a single pair remains — the deck's 2 inks emerge from the cards. Result notes state which cards decided the inks.
- **Unified, legality-checked add path**: the app-level add action enforces `canAddCard` (format, copy limits, inks/exemptions) on every surface; Browse's modal add and the deck search stop bypassing ink rules, and illegal-add attempts get the same rejection reason everywhere.
- **Emerging inks in the deck view**: adding cards with 0 inks declared auto-declares the first ink(s); the ink picker stays editable and the count/validation feedback updates live.
- **Suggestions wherever cards are shown**: the fused-similarity suggestion row (with payoff-completion hints, e.g. "completes the Shift target for X") becomes a shared component used by the deck view and Browse, instead of living only in the analysis panel.
- **Archetype starter decks**: the trained archetype centroids become one-click starter decks ("clone and adjust") in the generator, giving beginners a non-blank starting point.
- **BREAKING**: `GenerateOptions.inks: Ink[]` (required array) becomes `inks?: Ink[]` with 0/undefined meaning "auto"; programmatic callers passing an empty array previously received an error and now receive a generated deck.

## Capabilities

### New Capabilities
- `card-first-creation`: ink-emergent deck construction — inkless generation with viable-ink-pair tracking, auto-declaration of inks from added cards, and ink identity that is derived from, not required by, card choices

### Modified Capabilities
- `deck-generation`: the ink requirement is replaced by optional/auto inks; partial-deck completion, legality, and the suggest-fill loop requirements are unchanged
- `card-catalog`: the add-card action now enforces the same legality check on every surface, and the catalog becomes deck-aware (legality-checked adds, deck-contextual filtering)
- `meta-model`: archetype centroids gain a user-facing role as one-click starter decks (display only; the artifact format is unchanged)
