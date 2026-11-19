# Tasks

## 1. One add path + auto-declared inks

- [x] 1.1 Make `addCard` in app state the single legality gate: run `canAddCard`, return its structured reason on refusal, auto-declare the card's ink(s) when the deck has 0 or 1 inks and the card needs them (D2/D3) — verify: unit tests for off-ink refusal from Browse-state, copy-limit refusal, and auto-declaration of first/second ink
- [x] 1.2 Wire every surface to the gated path: Browse modal add shows the refusal reason; deck search keeps `canAddCard` pre-filtering (unchanged behavior, same reason strings); suggestion add buttons surface refusals — verify: UI tests asserting identical reason text across surfaces for the same illegal add
- [x] 1.3 Deck view ink picker emits validation feedback when a user removes an ink that existing cards need (existing violations render — no new logic, verify only) — verify: removing an ink flags the off-ink cards in the violation list

## 2. Inkless generation (ink emergence)

- [x] 2.1 `GenerateOptions.inks` becomes optional (`inks?: Ink[]`, BREAKING): `undefined`/`[]` selects ink-emergent mode — verify: typecheck + existing call sites updated, no caller passes `[]` deliberately
- [x] 2.2 Implement viable-pair tracking in the suggest-fill loop: candidate pool per iteration = cards compatible with ≥ 1 surviving 2-ink pair; collapse to one pair → declare inks; result notes name the deciding cards — verify: unit tests for single-ink seed, dual-ink seed, and mixed emergence; deck passes full validation with derived inks
- [x] 2.3 Inkless determinism + options parity: same seed/slider reproduce identical decks; partial completion and relaxation work with 0 inks (candidates constrained by the partial deck's surviving pairs; thin-pool error path explains it) — verify: scripted determinism check + partial-deck test
- [x] 2.4 Generator UI: empty ink picker labeled "Auto — inks emerge from your cards"; result title uses the derived pair; notes show the ink decision — verify: UI test rendering Auto state and generating with no inks
- [x] 2.5 Two-ink representation: with 2 declared inks, an under-represented-ink needs boost plus a final completion pass guarantee cards of both inks in the result — verify: unit tests that a 2-ink generation on a two-ink pool contains both inks across seeds, including a relation pull favoring one color

## 3. Shared suggestions with payoff hints

- [x] 3.1 Extract a shared suggestion-row component (cost, inks, name, basis, score, add button) consumed by the deck view's suggestions panel — verify: existing suggestions tests pass against the shared component
- [x] 3.2 Payoff-completion hints on rows: derive "completes the Shift target for X" / "grants <keyword> to your X" lines from the candidate's `payoffs` against the deck — verify: unit test for shift-target and keyword-grant hint text; no hint when no payoff matches
- [x] 3.3 Deck-aware Browse strip: collapsed-by-default suggestion strip (same component) with the deck count pill as its toggle — verify: UI test toggling and adding from the strip; hidden with no artifact except payoff hints (snapshot-derived) — verify: hints render without a meta artifact

## 4. Archetype starter decks

- [x] 4.1 Starter-deck builder in the generator: archetype list (name, inks, sample size) from the calibration capability; picking one builds an editable deck from the centroid's highest-share cards (share floor, copy-limit caps, ~60 cards), declares the dominant inks, sets the archetype name as title — verify: unit test building a starter deck from a fixture centroid; zero copy-limit/off-ink/dual-ink violations
- [x] 4.2 Graceful absence: no archetypes → no starter-deck affordance; thin centroids → smaller but legal starter — verify: test with a relations-only fixture artifact
- [x] 4.3 From a starter deck, "fill the rest" runs the suggest-fill loop in completion mode — verify: e2e test cloning an archetype and completing to 60 legal cards

## 5. Verification

- [x] 5.1 Full suite green: `npm run typecheck && npm test`
- [x] 5.2 Cross-surface legality: the same illegal add is refused with the identical reason from Browse, deck search, and suggestions — scripted check
- [x] 5.3 Inkless end-to-end: generate with 0 inks across seeds/slider ends → legal decks, derived ink pairs match the cards, notes name the deciders — scripted check
- [x] 5.4 Performance: inkless generation stays < 1 s on the full pool (pair tracking adds no scoring cost) — timing assertion
