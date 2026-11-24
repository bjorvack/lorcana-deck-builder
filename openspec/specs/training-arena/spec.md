# training-arena Specification

## Purpose
Owns the offline AI-vs-AI deck evaluation arena: a headless match runner on a
vendored open-source Lorcana engine that produces deterministic, cached game
records and matchup win rates for training components (interaction mining,
generator improvement). Training-time only; the shipped app is unaffected.

## Requirements

### Requirement: Offline AI-vs-AI match runner

The arena SHALL play complete Lorcana games between two automated seats using
the vendored engine's automation planner, with a selectable strategy per seat,
without network access and without user interaction. A game SHALL terminate on
a board winner; the runner SHALL stop cleanly (recorded as an incomplete game)
if the engine cannot resolve an actor or an error budget is exceeded.

#### Scenario: Full game between automated seats

- **WHEN** the runner is given two legal deck lists and a seed
- **THEN** it plays the game to a board winner and reports winner, turn count
  and move count

#### Scenario: Works fully offline

- **WHEN** the runner executes on a machine with no network
- **THEN** all games complete using the vendored engine and committed card
  data only

### Requirement: Deterministic, seeded games

Two runs with the same inputs (decks, seeds, strategies, engine version)
SHALL produce identical game records. Card instance ids SHALL be keyed
deterministically by the runner (owner, card id, position), never from
unseeded randomness, because the engine's planner breaks candidate ties by
instance-id comparison.

#### Scenario: Determinism replay

- **WHEN** the same matchup is replayed with the same seed
- **THEN** the game record is byte-identical

#### Scenario: Different seeds diverge

- **WHEN** the same matchup is replayed with a different seed
- **THEN** the game record differs (the seed actually drives shuffling)

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

### Requirement: Cached game records

The arena SHALL persist one JSONL record per game (engine version, seed, both
decks, strategy pair, winner, turn/move counts, per-turn lore) under a cache
key of (deck A, deck B, strategy pair, seed span, engine version), and SHALL
reuse cached records on identical requests. Records from different engine
versions SHALL NOT be mixed.

#### Scenario: Rerun reuses records

- **WHEN** the same batch command runs twice
- **THEN** the second run replays no games and returns the cached records

#### Scenario: Engine bump starts a new era

- **WHEN** the vendored engine version changes
- **THEN** previously cached records remain readable but no new run reuses
  them

### Requirement: Pinned vendored engine with attribution

The vendored engine code SHALL be a pinned upstream checkout recorded with the
upstream repository, commit, date, and license/disclaimer attribution, and
SHALL be imported only by `scripts/training/` code — never by `src/`.

#### Scenario: App build excludes the vendor tree

- **WHEN** the site build runs
- **THEN** no vendored engine module is bundled and no app test imports it

#### Scenario: Pin is auditable

- **WHEN** the vendor directory is reviewed
- **THEN** a pin file states the upstream commit the tree was taken from

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

### Requirement: Browser simulation bundle

A training script SHALL bundle the pinned vendored engine checkout together
with the shipped heuristic bot strategy into a lazy-loadable ES module under
`public/data/`, and `src/` sources SHALL load the shipped bundle artifact
rather than importing vendored engine sources.

#### Scenario: Bundle rebuilt on engine bump

WHEN the vendored engine is updated to a new upstream commit
THEN the bundle is rebuilt from the new pinned checkout under a filename
carrying the new commit8, the previous commit's bundle is removed, and the
bundle's recorded commit matches the pin file (a committed test fails while
they disagree).

#### Scenario: Bundle records its provenance and capabilities

WHEN the bundle is imported
THEN it exposes the engine commit and upstream attribution alongside a
wrapper that resolves deck lists given as canonical catalog print ids, plays
one game between two automated seats, and reports the winner, turn count,
lore timeline and a compact per-turn action log.

#### Scenario: Runtime plays a deterministic game

WHEN the bundle is asked to play one game twice for the same legal deck
lists and seed (in the browser or Node)
THEN both plays produce the identical result.

### Requirement: Browser bundle stays engine-only at build time

The shipped bundle SHALL be rebuilt whenever an arena engine bump changes the
pinned commit, and the app build SHALL keep the vendored engine sources out
of its module graph — the engine reaches the browser only through the
shipped bundle artifact.

#### Scenario: App build excludes the vendor tree

WHEN the site build runs
THEN no vendored engine module is imported or bundled by `src/` code.
