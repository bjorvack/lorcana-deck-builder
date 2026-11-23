# Proposal: self-play-league

## Why

The repo's only training data is a small, survivorship-biased tournament corpus: the deck generator (`src/generate/`) is a seeded heuristic that consumes no learned signal, and the ROADMAP M4 outcome-trained ranker plateaued at parity with the shipped heuristic bot (0.506 win rate over 1,000 games, 95% CI [0.475, 0.537]). The arena can already produce unlimited, reproducible game data from card data alone — a self-play league turns that into the training signal, with real tournament decks demoted to a fixed validation opponent pool.

## What Changes

- **Engine coverage audit**: per-card mapping status (fully scripted / partially scripted / unmapped) in the data validation report; self-play card pool excludes unmapped cards; run fails if pool coverage drops below a configured threshold.
- **IS-MCTS play evaluator**: information-set MCTS with determinization (opponent hand, deck order), heuristic bot as rollout policy, configurable iteration budget (~150 to start). Gated: must beat the shipped heuristic bot from both seats over ≥1,000 paired-seed games, 95% CI lower bound > 0.5, before it may referee league games.
- **League evaluation**: opponent pool seeded from held-out real tournament decks (never training targets) plus baselines (random legal decks, smart-generator decks). Candidates scored by meta-weighted win rate W_i = Σ W_ij·P(j) with bootstrap CIs; winners join the league; near-duplicates pruned by card-list distance.
- **MAP-Elites deck search**: archive over behaviour descriptors (average cost, inkable ratio, type mix, lore-per-turn proxy); mutations swap a few cards and are legality-filtered through `src/rules` so archived decks are legal by construction; fitness = league win rate.
- **Variance reduction & compute**: paired seeds, common random numbers across opponents, SPRT sequential stopping, cached results (extends the existing arena cache).
- **Reporting & gates**: `selfplay.report.json` committed with engine pin, seeds, coverage, league composition, archive statistics and gate verdicts; acceptance requires self-play decks to beat the held-out real decks with 95% CI excluding 0.5, otherwise the loop is not shipped and the negative verdict is recorded in `ROADMAP.md`.

This change covers the offline loop (issue phases 1–4). The learned generator (phase 5) is a follow-up change once the archive exists.

## Capabilities

### New Capabilities

- `self-play-league` — the offline loop in which deck search and the play evaluator improve each other: IS-MCTS evaluator with its gate, league scoring, MAP-Elites archive, variance-reduced scheduling, and gate/reporting contract.

### Modified Capabilities

- `training-arena` — mapping report gains per-card coverage status; cache/scheduling gains paired-seed support; self-play pool filtering added.

## Impact

- `scripts/training/arena/` — new modules (coverage audit output, IS-MCTS player, league, MAP-Elites search, report writer) alongside `map.ts`, `play.ts`, `batch.ts`; follows the arena's parallel child-process pattern and its own typecheck program (never touching vendored engine sources).
- `public/data/report.json` — additional per-card coverage status fields.
- `public/data/selfplay.report.json` — new committed run report.
- `package.json` — new npm scripts for the loop stages.
- `ROADMAP.md` — gate verdicts recorded here.
- No runtime `src/` UI behaviour changes; no `meta-model.json` payload changes (separate report file keeps the ≤300 KB gzip budget intact).
