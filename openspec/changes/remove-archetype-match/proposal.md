# Proposal: remove-archetype-match

## Why

The deck analysis panel's archetype-match line (closest archetype, similarity %, observed tournament win rate) is removed entirely by product decision. The panel's winrate section already provides a measured simulated winrate; the archetype match adds a composition-derived tournament comparison that the user has opted out of. Archetype centroids remain in the meta-model artifact (the build pipeline is unchanged) — only the app-side display and its consumption are removed.

## What Changes

- **Remove the archetype match from the deck analysis panel**: the match line, the `identifyArchetype` consumption, and the calibration-gate note that exists solely for archetype matching ("Calibration gate not passed — archetype matching is unavailable.").
- **Remove `identifyArchetype` from `src/meta/infer.ts`** and its tests (the analysis panel was its only consumer); the calibration capability flag and centroids in the artifact are unchanged (build pipeline untouched).
- The panel no longer receives the meta model at all: the stale/data-through
  display went with the archetype-match plumbing. Suggestions keep their meta
  model; `isStale`/`snapshotDate` remain exported in `src/meta/infer.ts` for
  the artifact contract.
- **Spec delta**: `meta-model` — the "Archetype identification" requirement is removed (added by the deck-winrate-probability change, never shipped to users in this form).

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `meta-model` — the archetype-identification display requirement is removed.

## Impact

- `src/ui/AnalysisPanel.tsx` (match line + calibration note removed; the panel
  no longer takes a meta prop), `src/ui/DeckView.tsx`, `src/meta/infer.ts`
  (+ tests).
- The winrate section is untouched; the panel works identically with or without the meta model.
