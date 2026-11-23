# deck-generation Delta

## ADDED Requirements

### Requirement: Learned completion in smart mode

When the learned completion model artifact exists and passed its A/B gate,
smart mode SHALL fill decks via the learned completion source (masked set-model
scoring over the current partial deck) followed by the existing needs-boost and
local-search refinement; otherwise it SHALL use the shipped suggest-fill fill.
Both paths SHALL produce fully legal 60-card decks, and the active completion
source SHALL be observable in generator debug output.

#### Scenario: Learned fill is used when gated in

WHEN smart mode runs with a valid, gate-passed model artifact
THEN the debug output names the learned completion source and the finished deck
is a legal 60-card deck.

#### Scenario: Shipped fill is used otherwise

WHEN smart mode runs without a valid or gate-passed model artifact
THEN the debug output names the shipped suggest-fill source and generation
succeeds identically to before.
