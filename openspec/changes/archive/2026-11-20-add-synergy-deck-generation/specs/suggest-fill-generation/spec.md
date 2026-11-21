# Spec Delta

## ADDED Requirements

### Requirement: Synergy-aware suggestion scoring (capability-gated, default off)

When the meta artifact carries the interactions capability, suggestion
candidate scoring SHALL support blending the candidate's trained synergy with
the deck (best partner score among the deck's identities, both evidence
directions, normalized 0–1) at a configurable share of the similarity
portion. The shipping default share SHALL be 0: the arena A/B gate measured
blending as neutral-to-negative under bot evaluation, so the blend is opt-in
(experiments / future synergy-aware evaluators) until re-gated. When the
capability is absent, scoring SHALL be unchanged.

#### Scenario: Partnered candidate outranks an otherwise-equal card

- **WHEN** two candidates have equal fusion similarity and one is a trained
  partner of a card already in the deck
- **THEN** the partnered candidate scores higher

#### Scenario: Artifact without interactions behaves as before

- **WHEN** the artifact lacks the interactions capability
- **THEN** suggestion scores and picks are identical to the pre-capability
  behavior for the same seed

#### Scenario: Shipping default does not blend

- **WHEN** the interactions capability is present and no explicit blend share
  is configured
- **THEN** picks match the pre-synergy behavior (default share is 0 per the
  recorded A/B verdict)
