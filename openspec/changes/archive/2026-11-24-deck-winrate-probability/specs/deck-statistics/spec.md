# deck-statistics Delta

## ADDED Requirements

### Requirement: Simulated winrate probability

The app SHALL estimate a deck's winrate probability by running a seeded batch
of goldfish races against a baseline profile — 2,000 trials in 400-trial
chunks with yields between chunks so the UI never blocks — and SHALL report
the observed win rate with a Wilson 95% confidence interval and the trial
count. The estimate SHALL be deterministic per deck.

#### Scenario: Estimate after completion

WHEN a deck is completed and unchanged
THEN the panel displays the simulated winrate with its Wilson 95% confidence
interval and trial count, and repeated estimates for the same deck are
identical (seeded by the deck signature).

#### Scenario: Deck change cancels the run

WHEN the deck changes while an estimate is running
THEN the in-flight run is abandoned via its run token and the panel never
shows results from the abandoned run.

#### Scenario: Works without the meta model

WHEN no meta-model artifact is present
THEN the winrate estimate is still produced (it depends only on card data and
the simulator).
