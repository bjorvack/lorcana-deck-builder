# training-arena Delta

## MODIFIED Requirements

### Requirement: Card mapping with reported coverage

The arena SHALL map card identities — not printings — to engine canonical
card ids: reprints, rarities and promos of a card SHALL alias to one
functional identity (the existing `canonicalAlias()` registry) and inherit its
mapping, data and vector. The mapping SHALL use a set/collector-number join on
the canonical print with lorcast external-ID fallback, and SHALL report
mapping coverage into the data validation report. The report SHALL additionally
classify every card in the legal pool as fully scripted, partially scripted, or
unmapped with respect to engine rule support.

#### Scenario: Printings share one identity

- **WHEN** two prints of a card differ only in rarity, set, or art
- **THEN** both alias to the same mapping entry and the same training vector

#### Scenario: Differently-functioning variants do not collapse

- **WHEN** a card variant differs in cost, stats, ink, type, or text
  semantics (e.g. Quest challenge versions)
- **THEN** it keeps its own identity and mapping entry

#### Scenario: Mapping coverage is visible

- **WHEN** the data build report is generated
- **THEN** it states per-set mapped and ineligible card counts, and flags any
  identity group with stat-level drift between its prints as needs-review

#### Scenario: Unmapped cards are ineligible, not substituted

- **WHEN** a deck contains a card with no engine mapping
- **THEN** the deck is reported arena-ineligible and no game is simulated for
  it (the engine's fallback card definition is never used silently)

#### Scenario: Per-card coverage status

WHEN the mapping report is generated
THEN each card in the legal pool carries a coverage status of fully scripted,
partially scripted, or unmapped.

## ADDED Requirements

### Requirement: Self-play pool filtering

The self-play card pool SHALL exclude unmapped cards. Partially scripted cards
SHALL be flagged, and how often they appear in generated decks SHALL be
reported. A self-play run SHALL fail if coverage of the legal card pool falls
below a configured threshold.

#### Scenario: Unmapped cards excluded

WHEN the self-play card pool is built
THEN it contains no unmapped cards and the report states how many cards were
excluded.

#### Scenario: Coverage threshold enforced

WHEN the legal-pool coverage is below the configured threshold
THEN the self-play run exits with an error naming the measured and threshold
coverage.

#### Scenario: Partially scripted reporting

WHEN generated decks are produced
THEN the report includes how often partially scripted cards appear in them.

### Requirement: Paired-seed scheduling

The arena SHALL schedule related decks (a deck and its mutation) against the
same opponent on a shared seed base so both games see identical shuffles, and
SHALL record the seed base in every game record.

#### Scenario: Shared seed base

WHEN two related decks play the same opponent on the same seed base
THEN both game records show identical shuffles and carry that seed base.
