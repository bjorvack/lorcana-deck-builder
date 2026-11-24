# meta-model Delta

## REMOVED Requirements

### Requirement: Identify archetype and meta-fit

The app SHALL compare the current deck's fingerprint and card composition
against the shipped archetypes and report the closest archetype (or a
combination) with a similarity indication, that archetype's observed
tournament win rate from the artifact, and a viability score decomposed into a
deterministic sim-strength component and a meta-alignment component.

**Reason**: the meta-fit viability score is replaced by a measured simulated
winrate probability (deck-statistics capability) — a directly computed
estimate instead of a composition-derived score.

**Migration**: archetype identification and its observed-win-rate display are
preserved verbatim in the new "Archetype identification" requirement below;
the viability score and its decomposition are removed from the UI.

## ADDED Requirements

### Requirement: Archetype identification

The app SHALL compare the current deck's fingerprint and card composition
against the shipped archetypes and report the closest archetype (or a
combination) with a similarity indication and that archetype's observed
tournament win rate from the artifact.

#### Scenario: Steel song recognized

- **WHEN** a deck closely matches a shipped Steel Song archetype with a 54% observed win rate
- **THEN** the panel names that archetype, shows the similarity, and shows the 54% observed win rate

### Requirement: Winrate replaces the viability display

The analysis panel SHALL render the simulated winrate probability (from the
deck-statistics capability) in place of the former viability score, and SHALL
NOT display a viability score or a sim-strength/meta-alignment decomposition.
The archetype match SHALL keep working with the meta model and SHALL degrade
as specified for stale artifacts.

#### Scenario: Winrate replaces the viability score

- **WHEN** the analysis panel renders the winrate section
- **THEN** it shows the simulated winrate probability with its Wilson 95%
  confidence interval and trial count, and no viability score or sim/meta
  decomposition is displayed

#### Scenario: Archetype match unchanged

- **WHEN** the meta model is present and calibration passed
- **THEN** the archetype match renders exactly as before, and no viability
  decomposition appears in the panel
