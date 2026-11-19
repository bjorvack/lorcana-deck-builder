# card-data-pipeline Specification

## Purpose
The build-time data pipeline turns external Lorcana card sources into a canonical, versioned, self-hosted snapshot that the app bundles, so the site never depends on runtime API availability or CORS.

## Requirements

### Requirement: Fetch card data from primary and supplementary sources
The pipeline SHALL fetch card data for every released set from lorcanajson.org (primary) and the Lorcast API (supplementary, prices and a second image source), and SHALL verify downloaded lorcanajson files against their published MD5 checksums.

#### Scenario: Full snapshot build
- **WHEN** the pipeline runs with network access
- **THEN** it fetches the lorcanajson all-cards file for English, validates its MD5 checksum, and fetches Lorcast card data per set for price/image merging

#### Scenario: Lorcast unavailable
- **WHEN** the Lorcast API is unreachable during a pipeline run
- **THEN** the pipeline still produces a complete snapshot from lorcanajson data and marks prices/second-images as absent in the report

### Requirement: Normalize into one canonical card schema
The pipeline SHALL map every card from any source into one canonical schema containing at minimum: stable id, full name (name + version subtitle), inks as an array with a dual-ink flag, cost, inkability, type, subtypes, franchise (`story`), set (code, name, number, type), rarity, copy limit, format legality (Core allowed, rotation date, ban date), game text, keywords, stats (strength, willpower, lore), and at least one image URL.

#### Scenario: Dual-ink card normalized
- **WHEN** a lorcanajson card has a `colors` array with two entries (e.g. Anna - Ice Breaker: Amethyst + Sapphire)
- **THEN** the canonical card lists both inks and is flagged as dual-ink

#### Scenario: Copy-limit exception preserved
- **WHEN** a card has `maxCopiesInDeck` set to 99 or null (unlimited), or absent
- **THEN** the canonical card carries copy limit 99, unlimited, or the default 4 respectively

### Requirement: Enrich missing fields
The pipeline SHALL derive missing values deterministically: inkability defaults (characters/items inkable, actions/locations not) when the source field is absent, and copy limit defaulting to 4. It SHALL record every applied default in a validation report.

#### Scenario: Missing inkability derived
- **WHEN** a source card lacks an inkability field
- **THEN** the pipeline fills it from the card type and flags the derivation in the validation report

### Requirement: Tag cards with mechanics and gameplay functions
The pipeline SHALL tag every card with: (a) mechanic tags copied from the dataset's parsed keyword abilities, (b) type/subtype tags, and (c) gameplay-function tags from a versioned, repo-owned rules file matching text patterns (e.g. removal, board wipe, draw, ramp, discard, bounce, lockdown, reanimate, lore burst). Every tag SHALL carry provenance (`rule` or `manual`), and cards whose tags cannot be determined SHALL be listed in a needs-review section of the validation report.

#### Scenario: Keyword tag from structured data
- **WHEN** a card has keyword abilities `["Evasive", "Shift"]`
- **THEN** it is tagged with mechanics `evasive` and `shift`, provenance `rule`

#### Scenario: Gameplay tag from text pattern
- **WHEN** a card's text contains "Banish chosen character" and the rules file maps that pattern to `removal`
- **THEN** the card is tagged `removal` with provenance `rule`

### Requirement: Emit a validated, versioned snapshot
The pipeline SHALL emit compact JSON snapshot files (cards, sets, metadata including source versions and generation timestamp) into a repo-committed directory, plus a validation report comparing per-set card counts against the source's published counts, listing missing fields, needs-review tags, and checksum results.

#### Scenario: Snapshot committed
- **WHEN** the pipeline completes successfully
- **THEN** cards, sets, and metadata JSON files exist in the snapshot directory with a `generatedOn` timestamp and source revisions, suitable for the app to bundle

#### Scenario: Coverage regression detected
- **WHEN** the fetched data has any card missing a franchise (`story`) value
- **THEN** the validation report lists those cards and the pipeline exits non-zero, blocking the snapshot update

### Requirement: Emit deck-rule effects for rule-modifying cards
The pipeline SHALL detect cards whose text modifies deck-building rules (ink exemptions, copy-limit overrides) and emit a structured `deckRuleEffects` field on the canonical card, sourced from a versioned, repo-owned override table keyed by card id. Every detected effect SHALL be listed in the validation report.

#### Scenario: Ink exemption emitted
- **WHEN** the pipeline processes Christopher Robin - Hunny Sage
- **THEN** the canonical card carries a structured ink-exemption effect (target: Hunny-subtype characters, excluding itself) and the validation report lists it

#### Scenario: Copy-limit lower bound preserved
- **WHEN** a card's copy limit is below the default (e.g. The Glass Slipper, limit 2)
- **THEN** the canonical card carries copy limit 2 and the report lists it as a rule exception

### Requirement: Scheduled and on-demand refresh
A scheduled CI workflow SHALL run the pipeline weekly and commit snapshot changes; a manual dispatch trigger SHALL allow running it at any time.

#### Scenario: Weekly refresh
- **WHEN** the weekly schedule fires and the pipeline produces a changed snapshot
- **THEN** the workflow commits the updated snapshot files to the repository
