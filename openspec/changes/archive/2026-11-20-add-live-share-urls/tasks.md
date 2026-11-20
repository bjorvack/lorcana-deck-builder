# Tasks

## 1. Live URL sync in state

- [x] 1.1 Remove the strip-on-load block from `src/state.tsx` (keep shared-URL-wins restore and corrupt-payload fallback) and verify existing `state.test.tsx` failures match only the changed expectations
- [x] 1.2 Add the URL-sync effect (`encodeDeck` target, empty-deck → no param, no-op guard, `history.replaceState` preserving pathname/params/hash) and verify `state.test.tsx`: param tracks edits, empty deck clears the param, corrupt payload is rewritten to the restored deck's encoding, back button does not step through edits
- [x] 1.3 Update the two shared-link tests in `src/state.test.tsx` ("wins over localStorage, param stays", "edits survive reload" asserting the URL encodes the edited title) and verify `npx vitest run src/state.test.tsx` passes

## 2. Share action fallback chain

- [x] 2.1 Rewrite `share()` in `src/ui/IoPanel.tsx` to distribute `window.location.href` via `navigator.share` (swallow `AbortError`) → clipboard → existing textarea fallback, dropping the hand-built URL, and verify IoPanel/DeckView tests cover: share-sheet used when available, clipboard copy otherwise, textarea shown when both unavailable

## 3. Full verification

- [x] 3.1 Run `npm test`, `npm run typecheck`, and `npm run build`; all green with coverage thresholds intact
- [x] 3.2 Manual check with `npm run dev`: add cards → `?d=` appears and updates; empty deck → no param; open the copied link in a fresh profile → deck loads, reload keeps edits; share sheet on a mobile device or emulation
