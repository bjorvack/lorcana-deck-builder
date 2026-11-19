# Design

## Context

The suggest-fill generator (shipped in add-suggest-fill-generator) already picks one card at a time against an evolving deck; the ink requirement is a gate in front of it, not a property of it. Dreamborn — the dominant Lorcana builder — is card-first: inks derive from the cards you add, the pool and deck sit side-by-side, stats update live. Our own surfaces disagree on legality: the generator blocks without inks, the deck search pre-filters with `canAddCard`, and the app-level `addCard` (Browse modal) checks only copy limits, silently admitting off-ink cards.

## Goals / Non-Goals

**Goals:**
- One legality rule everywhere, enforced at the single add path
- Inks that emerge from card choices — both in generation and in manual building
- Suggestions (with payoff hints) visible wherever cards are shown
- Non-blank starting points from the trained archetypes

**Non-Goals:**
- Community deck sharing/accounts (out of app scope)
- Changing the trained artifact format (starter decks read existing centroids)
- Changing validation semantics (`validateDeck`/`canAddCard` rules stay as specified in deck-rules)
- Replacing the three-tab shell with a single-page builder in this change (see D5)

## Decisions

**D1 — Ink emergence as a pair-viability filter, not post-hoc inference.**
Inkless generation tracks the set of viable 2-ink pairs: all 15 pairs start viable; each pick keeps only pairs that cover every chosen card (a card's inks ⊆ the pair). The candidate pool per iteration is cards compatible with ≥ 1 surviving pair. When one pair survives, inks are decided and the deck declares them. This is a constraint over the existing loop — no new scoring, no rollback. Worst case (a dual-ink seed) collapses to one pair immediately. *Alternative:* infer inks after a free-form build and repaint the deck — rejected: it can invalidate late picks and produce surprises; constraining the pool keeps every pick legal at pick time.

**D2 — One add path in app state.**
`addCard` becomes the single legality gate: it runs the existing `canAddCard` check and returns the same structured reason on every surface; the Browse modal, deck search, and suggestion rows all consume it. Auto-declaration of inks lives here too: adding to a 0-ink deck declares the card's ink(s); adding a card needing a second ink declares it. *Alternative:* per-surface checks — rejected: three rules was the bug.

**D3 — Auto-declaration prefers strictness.**
When a card could be satisfied by either declaring a second ink or being refused, declare (the user picked the card; inks are derived, per card-first philosophy). The user can still remove inks in the picker, which then flags existing cards as off-ink via normal validation — the picker stays the source of truth once the user touches it deliberately.

**D4 — Suggestions as a shared component with payoff hints.**
Extract the suggestion row into a reusable component fed by the existing `suggestCards`, decorated with payoff-completion lines derived from `card.payoffs` + deck state ("completes the Shift target for Hiro Hamada"). Shown in the deck view (already) and as a deck-aware strip in Browse. Artifact-gated exactly as today — the payoff hints themselves are snapshot-derived and work without the artifact.

**D5 — Starter decks from centroids, generator-side.**
"Start from archetype" lives in the generator: pick an archetype from a list (name, inks, sample size), build an editable deck by taking the centroid's highest-share cards until ~60 (respecting copy limits, rounding within the limit), declare the archetype's dominant inks, and land in the deck view for adjustment. Centroids are share vectors over canonical ids; cards map through the canonical registry; shares below a floor (≤ 2 expected copies) are dropped so starter decks aren't 60 singletons. *Alternative:* a separate deck-library feature with saved decks — rejected for scope; the artifact already holds the data.

**D6 — Inkless UI: empty = auto.**
The generator's ink picker gains an explicit "Auto" state (the existing empty selection), labeled in the picker ("Auto — inks emerge from your cards"). The result title uses the derived pair. Callers of `generateDeck` passing `[]` migrate to `undefined` (BREAKING for programmatic callers only; the UI never passed `[]` deliberately).

**D7 — Two declared inks are both represented.**
With 2 inks declared, the loop adds an ink-representation deficit to the needs boosts: the ink with fewer (or zero) picked cards gets a scoring lift, so both inks are naturally represented without quota hard-caps; a final completion pass picks from the under-represented ink if the fill somehow ends mono-ink. The observable guarantee is spec-level ("both inks represented"); the boost-then-pass mechanism is a tunable here.

## Risks / Trade-offs

- [Pair-viability can strand the loop if the user's partial deck needs a third ink] → completion mode only admits candidates compatible with the partial deck's surviving pairs; if none exist, the existing "pool too small" error path explains it
- [Auto-declaration surprises users who wanted ink-first] → the picker remains editable; removing an ink shows the resulting off-ink violations immediately (existing validation)
- [Starter decks from centroids may be sparse] → share-floor + copy-limit rounding yields 55–60 cards for calibration-passing artifacts; a thinner artifact degrades to a smaller but still legal starter
- [Browse suggestion strip adds noise to a pure catalog] → collapsed by default behind the existing deck count pill; expands on demand

## Migration Plan

Ship order: state-level add path + auto-declaration (D2/D3) → generator inkless mode (D1/D6) → shared suggestions with payoff hints (D4) → starter decks (D5). Each step is independently shippable; the UI never passed `[]` to `generateDeck`, so the BREAKING option change lands safely in step 2. Rollback: any step reverts independently; no data migrations.

## Open Questions

- None blocking. Suggestion-strip placement in Browse (sidebar vs. row) is a tunable isolated to one component.
