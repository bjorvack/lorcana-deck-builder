# deck-statistics Delta

## MODIFIED Requirements

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
