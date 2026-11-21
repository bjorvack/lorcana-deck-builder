# Spec Delta

## ADDED Requirements

### Requirement: Interactions capability (gated pair-synergy mining)

The trainer SHALL mine card-pair synergy from the tournament corpus as
win-rate-weighted pair lift with support shrinkage, and SHALL publish a
per-card partner table in the artifact only when the pairs generalize to the
holdout split: the mean holdout lift of the selected pairs SHALL exceed the
mean holdout lift of a seeded random-pair baseline by the configured factor
(same threshold as the relations coherence gate). Mining SHALL be
deterministic: identical corpus and seed produce an identical payload.

#### Scenario: Synergy generalizes to future events

- **WHEN** pairs selected on the training split keep their lift advantage on
  the holdout split
- **THEN** the artifact ships with the `interactions` capability enabled and
  its gate metrics recorded

#### Scenario: Synergy does not generalize

- **WHEN** the selected pairs lose their advantage on the holdout split
- **THEN** the capability flag is false and no partner table ships, while
  other passing capabilities still publish

#### Scenario: Identical corpus reproduces identical mining

- **WHEN** the miner runs twice on the same corpus with the same seed
- **THEN** the produced partner table is byte-identical

### Requirement: Arena deck panel from the tournament corpus

The trainer SHALL be able to derive a panel of arena-eligible decks from the
tournament corpus: decks reduced to canonical identities, filtered to core
legality, engine-mapped identities and copy limits, deduplicated by deck
signature, ranked by win rate. Panel decks SHALL be written in the app's
plain-text deck format with a manifest recording their provenance.

#### Scenario: Panel decks are playable in the arena

- **WHEN** the panel builder runs on the current corpus
- **THEN** every emitted deck passes the arena runner's eligibility checks

#### Scenario: Duplicate lists collapse

- **WHEN** two corpus entries have the same deck signature
- **THEN** the panel contains one of them
