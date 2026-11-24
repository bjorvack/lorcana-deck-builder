# Design: deck-winrate-probability

## Context

`src/stats/goldfish.ts` ships `simulateRace(deck, byId, profileId, {trials, seed, maxTurns, onThePlay})` — a seeded, deterministic race simulator (used today by the generator's goldfish polish at 400 trials). The analysis panel (`src/ui/AnalysisPanel.tsx`) currently renders the meta-fit viability block from `metaAdjustedViability`. `simulateRace` is synchronous; 2,000 trials ≈ a few hundred ms on desktop hardware.

## Goals / Non-Goals

- Goals: an honest measured winrate probability per deck, async and non-blocking, cancellable on deck change, deterministic per deck, independent of the meta model.
- Non-Goals: no changes to `simulateRace` semantics or the generator; no matchup/lore-race chart changes; no new opponent profiles; no worker-thread infrastructure (chunked yields suffice at this trial count).

## Decisions

- **D1 — Chunked trials with yields.** 5 chunks × 400 trials; each chunk seeds
  `mulberry32(chunkSeed_i)` where `chunkSeed_i = fnv1a32(seedBase + ":" + i)`.
  Chunk boundaries do NOT continue a single rng stream — `simulateRace` draws a
  data-dependent number of values per trial, so stream-equivalent splitting is
  impossible without modifying the simulator (verified empirically: a single
  2,000-trial run and 5×400 chunks produce different tallies). The total is a
  pooled independent-batch estimate (5×400), not a 2,000-trial run;
  determinism per deck (the spec requirement) is preserved via the hash-mixed
  seeds. `await` a macrotask yield between chunks; check a run token before
  each chunk.
- **D2 — Run token cancellation.** Each estimate run gets an incrementing token; the panel compares the token after every chunk and aborts on mismatch. Guaranteed: a deck change abandons the run and no chunk of an abandoned run is ever rendered.
- **D3 — Deterministic seeding by deck signature.** Seed = FNV-1a of the deck signature string, so the same deck always yields the same estimate (spec: deterministic per deck); the per-chunk seeds in D1 derive from it.
- **D4 — Display swap, not removal of the panel.** The "Meta fit" section is replaced by a "Winrate" section: winrate %, Wilson 95% CI, trials, opponent profile name. Archetype match stays (it is informative and already degrades with stale artifacts). The viability decomposition disappears from the UI; `metaAdjustedViability` remains in the codebase only if other callers exist — otherwise it is deleted with its tests.
- **D5 — Profile choice.** `midrange` (the polish pass's baseline) as the default opponent; the profile name is displayed so users know what "winrate" means. Adding profile selection is a future change.

## Risks / Trade-offs

- [Losing the meta-alignment signal entirely] → intended by the user decision; the archetype match line still surfaces tournament evidence.
- [Estimate is vs a scripted baseline, not the human meta] → the section label says "Simulated winrate vs <profile>" to avoid overclaiming.
- [2,000-trial batch jank] → chunked yields keep the main thread responsive; measured chunk ≈ tens of ms.

## Open Questions

- None.
