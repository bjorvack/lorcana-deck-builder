# deck-fingerprint Specification

## Purpose
The deck fingerprint turns a deck into a deterministic playability profile: how fast it closes a game, how consistently it executes, and how it holds up against interaction — computed entirely client-side and presented as an analysis panel under the deck's statistics.

## Requirements

### Requirement: Compute consistency metrics

The app SHALL compute, for the current deck: opening-hand quality — the probability that the opening hand is keepable under the game's actual hand-alteration rule (exact comprehensive-rules wording to be verified at implementation and documented in the panel) — and redundancy (probability of having drawn at least one copy of each build-around effect — cards with deck-rule effects or tagged enablers — by the turn its cost makes it playable).

#### Scenario: Redundancy matches closed form

- **WHEN** redundancy is computed for a deck with exactly 4 copies of an enabler that becomes playable at cost 2
- **THEN** the probability equals the known hypergeometric value for drawing at least one of 4 copies in the cards seen by turn 2

### Requirement: Compute interaction and coverage metrics

The app SHALL compute, for the current deck: interaction density (copies of removal, challenge-trick, and counter effects), singer coverage (for each song cost band, the number of characters able to sing it), and Shift coverage (for each card with a Shift alternate cost, whether the deck runs a character with the matching name to shift onto).

#### Scenario: Interaction density counts copies

- **WHEN** a deck contains 6 copies of removal-tagged cards
- **THEN** interaction density reports 6 removal copies

#### Scenario: Shift without a target is flagged

- **WHEN** a deck contains 4 copies of a Shift card whose printed name matches no other character in the deck
- **THEN** Shift coverage reports that card as unshiftable

### Requirement: Compose a versioned fingerprint

The app SHALL compose all playability metrics, curve-consistency outputs, tempo axes, and matchup estimates into a versioned fingerprint object for the current deck. Computing the fingerprint twice for the same deck SHALL yield identical values.

#### Scenario: Fingerprint is stable

- **WHEN** the fingerprint is computed twice for the same 60-card deck
- **THEN** every metric value is identical

### Requirement: Simulate lore races against opponent baselines

The app SHALL simulate the deck racing to 20 lore against at least three scripted opponent baselines (aggressive, midrange, control), each parameterized by curve histogram, threat speed, and removal density.

#### Scenario: Removal resilience

- **WHEN** the opponent baseline has high removal density and the deck has few characters
- **THEN** the win estimate against that baseline is lower than against the low-removal baseline

### Requirement: Simulations honour core game timing rules

The lore-race simulation SHALL honour the comprehensive rules that shape tempo: characters enter play drying and quest from the following turn (Rush allows challenging on arrival only); locations in play pay their lore automatically each turn; the on-the-play player skips their first draw; and a player whose turn ends with an empty deck loses.

#### Scenario: Dry characters slow the clock

- **WHEN** a deck that plays only cost-2 characters is simulated
- **THEN** its first lore is gained on turn 2, not turn 1

#### Scenario: Locations add passive lore

- **WHEN** a deck includes locations and the simulation reaches the mid-game
- **THEN** the lore-per-turn total includes the locations' automatic lore

### Requirement: Simulations honour combat and keyword rules

The lore-race simulation SHALL honour the rules that shape interaction: challenges target only exerted characters, with keyword-aware legality (Evasive/Alert, Bodyguard redirection, Ward blocking effect targeting, Reckless forcing challenges), and damage persists between turns.

#### Scenario: Evasive characters resist removal

- **WHEN** the opponent baseline challenges but the deck's board is Evasive and the baseline's characters are not
- **THEN** the deck's characters survive challenges that would banish non-Evasive characters

### Requirement: Report matchup estimates

The app SHALL report, per opponent baseline, an estimated win rate over a fixed number of seeded trials and the distribution of the turn on which 20 lore is reached. Estimates SHALL be reproducible: the same deck always yields the same numbers.

#### Scenario: Estimates are reproducible

- **WHEN** matchup estimates are computed twice for the same deck
- **THEN** win rates and clock distributions are identical

### Requirement: Present the analysis panel only for valid decks

The analysis panel SHALL render only when the current deck is valid — complete and passing all deck-rule validation — and SHALL sit under the existing statistics section of the deck page. For an invalid or incomplete deck the panel SHALL NOT render (the stats section alone remains).

The panel SHALL present the viability profile as a radar over the named axes (at minimum Tempo, Consistency, Resilience, Interaction, Reach) with a dotted midpoint reference ring and the per-axis values visible as text; matchup presentation SHALL consist of win-rate bars versus the baselines (win rate and median clock) plus a lore-race line chart plotting the deck's mean accumulated lore per turn against the selected baseline's scripted pace, with one selectable tab per baseline showing its win rate.

#### Scenario: Valid deck shows the panel
- **WHEN** the current deck is valid (60+ cards, no rule violations)
- **THEN** the analysis panel renders under the statistics section with the viability radar, per-axis value chips, matchup win-rate bars and the lore-race line chart

#### Scenario: Incomplete deck hides the panel
- **WHEN** the deck is incomplete or violates a deck rule
- **THEN** the analysis panel does not render and no placeholder replaces it

#### Scenario: Panel updates on deck change
- **WHEN** the user edits a valid deck
- **THEN** the viability radar, matchup bars and lore-race chart update to reflect the new fingerprint

#### Scenario: Lore race switches baseline
- **WHEN** the user selects a different baseline tab in the lore-race chart
- **THEN** the line chart plots the deck against that baseline's scripted pace and the chart's text summary states that baseline's win rate

### Requirement: Explain analysis numbers

The analysis panel SHALL document how each displayed number is derived: tooltips state the underlying metrics, and documented simulation simplifications (no interactive responses, greedy policies, scripted opponent profiles) are visible to the user.

#### Scenario: Explainable numbers

- **WHEN** the user hovers a profile axis or matchup bar
- **THEN** a tooltip states which underlying metrics produced the value
