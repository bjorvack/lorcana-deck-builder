# Tasks: engine-winrate

## 1. Bundle

- [x] 1.1 Bundle entry (`engine-bundle-entry.ts`): wrapper API (`createGame`,
      deterministic re-keying, seed-derived first player, per-turn log with
      card names, commit/strategy/attribution exports), browser-safe.
- [x] 1.2 Builder (`build-engine-bundle.ts` + `engine:bundle`): esbuild ESM
      bundle with pin provenance + identity map defines, stale-bundle
      removal, `engine-bundle.json` sidecar; `esbuild` declared in
      devDependencies.
- [x] 1.3 Bundle test: committed artifact matches PIN.md + opponents
      artifact, valid ESM, deterministic game replay.

## 2. Opponents

- [x] 2.1 Exporter (`export-winrate-opponents.ts`): 4 real held-out league
      members, 60-card + mapping validation, inks resolved from the catalog.
- [x] 2.2 Commit `public/data/winrate-opponents.json` and the built bundle.

## 3. Estimator

- [x] 3.1 `src/stats/engine-winrate.ts`: pre-committed 64-game schedule
      (seat-alternating, signature-seeded), batched play with yields + run
      token + progress, Wilson CI, per-game logs, injectable
      `playGame`/`opponents`, lazy cached bundle import.
- [x] 3.2 Estimator tests: determinism, seat alternation, budget shape,
      progress steps, yield count, cancellation (mid-run + pre-aborted),
      thrown-game voiding, empty deck/pool, bundle-path loading, Wilson
      math, schedule seeds.

## 4. Panel

- [x] 4.1 `src/ui/EngineWinrateSection.tsx`: loader with X/64 progress,
      estimate + Wilson CI + game count, review disclosure with per-game
      turn logs, unavailable state, signature-keyed cancellation.
- [x] 4.2 `src/ui/DeckView.tsx`: render the section above the validity
      check for legal decks; section + ordering tests (and
      `AnalysisPanel.tsx` loses the old winrate block).

## 5. Removal

- [x] 5.1 Delete `src/stats/winrate-estimate.ts` + its test; move Wilson
      interval / fnv1a32 / deckSignature into the engine estimator; update
      the analysis-panel test (winrate mock + section assertion).

## 6. Spec + gates

- [x] 6.1 Spec deltas (training-arena ADDED, deck-statistics MODIFIED) and
      `openspec validate engine-winrate --strict` clean.
- [x] 6.2 `npm run typecheck && npm run lint && npm test` clean; arena
      typecheck program clean; `engine-bundle.test.ts` green.
