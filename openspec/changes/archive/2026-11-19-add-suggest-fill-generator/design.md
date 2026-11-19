# Design

## Context

The generator (`src/generate/generator.ts`) fills decks by a static `smartScore` heuristic; the suggestion engine (`src/meta/infer.ts`) computes fused relation+text scores against a deck but is only used by the panel. The dot.gg backfill (in flight) plus the text-reference training already shipped give the corpus depth; the payoff audit (3,583 cards scanned) established the rule patterns and the six override cases. Ruling research settled the special-shift semantics (dual-name rule 5.2.6.1, variants 8.10.8.x, non-ink shift costs).

## Goals / Non-Goals

**Goals:**
- One scoring path shared by the suggestion panel and the generator (identical similarity components)
- Deterministic, seeded, fast generation (no race simulator unless asked)
- Novelty as a first-class, slider-controlled dimension backed by per-card playrate data
- Payoff semantics data-defined (pattern rules + overrides), matching official rulings

**Non-Goals:**
- Full game-state simulation of effect interactions (goldfish race stays a coarse tempo model)
- Server-side anything (all client-side, consistent with the app)
- Changing suggestion-panel behavior or its top-8 presentation
- Re-training cadence changes (weekly pipeline unchanged)

## Decisions

**D1 — One shared scoring module; the generator consumes it per-iteration.**
Extract the scoring primitives (relation vectors, text vectors, cosine, legality filters) so both `suggestCards` and the generator call the same functions; the generator rescoring the pool each pick costs ~60 × 2k × dim-120 dot products (tens of ms). *Alternative:* generator calling `suggestCards` (top-8) — rejected: the loop needs the full ranked pool and per-candidate components.

**D2 — Payoff layer mirrors `deckRuleEffects`: rules + overrides + report.**
Pattern rules live in `scripts/tag-rules.json` (new `payoffRules` section); manual patches in `scripts/deck-rule-overrides.json`; the normalize step emits a typed `payoffs` array per card into the snapshot; unparseable shift-like text lands in the existing `needsReview` report. Extracted shift semantics follow the rulings: dual-named characters satisfy each component name (5.2.6.1); Duo = two distinct characters (a dual-named counts once); Combo = either/both; MIMICRY = universal target except Classification Shift; Potato targets items; Temporary returns to hand; costs can be ink / discard / ink-drop removal. *Alternative:* hard-code case logic per card — rejected: every new set would need a code change.

**D3 — Copy policy from trained data, capped by rules.**
The trainer already holds per-card copy counts; it emits playrate (byte) and typical copies (1–4, byte) maps. The pick loop biases toward deepening a card toward its typical copies with decreasing probability per added copy ( geometric-ish), so decks land at realistic multiplicities without a rigid template. Uniques/`maxCopies` hard-cap. *Alternative:* fixed 4-of template for "core" cards — rejected: it would copy meta deck structure, exactly what novelty must avoid.

**D4 — Slider scales three weights, one knob.**
`novelty` ∈ [0,1] from the slider maps to: seed weight `playrate^(2−2·novelty)` vs `playrate^−novelty`-style exponent interpolation, candidate boost `(1−novelty)·w_meta + novelty·w_novel`, and temperature `0.3 + 0.9·novelty`. Exact curves are tunables in one place; the spec fixes only the endpoints' observable behavior. Relation-vs-text fusion weights stay at 0.6/0.4 at the meta end and shift toward text at the novel end (text space is data-independent).

**D5 — Shared text extraction moves to `src/text/refs.ts`.**
`extractNameReferences` + the new payoff extraction live in one client-safe module; the trainer imports it (same one-implementation philosophy as `canonical.ts`). Trainer-side synthetic text-ref decks can later use typed payoffs (non-blocking follow-up).

**D6 — Model version tolerance, not migration.**
`parseMetaModel` accepts `'2'` and `'3'`; missing maps → neutral weighting. No migration step; the next weekly train ships `'3'`.

## Risks / Trade-offs

- [Fusion toward text space at the novel end can recommend samey stat-sticks] → needs boosts + diversity rule (no pick from the same suggestion source twice in a row) keep texture; slider is user-controlled anyway
- [Payoff regexes lag new sets] → needsReview report path catches unparseable shift-like text; overrides are data-only fixes
- [Goldfish polish runtime on weak devices] → off by default; bounded swap count (K ≤ 20, single race per candidate)
- [Playrate map biases novel decks toward obscurity with no playtest signal] → novelty is user-selected; the panel still shows each pick's basis
- [Snapshot grows with payoffs] → typed arrays are small (~1k payoffs × ~40 bytes); inside the emit gate

## Migration Plan

Ship order: trainer/emit (`'3'` + maps) → shared `src/text/refs.ts` + payoff pipeline → generator loop behind the existing UI → panel info line. Generator remains functional before the next artifact refresh (D6 fallback). Rollback: revert the generator UI entry point; payoff data in snapshots is inert.

## Open Questions

- None blocking. Exact slider weight curves are tunables isolated behind the slider mapping (D4).
