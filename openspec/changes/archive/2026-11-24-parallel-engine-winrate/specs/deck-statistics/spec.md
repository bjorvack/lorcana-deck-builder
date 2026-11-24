# deck-statistics Delta

## MODIFIED Requirements

### Requirement: Simulated winrate probability

The app SHALL estimate a deck's winrate probability by playing REAL
full-rules games with the pinned vendored engine in the browser — the user's
completed deck against the shipped baseline decks (recent tournament decks,
selected for recency within a 90-day window and mutual diversity by
card-list distance — the meta drifts and near-identical opponents would
measure one matchup), with the heuristic bot on both seats and
seat-alternating games — under a pre-committed budget of 4 opponents × 16
games (8 per seat) = 64 games. The run SHALL execute across 2–4 module
workers (hardware-aware worker count), which MUST NOT change any game's
result: per-game seeds are schedule-ordered and independent, and the
completed games SHALL be re-assembled in schedule order. The run SHALL be
asynchronous and non-blocking, a visible loader with a progress bar SHALL
report progress ("Simulating X/64 games…"), a caller-owned run token SHALL
abandon the in-flight run when the deck changes (finished games are
discarded, never partially rendered), and WHILE the run is in progress the
panel SHALL display the current winrate tally and the list of completed
games (each with its reviewable turn-by-turn log). The completed estimate
SHALL report the observed win rate with a Wilson 95% confidence interval and
the game count, SHALL be deterministic per deck (seeded by the deck's
content signature), and SHALL keep the per-game turn-by-turn logs reviewable.
The section SHALL render above the deck-validity check on the deck page and
SHALL work without the meta model.

#### Scenario: Parallel workers produce identical results

WHEN the same deck is estimated with a worker count of 1 and with the
maximum worker count
THEN the pooled estimate, per-game summaries, and their schedule order are
identical.

#### Scenario: Current winrate while simulating

WHEN the simulation is in progress and at least one game has finished
THEN the panel shows the running winrate tally and the completed games with
their reviewable logs, updating per finished game.

#### Scenario: Progress shown while simulating

WHEN the estimate runs for a completed deck
THEN the loader reports "Simulating X/64 games…" with a visible progress
bar that advances per finished game.

#### Scenario: Deck change cancels the run

WHEN the deck changes while the estimate is running
THEN all workers are terminated, the in-flight run is abandoned, and the
panel never shows results from the abandoned run.

#### Scenario: Estimate after completion

WHEN the estimate completes for a completed deck
THEN the panel displays the final winrate with its Wilson 95% confidence
interval, the game count, and the full reviewable game list.

#### Scenario: Works without the meta model

WHEN no meta-model artifact is present
THEN the winrate estimate is still produced (it depends only on card data and
the simulator).
