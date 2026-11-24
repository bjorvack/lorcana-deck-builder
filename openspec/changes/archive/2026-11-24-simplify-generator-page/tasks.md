# Tasks

## 1. Removals

- [x] 1.1 Remove the archetype-starter section from `src/ui/GeneratorView.tsx` (dropdown, "Open starter deck", "Open + fill to 60", `openStarterAndFill` handler, archetype state) and the goldfish polish checkbox (`polish` state + prop); the page keeps exactly: inks, format, franchises, sets, novelty, seed, complete-current toggle, generate button; verify with a render test that the removed controls are gone and both remaining paths work
- [x] 1.2 Remove `polishDeck` + the `polish` option from `src/generate/suggest-fill.ts`/`generator.ts` and delete `src/generate/starter.ts` + `starter.test.ts` (verify no other callers first); update/remove affected tests; verify `simulateRace`/`goldfish.ts` stays (winrate estimator uses it)

## 2. Checks

- [x] 2.1 Full checks: `npm run typecheck && npm run lint && npm test` clean; verify src/ui and src/generate coverage thresholds hold

## Workflow follow-up

- Orchestrator: commit, PR, CI, merge (sequenced after the deck-winrate-probability PR to avoid AnalysisPanel/GeneratorView merge friction).
