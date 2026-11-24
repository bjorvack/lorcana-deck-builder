# Design: simplify-generator-page

## Context

`src/ui/GeneratorView.tsx` carries four creation affordances: fresh generation,
complete-current-cards toggle, the archetype-starter section (dropdown +
"Open starter deck" + "Open + fill to 60" via `buildStarterDeck`), and the
goldfish polish checkbox (`polish` → `polishDeck` in `suggest-fill.ts:710+`).
Two SHALL requirements mandate the starter flow and the polish pass — this
change removes both via spec deltas. The schema-2 learned completion model
(live) covers fill quality; the analysis panel covers archetype evidence and
now a measured winrate probability.

## Goals / Non-Goals

- Goals: generator page = two paths only (fresh 60 / complete current);
  remove starter UI + polish UI + `polishDeck`; delete orphaned code
  (`src/generate/starter.ts` if no other callers) and their tests.
- Non-Goals: no changes to the learned model wiring, chaos mode, filters,
  novelty slider, seed handling, the analysis panel (separate change in
  flight), or `src/stats/goldfish.ts` (the winrate estimator uses it).

## Decisions

- **D1 — UI removal with spec deltas.** The starter section and polish toggle
  are removed from `GeneratorView`; `generateDeck`'s `polish` option and
  `suggest-fill.ts`'s polish pass are deleted (dead code after UI removal —
  no other callers per grep). `buildStarterDeck`/`starter.ts` deleted if
  `starter.test.ts` is its only remaining consumer.
- **D2 — Spec deltas carry the product decision.** `meta-model` starter-deck
  requirement REMOVED (with migration note: archetype evidence remains in the
  analysis panel), `suggest-fill-generation` polish requirement REMOVED and
  replaced by an "always interactive" requirement.

## Risks / Trade-offs

- [Archetype starter users lose their entry point] → archetype match remains
  in the analysis panel; import/export flows unchanged.
- [Fill-quality regression without polish] → the learned completion model
  (SHIPPED, holdout 0.6863) is the fill-quality mechanism now; the winrate
  estimator measures outcomes after the fact instead of hill-climbing before.

## Open Questions

- None.
