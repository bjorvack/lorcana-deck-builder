# Tasks

## 1. Removal

- [x] 1.1 Remove the archetype match from `src/ui/AnalysisPanel.tsx`: the `identifyArchetype` import + `match` memo, the match paragraph, the calibration-unavailable note, and the meta-prop/stale-span plumbing (the panel becomes meta-model-independent)
- [x] 1.2 Remove `identifyArchetype` (+ its result type if distinct) from `src/meta/infer.ts` and its archetype tests in `infer.test.ts` (verify no remaining callers); update panel tests (archetype-match assertions removed, calibration-note assertions removed)

## 2. Checks

- [x] 2.1 Full checks: `npm run typecheck && npm run lint && npm test` clean

## Workflow follow-up

- Orchestrator: commit, PR, CI, merge, archive.
