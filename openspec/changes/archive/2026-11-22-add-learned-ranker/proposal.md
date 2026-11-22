# Proposal

## Why

Close out the M4 roadmap milestone: a learned move ranker whose weights come
from game outcomes rather than hand-tuned heuristics. The weight-search
verdict (M3) showed hill-climbing a re-rank space cannot beat the shipped
ordering — the remaining path is learning FROM games: trace the planner's
ranked candidates per decision, label them with game outcomes, and fit a
linear ranker that can prefer what winners pick and losers don't.

## What Changes

- `play.ts`: optional `trace` flag — records gain per-decision traces
  (planner-ranked candidates with engine card refs + the executed one + turn
  and lore context).
- `arena/candidate-features.ts`: shared feature extraction (family one-hots,
  card stats, turn, lore differential) used identically by the trainer and
  the runtime strategy — learned weights transfer exactly.
- `arena/ranker.ts`: outcome-supervised logistic regression over traced
  decisions (winning games' choices are positives, losing games' choices are
  anti-examples); deterministic full-batch gradient descent.
- `arena/learned-strategy.ts`: strategy backed by learned weights.
- `arena/rank-gate.ts`: head-to-head learned-vs-shipped gate over the panel
  (parallel, CI rule: CI low > 0.5).
- No app changes.

## Verdict

Recorded in tasks.md after the gate run — either outcome completes the M4
harness and informs whether outcome-supervised linear ranking can beat the
shipped heuristic, the open question from the M3 negative result.

## Capabilities

(none — training-side only)
