# Proposal

## Why

Better deck generation needs to know which cards work together. The corpus
already holds canonicalized tournament decklists with win rates (TopDeck,
DotGG, Lorcanahunter), and the arena (M1) can validate decks — but nothing
turns that into a card-pair synergy signal the generator can consume. This
change mines **pair synergy** from tournament co-occurrence, weighted by deck
performance, and ships it as a third independently gated capability of the
meta-model artifact (same pattern as relations/calibration). It also builds
the M2 deck panel: real meta decks from the corpus, rendered arena-eligible,
plus a round-robin matchup batch runner so arena evidence exists for
downstream A/B gates.

## What Changes

- New `scripts/training/synergy-capability.ts`: win-rate-weighted pair lift
  with support shrinkage over the training split; temporal gate — selected
  pairs' mean holdout lift must beat random-pair lift (threshold mirrors the
  relations coherence gate); artifact payload is a compact per-card partner
  table (top partners, quantized lift scores).
- `train.ts` wires the third capability: gated publication, per-gate metrics
  in the artifact, three-way any-pass publication rule, report/rejected.json
  updates; `emit-model.ts` validation accepts the new capability flag.
- New `scripts/training/arena/panel.ts`: selects a deduplicated panel of
  arena-eligible meta decks from the corpus (recent era, win-rate ranked)
  and writes plain-text deck files + manifest.
- New `scripts/training/arena/batch.ts`: round-robin matchup batch over the
  panel with per-pair seeds, writing an aggregated matchup matrix.
- No app changes: `parseMetaModel` already drops unknown artifact fields;
  consuming `interactions` in the generator/suggest-fill is the follow-up
  change (`add-synergy-deck-generation`).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `meta-model`: the artifact MAY carry a third gated capability,
  `interactions` — a per-card partner table mined from tournament
  co-occurrence, published only when its temporal holdout gate passes.

## Impact

- `scripts/training/synergy-capability.ts`, `model-types.ts`, `train.ts`,
  `emit-model.ts`: capability wiring.
- `scripts/training/arena/{panel,batch}.ts`: panel + matchup batch.
- `scripts/training/output/meta-model.json` gains an `interactions` section
  when the gate passes; `public/data/meta-model.json` via emit-model.
- Arena fixture records for the panel matchups under
  `scripts/training/data/arena/`.
