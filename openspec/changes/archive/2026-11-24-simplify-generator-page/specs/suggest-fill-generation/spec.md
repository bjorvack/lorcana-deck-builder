# suggest-fill-generation Delta

## REMOVED Requirements

### Requirement: Opt-in goldfish polish pass

The generator SHALL offer an opt-in polish pass that hill-climbs single-card
swaps scored by the existing goldfish race simulator, subject to the same
legality and copy-limit rules. Polish SHALL be off by default; generation
without polish SHALL remain fast (interactive).

**Reason**: removed from the generator page by product decision — the
analysis panel now shows a measured simulated winrate probability
(deck-winrate-probability change) instead of a polish-time hill-climb, and
the learned completion model handles fill quality directly.

**Migration**: the goldfish race simulator remains in `src/stats/goldfish.ts`
(the analysis panel's winrate estimator uses it); the `polishDeck` hill-climb
and its UI toggle are removed. Generation is always the fast interactive path.

## ADDED Requirements

### Requirement: Generation is always interactive

Generation SHALL complete on the interactive path only: no hill-climbing
polish pass SHALL run as part of generation. The completion model, needs
boosts and local search remain bounded to interactive latency.

#### Scenario: No polish stage

- **WHEN** a deck is generated
- **THEN** no goldfish hill-climb pass runs and the result is returned on the
  interactive path
