# Proposal

## Why

Sharing currently requires pressing "Copy share link" to generate the URL on demand; the address bar never reflects the deck, so a URL copied from the browser is stale or deck-less, and the share flow is an extra step. Making the URL live-sync with the deck turns the address bar itself into the share affordance and simplifies the share button to copying the current URL.

## What Changes

- The `?d=` share parameter is rewritten (via `history.replaceState`, no history entries) whenever the deck changes, so the browser URL always encodes the current deck.
- The parameter is dropped when the deck is empty, keeping a clean URL for a fresh start; a corrupt incoming payload still falls back to the saved deck and is then self-healed by the next rewrite.
- The strip-on-load behavior is removed: a shared URL still wins over localStorage on first load, but the parameter now stays and tracks edits, so reloads restore deck + edits from the URL.
- The share button (stays in the Import/Export/Share panel) copies the live `window.location.href`, preferring `navigator.share` (native share sheet) with clipboard as fallback and the existing textarea fallback when both are unavailable.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `deck-persistence`: the "Share decks via URL" requirement changes from on-demand link generation to a live-synced URL parameter, with native share-sheet support on the share action.

## Impact

- `src/state.tsx`: remove strip-on-load; add URL-sync effect alongside the localStorage save effect.
- `src/ui/IoPanel.tsx`: simplify `share()` to distribute the current URL (share sheet → clipboard → textarea).
- `src/deck/codec.ts`: unchanged (`encodeDeck`/`decodeDeck` reused as-is).
- Tests: `src/state.test.tsx` semantics updated (param rewrite instead of strip); share-fallback paths covered.
