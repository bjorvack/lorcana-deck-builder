# deck-statistics Specification

## Purpose
Deck statistics turn any card set (current deck or filtered catalog pool) into the numbers players use to judge a build.

## Requirements

### Requirement: Compute core deck statistics
For any deck or filtered pool the app SHALL compute: total card count; inkability percentage (cards with the inkwell icon) overall and per cost value; ink color distribution; cost distribution; card-type distribution; rarity distribution; franchise distribution; and average strength/willpower/lore over characters.

#### Scenario: Inkability split
- **WHEN** statistics are computed for a 60-card deck where 24 cards are inkable
- **THEN** inkability is reported as 24 cards (40%) with a per-cost breakdown available

#### Scenario: Cost curve
- **WHEN** statistics are computed for a deck
- **THEN** the cost distribution shows, for each cost value present, how many cards are inkable versus not

### Requirement: Compute tag distribution
The app SHALL compute counts per mechanic/gameplay tag (e.g. removal, draw, ramp) for any deck or filtered pool.

#### Scenario: Removal count in a deck
- **WHEN** a deck contains 6 cards tagged removal
- **THEN** the statistics show removal: 6 (counting card copies)

### Requirement: Statistics update live
The app SHALL recompute statistics whenever the deck changes and display them alongside the deck.

#### Scenario: Add a card
- **WHEN** the user adds a copy of a card to the deck
- **THEN** all affected statistics (count, curve, inks, types, tags) update without a manual refresh

### Requirement: Curve simulation models Sing

Curve-consistency simulation SHALL treat a Song card as playable without ink when a character whose cost is at least the Song's cost is **in play and dry** (in play since the start of the turn — characters played this turn are drying and cannot sing); the singer is exerted, stays in play, and cannot also quest that turn. Because a singer must land at least one turn before it sings, playing a big Song via Sing is at least one turn slower than paying its ink cost.

#### Scenario: Song sung by a dry character in play

- **WHEN** a cost-5 song and a cost-5 character are in hand on turn 3 with 3 ink, and the character is played on turn 3
- **THEN** the song cannot be sung on turn 3 (the character is drying), and can be sung on turn 4 without paying ink

#### Scenario: No singer available

- **WHEN** a Song's cost exceeds the cost of every dry character in play and the available ink is less than the Song's cost
- **THEN** the Song cannot be played that turn

### Requirement: Curve simulation models cost reduction and ramp

Curve-consistency simulation SHALL reduce a card's effective cost by its printed self-discount ("pay N less to play this card"). Cards whose text puts the top card of the deck into the inkwell SHALL grant +1 ink available from the following turn (ramp ink arrives exerted), leaving the turn of play unchanged.

#### Scenario: Self discount applies

- **WHEN** a card with cost 4 and a "pay 1 less to play this card" effect is held on turn 3 with 3 ink
- **THEN** the card is playable on curve at effective cost 3

#### Scenario: Ramp ink arrives next turn

- **WHEN** a ramp card is played on turn 2
- **THEN** turn 2's available ink is unchanged by the ramp, and turn 3's available ink is increased by 1

### Requirement: Curve simulation models extended ink sources

Curve-consistency simulation SHALL additionally account for: cards granting an additional once-per-turn inking (raising the one-ink-per-turn limit while in play), ink drop counters (one-use spendable ink), and flexible-inking effects that put any card from the hand into the inkwell — including cards without the inkwell icon.

#### Scenario: Additional inking accelerates the inkwell

- **WHEN** a card granting an additional ink per turn is in play from turn 2
- **THEN** from turn 3 the simulation may add two ink per turn while hands contain inkable cards

#### Scenario: Flexible inking covers uninkable cards

- **WHEN** a hand contains only uninkable cards and a flexible-inking effect is in play
- **THEN** the simulation may still add ink from the hand

### Requirement: Curve simulation respects the starting-hand rules

The simulation SHALL deal a 7-card opening hand, SHALL skip the draw on the first turn when modelling the player on the play (the starting player compensation per the comprehensive rules), and SHALL draw one card at the start of every other turn.

#### Scenario: On the play

- **WHEN** the simulation models the player going first
- **THEN** turn 1 plays from 7 cards and turn 2 from 9 (no turn-1 draw)

### Requirement: Curve simulation floods leftover ink

After the turn's primary play, curve-consistency simulation SHALL spend leftover ink on additional affordable plays, most expensive first.

#### Scenario: Two plays in one turn

- **WHEN** the simulation reaches turn 4 with 4 ink and two affordable cost-2 cards in hand after the on-curve play
- **THEN** remaining ink is spent on the most expensive affordable cards, not carried idle

### Requirement: Curve simulation stays deterministic

Curve-consistency results (per-turn probabilities, expected ink, on-curve headline) SHALL be identical across repeated computations for the same deck.

#### Scenario: Repeated computation

- **WHEN** curve consistency is computed twice for the same deck
- **THEN** all outputs are identical

### Requirement: Simulated winrate probability

The app SHALL estimate a deck's winrate probability by playing REAL
full-rules games with the pinned vendored engine in the browser — the user's
completed deck against the shipped baseline decks (real held-out tournament
decks), with the heuristic bot on both seats and seat-alternating games —
under a pre-committed budget of 4 opponents × 16 games (8 per seat) = 64
games. The run SHALL be asynchronous: games are played in batches with
macrotask yields between batches so the UI never blocks, a visible loader
SHALL report progress ("Simulating X/64 games…"), and a caller-owned run
token SHALL abandon the in-flight run when the deck changes (finished games
are discarded, never partially rendered). The estimate SHALL report the
observed win rate with a Wilson 95% confidence interval and the game count,
SHALL be deterministic per deck (seeded by the deck's content signature), and
SHALL keep a per-game turn-by-turn log (actions with card names and lore
totals) that the user can review per game. The section SHALL render above the
deck-validity check on the deck page and SHALL work without the meta model.

#### Scenario: Progress shown while simulating

WHEN the estimate runs for a completed deck
THEN the winrate section shows a loader with completed and total game counts
that advance as games finish, a visible progress bar, and the page stays
responsive (the simulations run off the main thread in workers).

#### Scenario: Parallel workers produce identical results

WHEN the same deck is estimated with a worker count of 1 and with the
maximum worker count
THEN the pooled estimate, per-game summaries, and their schedule order are
identical.

#### Scenario: Current winrate while simulating

WHEN the simulation is in progress and at least one game has finished
THEN the panel shows the running winrate tally and the completed games with
their reviewable logs, updating per finished game.

#### Scenario: Estimate after completion

WHEN a deck is completed and unchanged
THEN the section displays the simulated winrate with its Wilson 95%
confidence interval and the 64-game count, and repeated estimates for the
same deck are identical (seeded by the deck signature).

#### Scenario: Deck change cancels the run

WHEN the deck changes while an estimate is running
THEN the in-flight run is abandoned via its run token, its finished games are
discarded, and the panel never shows results from the abandoned run.

#### Scenario: Logs are reviewable

WHEN the estimate completes
THEN a "Review games" disclosure lists every simulated game (result,
opponent, seat and turn count) and expanding a game shows its turn-by-turn
summary with the actions taken (card names) and the running lore totals.

#### Scenario: Deterministic per deck

WHEN the same deck content is estimated twice
THEN the same games are played with the same seeds and the estimate is
byte-identical, independent of title edits.

#### Scenario: Works without the meta model

WHEN no meta-model artifact is present
THEN the winrate estimate is still produced (it depends only on the deck, the
shipped opponents, and the engine bundle).
