# meta-model Delta

## REMOVED Requirements

### Requirement: Archetype identification

The app SHALL compare the current deck's fingerprint and card composition
against the shipped archetypes and report the closest archetype (or a
combination) with a similarity indication and that archetype's observed
tournament win rate from the artifact.

**Reason**: removed from the deck analysis panel by product decision — the
panel's winrate section (measured simulated winrate probability) is the
displayed metric. Archetype centroids remain in the meta-model artifact
unchanged (the build pipeline is untouched), so the data stays available for
training and offline analysis.

**Migration**: no user-facing replacement — the winrate section remains the
panel's evidence display. The archetype comparison remains available offline
via the training pipeline and its reports.
