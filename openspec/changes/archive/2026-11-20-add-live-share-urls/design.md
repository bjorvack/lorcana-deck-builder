# Design

## Context

Deck state lives in `AppProvider` (`src/state.tsx`): one `deck` state, persisted to localStorage in a `useEffect`. On load, a `?d=` param currently wins over localStorage and is then stripped via `history.replaceState` (`src/state.tsx:73-88`) so later edits are not clobbered on reload — a workaround that live sync makes unnecessary. The share button in `src/ui/IoPanel.tsx` builds the URL on demand (`encodeDeck` + forced `#/deck`) and copies it, with a textarea fallback when the clipboard API is unavailable. `encodeDeck`/`decodeDeck` (`src/deck/codec.ts:144-179`) are base64url JSON, UTF-8-safe, and stay unchanged.

## Goals / Non-Goals

**Goals:**
- Browser URL always encodes the current deck, without history spam.
- Share action distributes the live URL with a native share sheet on mobile.
- Remove the strip-on-load workaround; corrupt payloads self-heal.

**Non-Goals:**
- No changes to the codec, text import/export, or localStorage semantics.
- No deck-permalink service, shortening, or analytics.
- No history entries per edit (`pushState` is explicitly not used).

## Decisions

- **Sync effect alongside the save effect, not inside the mutators.** One `useEffect` on `[deck, status]` covers every mutation path (browse, deck page, generator, import) without touching each. Alternative — rewriting the URL in each mutator — scatters the concern and misses paths.
- **`history.replaceState` with a no-op guard.** Read the current `?d`, compute `encodeDeck(deck)` (target `''` when the deck encodes identically to `emptyDeck()`); skip the rewrite when they match. This collapses the initial-load case (shared link already matches) and repeated renders. Alternative — tracking the last value in a ref — is redundant when the URL itself is the source of truth.
- **Empty means "encodes like `emptyDeck()`", not "no cards".** A custom title on an otherwise empty deck still deserves a URL; comparing encodings avoids a second, drifting definition of empty.
- **Keep the "shared URL wins over localStorage" first-load rule.** With live sync, URL and localStorage stay in lockstep, so this only matters when they can disagree: corrupt payload (falls back to saved, then the rewrite heals the param) and localStorage write failures (URL remains the truth).
- **Share chain: `navigator.share` → clipboard → textarea.** `navigator.share` is called only from the click handler (user gesture); `AbortError` from a dismissed sheet is swallowed, any other share failure falls through to clipboard, and the existing textarea fallback survives for non-secure origins. Drop the forced `#/deck` — the IoPanel only renders on the deck page, so `location.href` already carries the right hash.
- **jsdom testing.** jsdom implements `history.replaceState` and `URLSearchParams`, so URL-sync tests assert on `window.location.search` directly; `navigator.share` is stubbed per test.

## Risks / Trade-offs

- [URL length for maximal decks (99-copy exceptions, many distinct cards)] → compact encoding keeps a full deck around ~1KB; well under browser and share-sheet limits. No action.
- [Live URL exposes deck contents in the address bar (shoulder-surfing, referrer-like leakage)] → same exposure as the existing share links; no server is involved. Accepted.
- [`replaceState` on every keystroke of the title input] → no-op guard skips unchanged encodings; `replaceState` itself is cheap. Accepted.
- [Old links with a stale `?d` plus a newer localStorage deck] → unchanged precedence: URL wins once, then tracks edits. Matches current documented behavior.

## Migration Plan

Single deploy; no data migration. Old share links keep decoding (codec untouched). Rollback is a revert.

## Open Questions

(none)
