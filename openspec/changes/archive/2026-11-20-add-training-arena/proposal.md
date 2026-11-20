# Proposal

## Why

Deck quality is currently scored by a one-sided goldfish race against scripted
baselines (`src/stats/goldfish.ts`) — it cannot represent interaction, defense,
or card synergy, so the generator cannot learn which cards work together. An
offline AI-vs-AI arena on an open-source rules engine (TheCardGoat
`tcg-engines`, MIT) gives a reproducible two-sided evaluator and a game-log
corpus to mine card interactions from — the validator foundation for better
deck generation (see `scripts/training/ROADMAP.md`).

A spike on 2026-11-20 (upstream pin `6de59de1`) verified feasibility on our
stack: full AI-vs-AI games run headless under Node + tsx at ~4 games/s,
deterministic once card instance ids are keyed deterministically, with zero
execution errors across 20 games.

## What Changes

- Vendor the TheCardGoat lorcana engine (pinned commit, minimal subset) under
  `scripts/training/vendor/` and map our lorcanajson card IDs to the engine's
  canonical IDs (`set{code}-{number}` join with lorcast external-ID fallback),
  with mapping coverage reported.
- Add a headless arena runner (`scripts/training/arena/`): two automated
  seats, selectable per-seat strategy, seeded, deterministic instance-id
  keying, batch CLI emitting JSONL game records to
  `scripts/training/data/arena/` with per-matchup caching keyed by (deckA,
  deckB, seeds, strategy pair, engine version).
- Add an explicit engine-lifecycle rule: decks containing cards the engine
  cannot resolve are arena-ineligible (no silent fallback simulation); engine
  bumps are a scripted pin → map → verify → report procedure.
- Add `scripts/training/ROADMAP.md` laying out goals and gates for each
  training AI/validator (arena → interaction miner + inductive card encoder →
  generator → bot self-improvement stages).
- No changes to the shipped app; determinism and offline-only constraints are
  unchanged. Interaction mining, the inductive card encoder, and generator
  integration are follow-up changes.

## Capabilities

### New Capabilities

- `training-arena`: offline AI-vs-AI deck evaluation producing deterministic,
  cached game records and matchup win rates for training.

### Modified Capabilities

(none)

## Impact

- `scripts/training/vendor/` (new): pinned engine subset + attribution.
- `scripts/training/arena/` (new): runner, mapping, batch CLI, tests.
- `scripts/training/ROADMAP.md` (new): milestone ladder and gates.
- `public/data/report.json`: extended with arena mapping coverage.
- Nothing in `src/` changes; the app build never imports the vendor tree.
