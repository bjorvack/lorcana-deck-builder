# Spec Delta

## Purpose
Typed, rule-extracted card payoffs: the system recognizes effect text that references or requires other cards (Shift lines and their variants, named-character effects, classification payoffs, sing payoffs, keyword grants), stores them as structured data, and reports payoff coverage for a deck as information — never as a validation violation.

## ADDED Requirements

### Requirement: Extract shift payoffs from card text
The snapshot pipeline SHALL extract Shift abilities into typed payoffs covering all official variants, with semantics matching the Comprehensive Rules and official release notes (rule 8.10.8.x).

#### Scenario: Named shift extracted
- **WHEN** a card's text contains `Shift 5 (You may pay 5 to play this on top of one of your characters named Hiro Hamada.)`
- **THEN** the snapshot records a shift payoff with cost 5, ink mode, and target name Hiro Hamada

#### Scenario: Variant target kinds
- **WHEN** the shift text targets a classification (Classification Shift), any character (Universal Shift), an item (Potato Shift), or the stack returns to hand at end of turn (Temporary Shift)
- **THEN** the payoff records the matching target kind, target type, or temporary flag

#### Scenario: Duo and Combo shift semantics
- **WHEN** a card has Duo Shift (two distinct characters, one per listed name — a dual-named character satisfies only one slot) or Combo Shift (either name, or one of each)
- **THEN** the payoff records the target names and the variant's multiplicity semantics

#### Scenario: Mimicry wildcards
- **WHEN** a card carries MIMICRY (universal shift target for any Shift card except Classification Shift) or ADVANCED MIMICRY (any character may shift onto it)
- **THEN** the payoff records the wildcard target semantics

#### Scenario: Combined variants and non-ink costs
- **WHEN** a card combines variants (e.g. Temporary Red Panda Shift) or pays its shift cost by discarding or removing ink-drop counters
- **THEN** the payoff records both component conditions, or the cost mode (discard / ink-drops) instead of an ink amount

### Requirement: Dual-named characters satisfy component-name targets
Target resolution SHALL treat a dual-named character ("Sulley & Boo – Scare Buddies") as having each component name, the full compound name, and its own full name — per the official naming rule. A payoff naming "Sulley" is satisfied by the duo card; a payoff naming "Sulley & Boo" matches only the compound.

#### Scenario: Component-name target satisfied
- **WHEN** a deck contains Sulley & Boo – Scare Buddies and a card's payoff targets "named Sulley"
- **THEN** the payoff is reported as covered

### Requirement: Extract named, classification, sing, and keyword payoffs
The pipeline SHALL extract from effect text:
- named references (`named X`), including payoff pairs between two cards (e.g. Flotsam ↔ Jetsam mutual buffs)
- classification payoffs (`your <classification> characters gain …`) keyed on the snapshot's classification vocabulary
- sing payoffs (`A character with cost N or more can sing this song`) with the minimum cost
- keyword grants (`gain <keyword>`)

#### Scenario: Mutual named pair
- **WHEN** Flotsam's text says "Your characters named Jetsam gain Rush"
- **THEN** the snapshot records a named payoff from Flotsam to Jetsam

### Requirement: Manual overrides for special cases
The pipeline SHALL apply versioned manual overrides (same mechanism as deck-rule overrides) for cards whose text the patterns cannot parse, and SHALL flag unparseable shift-like or named-reference text as needs-review in the validation report.

#### Scenario: Non-numeric shift cost overridden
- **WHEN** Baymax – Amped Up's shift cost is "Remove 2 ink drops"
- **THEN** an override entry supplies the cost mode and target, and the card is not flagged needs-review

#### Scenario: Unknown future variant flagged
- **WHEN** a new set prints a shift-like ability the patterns cannot parse
- **THEN** the validation report lists the card as needs-review instead of silently omitting it

### Requirement: Report payoff coverage as information
The analysis panel SHALL show payoff coverage for the current deck (e.g. "shift target present" / "no shift target in deck") as an informational line. Payoff coverage SHALL NOT produce validation violations.

#### Scenario: Shift card without target
- **WHEN** a deck contains a Shift card but no matching target
- **THEN** the panel shows the absence as information and the deck's validation result is unchanged
