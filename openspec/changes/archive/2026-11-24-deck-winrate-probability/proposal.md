# Proposal: deck-winrate-probability

## Why

The analysis panel currently shows a meta-fit viability score that requires the meta-model artifact and its calibration gate — an indirect, composition-derived number. The repo already ships a deterministic client-side simulator (`src/stats/goldfish.ts`, `simulateRace`) that plays actual games against baseline profiles. When a deck is completed, we can measure a **winrate probability** directly: run a seeded batch of simulated races, report the observed win rate with a confidence interval — asynchronously so the UI never blocks, restarting whenever the deck changes.

## What Changes

- **New async winrate estimator**: after a deck is completed (and whenever the deck changes), run a chunked batch of goldfish races (2,000 trials in 400-trial chunks, yields between chunks so the UI stays responsive), seeded deterministically by the deck's signature — the same deck always shows the same estimate.
- **Cancellable**: each estimate run carries a token; a deck change abandons the in-flight run (finished chunks are discarded, a fresh run starts) — no stale results are ever displayed.
- **Display swap**: the analysis panel's "Meta fit" section (viability score, sim/meta decomposition) is replaced by a "Winrate" section: observed wins/losses over trials, Wilson 95% confidence interval, opponent profile and trial count. The archetype-match line is kept.
- **Meta-model independence**: the winrate estimate requires no meta-model artifact and no calibration gate — it works identically without one. Other meta-model-driven displays (stale labeling, graceful degradation) are unchanged.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `deck-statistics` — gains the simulated winrate probability estimator (chunked, seeded, cancellable, deterministic per deck).
- `meta-model` — the meta-fit display requirement: the viability-score display is replaced by the simulated winrate probability display; archetype identification and graceful degradation are unchanged.

## Impact

- `src/stats/` — chunked cancellable race-batch runner around `simulateRace` (+ tests).
- `src/ui/AnalysisPanel.tsx` — section swap (winrate block replaces the viability block), async effect with cancellation (+ tests).
- No changes to `simulateRace` semantics, the generator, the meta-model artifact format, or other panels (fingerprint radar/matchup charts unchanged).
