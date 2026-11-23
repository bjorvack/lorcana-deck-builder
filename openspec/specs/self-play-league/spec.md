# self-play-league Specification

## Purpose
TBD - created by archiving change self-play-league. Update Purpose after archive.

## Requirements

### Requirement: IS-MCTS play evaluator

The arena SHALL provide an information-set MCTS evaluator that determinizes hidden
state (opponent hand, deck order) and uses the shipped deck-aware heuristic as
rollout policy, with a configurable iteration budget. It SHALL only become the
league referee if it beats the shipped heuristic bot from both seats over at least
1,000 paired-seed games with the 95% win-rate CI lower bound above 0.5; a failed
gate SHALL be recorded and the heuristic bot SHALL remain the referee.

#### Scenario: Evaluator gate passes

WHEN the gate harness plays at least 1,000 paired-seed games from both seats and
the 95% CI lower bound of the evaluator's win rate is above 0.5
THEN the report marks the IS-MCTS evaluator eligible as league referee.

#### Scenario: Evaluator gate fails

WHEN the gate harness produces a 95% CI whose lower bound is at or below 0.5
THEN the negative verdict is recorded in the run report and ROADMAP.md, and
league games continue to be refereed by the shipped heuristic bot.

### Requirement: League evaluation

The loop SHALL maintain a league of opponent decks seeded from held-out real
tournament decks (never used as training targets) and from baselines (random
legal decks, smart-generator decks). A candidate deck SHALL be scored by
meta-weighted win rate W_i = Σ W_ij·P(j) over league members with share P(j),
reported with a bootstrap CI. Winning decks SHALL join the league and
near-duplicates SHALL be pruned by card-list distance.

#### Scenario: Candidate scoring

WHEN a candidate deck completes its league schedule
THEN its score equals the share-weighted win rate over all league opponents and
is reported with a bootstrap confidence interval.

#### Scenario: Real decks held out

WHEN the league is seeded
THEN real tournament decks appear only as fixed opponents and no candidate deck
is derived from them.

#### Scenario: Near-duplicate pruning

WHEN a winning deck is within the configured card-list distance of an existing
league member
THEN it does not join the league as a new entry.

### Requirement: MAP-Elites deck search

The search SHALL maintain an archive of elite decks indexed by behaviour
descriptors (average cost, inkable ratio, character/action/item mix,
lore-per-turn proxy). Mutations SHALL swap one or a few cards and every archived
deck SHALL pass full legality validation (ink declaration, copy limits and
exceptions, format, bans). Fitness SHALL be league win rate. Re-running with the
same seeds and engine commit SHALL reproduce an identical archive.

#### Scenario: Legality by construction

WHEN a mutation is placed into the archive
THEN the resulting 60-card deck passes full rules validation against its
declared inks.

#### Scenario: Elite replacement

WHEN a mutant's fitness exceeds the current elite of its descriptor cell
THEN it replaces that elite, otherwise the incumbent is kept.

#### Scenario: Deterministic archive

WHEN the search re-runs with identical seeds and engine commit
THEN the produced archive is byte-identical.

### Requirement: Variance-reduced scheduling

Game scheduling SHALL use paired seeds (a deck and its mutation see identical
shuffles against the same opponent), common random numbers across league
opponents, and SPRT sequential stopping so decided pairings stop early. Every
game result SHALL be cached under the arena cache key including the seed base.

#### Scenario: Paired seeds

WHEN a deck and its mutation play the same opponent on the same seed base
THEN both games use identical shuffles.

#### Scenario: Sequential stopping

WHEN the SPRT decision bounds are crossed before the full game budget is used
THEN the remaining games of that pairing are not simulated.

### Requirement: Self-play reporting and acceptance gate

Every shipped metric SHALL report bootstrap confidence intervals, and each gate
SHALL require the CI lower bound to beat its baseline. The loop SHALL be
declared shipped only if self-play decks beat the held-out real tournament decks
with a 95% CI excluding 0.5; otherwise the verdict is NOT SHIPPED and recorded.
A `selfplay.report.json` SHALL be committed with engine pin, seeds, coverage
numbers, league composition, archive statistics and gate results.

#### Scenario: Acceptance gate

WHEN a full loop run completes
THEN the report records the self-play-vs-held-out-decks win rate with a 95% CI,
and the verdict is SHIPPED only if that CI excludes 0.5.

#### Scenario: Run report

WHEN a run finishes
THEN `selfplay.report.json` contains the engine commit, seeds, coverage numbers,
league composition, archive statistics and all gate verdicts.
