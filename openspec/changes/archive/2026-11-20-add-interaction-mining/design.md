# Design

## Signal: win-rate-weighted pair lift

Co-occurrence alone rewards popular cards (Hercules pairs with everything in
Amber). The miner therefore scores a pair (a, b) by **lift under deck-quality
weighting**:

- each training deck contributes weight `w = max(0.05, winRate)` — bad decks
  still count, winning decks count more;
- `n_a`, `n_b`, `n_ab`, `N` are weight sums over decks containing a / b / both
  / all; `lift = n_ab · N / (n_a · n_b)`;
- support shrinkage pulls thin pairs to neutral:
  `lift_shrunk = 1 + (n_ab / (n_ab + S)) · (lift − 1)` with `S = 3` weighted
  pseudo-co-occurrences; and a pair needs **unweighted** support
  ≥ `minSupport` (5 decks) to be a candidate at all.

Determinism: integer pair keys (`a · 4096 + b`), sorted iteration, seeded
PRNG for the random-pair baseline, no `Math.random`.

## Gate: temporal holdout lift ratio

Mirrors the relations coherence gate. The miner selects top partners per card
from the **training split**; the gate then evaluates those pairs on the
**holdout split** (newest events, eval-only — the same split calibration and
relations use):

- `value` = mean shrunk lift of the selected pairs on holdout decks;
- `random` = mean shrunk lift of `20000` seeded random pairs over the holdout
  vocabulary;
- passes when `value / random ≥ 1.1` (same threshold as relations) — synergy
  must generalize to future events, not just describe the training era.

## Artifact payload

```
interactions: {
  version: '1',
  scale: number,            // lift-1 → int8 score factor
  partners: Record<cardId, Array<[partnerId, score]>>,  // top 8, score desc
}
```

Per-card partner lists (not a global pair table) keep the payload small;
scores are quantized like relations vectors. `parseMetaModel` ignores the
field until `add-synergy-deck-generation` consumes it.

## Arena panel + matchup batch

- `panel.ts` reuses `buildRows` for canonicalization and filters to
  arena-eligible decks (60 cards, ≤2 inks, every identity mapped, copy limits
  respected, core-legal cards). Dedupe by deck signature, rank by win rate,
  recent era first, cap N (default 16). Output: `arena/panel/<n>.txt` decks in
  the app's plain-text format + `panel.json` manifest (source, event, date,
  win rate, signature).
- `batch.ts` runs round-robin over the panel: per pair `games` games with
  per-pair seed base; aggregates a matchup matrix (wins per seat, incomplete)
  to `data/arena/matchups/<engineCommit>/matchup-matrix.json`. Deterministic
  and incremental-safe: reruns overwrite the matrix, individual games stay
  cached only via identical (deck pair, seed) replays through `playGame`.

The arena does **not** feed the mining gate in this change — the honest arena
signal for pair synergy needs controlled deck variants (the generator A/B in
`add-synergy-deck-generation`). Tournament co-occurrence is the mining source;
the panel/matchups exist so A/B evaluation is one command away.

## Capability wiring

`train.ts` gains `interactionsCapability({ rows, holdout, cards, seed })` →
`{ interactions: InteractionsOutput }`; `assembleMetaModel` publishes it like
relations (pass → include, fail → omit flag false). Publication stays
any-pass across the three capabilities; a run where all three fail still
writes nothing. `emit-model.ts` validation accepts an optional
`capabilities.interactions` boolean.
