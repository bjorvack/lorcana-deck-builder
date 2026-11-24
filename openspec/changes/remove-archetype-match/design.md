# Design: remove-archetype-match

## Context

After the deck-winrate-probability change, the analysis panel's Winrate section
still renders an archetype-match line (`identifyArchetype` → closest archetype,
similarity, observed tournament win rate) gated on the calibration capability,
plus a calibration-unavailable note. The user has opted out of the archetype
comparison entirely.

## Goals / Non-Goals

- Goals: no archetype-match UI anywhere in the deck analysis; no dead code.
- Non-Goals: no changes to the meta-model artifact format or build pipeline
  (centroids stay in the artifact); no changes to the winrate section, the
  fingerprint charts, or the artifact's graceful-degradation parsing
  behaviors.

## Decisions

- **D1 — Remove display + consumption, not the artifact.** The match line, the
  calibration-gate note (which exists solely for archetype matching), the
  `identifyArchetype` consumption in the panel, and the now-dead
  `identifyArchetype` function in `src/meta/infer.ts` (+ its tests) are
  removed. The artifact's centroids and the build pipeline are untouched — the
  data remains available offline via the training pipeline.
- **D2 — Provenance display goes with the meta prop.** The stale-data span and
  data-through display lived inside the panel's meta plumbing; with the match
  removed the panel no longer receives the meta model at all, so no provenance
  UI remains. `isStale`/`snapshotDate` stay exported from `src/meta/infer.ts`
  (artifact-currency contract, still tested — same "for future consumers"
  policy as the text-space primitives).
- **D3 — Meta-model loading stays for suggestions.** DeckView still loads the
  artifact for `SuggestionsPanel`; the analysis panel itself is
  meta-model-independent. Removing the suggestions' meta dependency is out of
  scope.

## Risks / Trade-offs

- [Users lose the archetype comparison] → intended by the product decision;
  the offline training reports remain the source for archetype evidence.

## Open Questions

- None.
