# Spec Delta

## Purpose
Deck generation driven by the suggestion engine: a seeded, deck-aware pick loop with a continuous Meta ↔ Novel slider, a copy policy that produces real multiplicities, soft payoff boosts, and an optional goldfish polish — producing legal decks that can be completely novel.

## ADDED Requirements

### Requirement: Slider-driven generation
The generator SHALL accept a continuous novelty slider (Meta ↔ Novel, default middle) that scales, consistently: seed weighting (playrate-weighted at the meta end, inverse-playrate weighted at the novel end), candidate novelty weighting, and sampling temperature.

#### Scenario: Novel end favors unplayed cards
- **WHEN** the slider is at the novel end and the generator runs with a full pool
- **THEN** the seed and the majority of picks are cards with zero or near-zero tournament playrate

#### Scenario: Meta end favors core cards
- **WHEN** the slider is at the meta end and the generator runs with a full pool
- **THEN** the deck is dominated by high-playrate cards

#### Scenario: Middle default
- **WHEN** the generator UI opens
- **THEN** the slider starts at the middle position

### Requirement: Suggest-fill pick loop
The generator SHALL fill the deck by iteratively scoring the full legal pool against the evolving deck with the fused suggestion score (relation similarity where a vector exists, text-feature similarity otherwise), plus needs boosts (cost-curve gaps, type quotas) and soft payoff boosts. Each pick SHALL be sampled from the highest-scoring candidates with temperature rather than taken as an argmax.

#### Scenario: Deck evolves with its suggestions
- **WHEN** a deck contains cards that the relation or text space ties to specific partners
- **THEN** those partners appear among the scored candidates with elevated scores before unrelated cards

#### Scenario: Text-space fallback finds novel pairs
- **WHEN** a never-played card has no relation vector but shares classifications or keywords with deck cards
- **THEN** it is still scored via the text space and can be picked

### Requirement: Copy policy produces multiplicities
The generator SHALL bias subsequent picks toward deepening already-chosen cards toward their trained typical copy count (when known), capped by per-card copy limits. A generated deck SHALL NOT consist of only singletons: with a pool large enough to support it, the most-picked cards have 2+ copies.

#### Scenario: Core cards get copies
- **WHEN** the generator fills a deck from a full pool
- **THEN** the deck's distinct-card count is well below the deck size (multiplicities exist) while every copy limit is respected

#### Scenario: Unlimited-card cap
- **WHEN** a card's copy limit is 4 (or the card is unique/limited)
- **THEN** the generator never exceeds that limit

### Requirement: Payoffs boost but never constrain
Payoff completion SHALL raise candidate scores (a Shift card boosts matching targets; a payoff card boosts cards that satisfy its references). Payoff coverage SHALL NOT be a generation requirement: the generator SHALL produce a legal, playable deck whether or not a payoff resolved.

#### Scenario: Shift card playable without target
- **WHEN** the generator includes a Shift card and no matching target is picked
- **THEN** the deck remains legal, playable, and validation-clean

### Requirement: Deterministic seeded generation
The generator SHALL be deterministic for the same inputs (cards snapshot, inks, format, slider position, seed, refine setting). The UI SHALL expose the seed and a regenerate action.

#### Scenario: Same seed reproduces the deck
- **WHEN** the same seed and slider position are used twice on the same snapshot
- **THEN** both runs produce identical decks

#### Scenario: Different seed varies the deck
- **WHEN** two different seeds run at the same slider position
- **THEN** the decks differ (sampling, not argmax)

### Requirement: Optional goldfish polish
The generator SHALL offer an opt-in polish pass that hill-climbs single-card swaps scored by the existing goldfish race simulator, subject to the same legality and copy-limit rules. Polish SHALL be off by default; generation without polish SHALL remain fast (interactive).

#### Scenario: Polish improves the goldfish score
- **WHEN** polish runs on a generated deck
- **THEN** swaps are only kept when the goldfish result improves and legality holds

#### Scenario: Polish off keeps generation instant
- **WHEN** the user generates without polish
- **THEN** the deck returns without running the race simulator

### Requirement: Legality and partial-deck behavior unchanged
Generation SHALL continue to satisfy the existing deck-generation requirements: full validation (60+ cards, declared inks including dual-ink pairs, copy limits, format legality), partial-deck completion with user cards kept unchanged, and progressive relaxation of set/franchise restrictions with an explanatory note.

#### Scenario: Existing legality contract holds
- **WHEN** the generator runs on any pool
- **THEN** the result passes full validation with zero violations

### Requirement: Graceful degradation before artifact data exists
When the meta-model artifact lacks the playrate and typical-copies maps (stale version), the generator SHALL fall back to neutral novelty weighting and text-space-only scoring rather than failing.

#### Scenario: Stale model still generates
- **WHEN** the shipped artifact predates the playrate maps
- **THEN** generation works with all weighting neutral and no runtime errors
