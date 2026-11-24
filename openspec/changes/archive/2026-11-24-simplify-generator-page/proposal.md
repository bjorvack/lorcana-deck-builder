# Proposal: simplify-generator-page

## Why

The generator page has accumulated three flows that duplicate or complicate the core job: build a 60-card deck from scratch, or complete the user's current cards. The archetype-starter flow (dropdown + two buttons) duplicates what the analysis panel already surfaces as evidence, and the opt-in goldfish polish is a slow hill-climb that complicates the generation contract. The learned completion model (schema-2, live) has made the heuristic starter scaffolding unnecessary for the primary flows.

## What Changes

- **Remove the archetype-starter flow** from the generator page: the "Start from an archetype" section (dropdown, "Open starter deck", "Open + fill to 60") and its handlers are removed. The page keeps exactly two paths: generate a fresh 60-card deck, or complete the current cards (existing toggle).
- **Remove the goldfish polish option** from the generator page and the `polishDeck` hill-climb from the suggest-fill module (`simulateRace`/goldfish stays — the analysis panel's winrate estimator uses it).
- **Spec deltas**: `meta-model` starter-deck requirement removed (the archetype evidence remains visible in the analysis panel's archetype match); `suggest-fill-generation` polish requirement removed.
- Untouched: inks, format, franchise/set filters, novelty slider, seed, learned completion model wiring, chaos mode, the analysis panel's archetype match and winrate sections.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `meta-model` — the one-click archetype starter-deck requirement is removed (archetype evidence remains in the analysis panel).
- `suggest-fill-generation` — the opt-in goldfish polish requirement is removed.

## Impact

- `src/ui/GeneratorView.tsx` (section + handlers removed), `src/generate/suggest-fill.ts` (polish pass removed), `src/generate/starter.ts` (+ tests — deleted if no other callers), specs as above.
- Risk: users who relied on archetype starters lose that entry point — mitigated by the analysis panel's archetype match (which names the archetype and its observed win rate) and by keeping deck import/export flows unchanged.
