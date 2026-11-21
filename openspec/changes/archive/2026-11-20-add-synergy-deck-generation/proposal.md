# Proposal

## Why

The interactions capability ships trained card-pair synergy (7,041 pairs,
temporal-gate validated), but nothing consumes it: suggestions and the
generator rank candidates by relation+text similarity only. This change
blends the trained partner signal into candidate scoring — the first product
use of the arena-trained data — and proves it helps with the arena A/B gate
from the roadmap: matched decks generated with and without synergy, played
against the meta panel.

## What Changes

- `src/meta/infer.ts`: the client parser carries the `interactions` payload
  (validated, per-field degradation — a corrupt table never sinks other
  capabilities; an interactions-only artifact is now acceptable).
- `src/meta/score.ts`: `ScoringContext` carries the partner table; new
  `deckIdentityIds` / `deckSynergyEdges` / `synergyScore` — a candidate's
  synergy with the deck from both evidence directions (its own list naming a
  deck card, or a deck card's list naming it), normalized 0–1.
- `src/generate/suggest-fill.ts`: the candidate's synergy blends into the
  similarity portion at a fixed 0.25 share before curve pressure. Absent
  capability → term skipped → scores byte-identical to before.
- New `scripts/training/arena/ab.ts`: matched-variant A/B harness (same
  seeds/inks per pair, only the scoring differs) playing both variants
  against the meta panel with seat-balanced games; PASS = positive 95% CI
  lower bound on the uplift.
- No UI changes: the suggestion panel and generator improve through the
  shared scoring path.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `suggest-fill-generation`: suggestions consume the interactions capability
  when present (synergy blend, graceful degradation without it).
- `meta-model`: the client parser accepts the interactions payload.

## Impact

- `src/meta/{infer,score}.ts`, `src/generate/suggest-fill.ts`: scoring.
- `scripts/training/arena/ab.ts`: A/B harness + report.
- Tests: parser validation, synergy lookup, suggest-fill behavior
  (boost + invariance), A/B aggregation.
