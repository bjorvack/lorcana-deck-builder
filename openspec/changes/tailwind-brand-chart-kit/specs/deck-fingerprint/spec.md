# Spec Delta

## MODIFIED Requirements

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
