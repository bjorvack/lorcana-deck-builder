# Design: engine-winrate

## Context

The goldfish winrate (`src/stats/winrate-estimate.ts`) races our deck against
a scripted pace profile — no interaction from our side, a parameterized
opponent. The arena already owns a pinned full-rules engine
(`scripts/training/vendor/`, TheCardGoat tcg-engines @ `6de59de1`) whose
heuristic bot (`best-deck-aware-lore-race`) referees league games. The goal:
play real engine games in the browser between the user's deck and real
tournament decks.

Constraints pulled from AGENTS.md / PIN.md:

- the vendor tree is imported only by `scripts/training/` code — the browser
  gets a **built artifact**, never a src import;
- engine instance ids are re-keyed deterministically (the planner breaks
  candidate ties by instance id, and `fromDeckToCardInstances` draws ids from
  `Math.random()`);
- no `Math.random` anywhere in the estimator; seeded `mulberry32` only;
- no vendor edits.

## The bundle

`scripts/training/arena/build-engine-bundle.ts` (npm script `engine:bundle`)
runs esbuild (Vite's own dependency, now declared) over
`engine-bundle-entry.ts`:

- `--bundle --format=esm --platform=browser --target=es2022 --minify`;
- pin provenance (commit + PIN.md attribution) and the identity map are
  injected as esbuild `define` constants — the entry reads no filesystem and
  no node builtins, so `--platform=browser` is also the compat check (the
  build fails loudly if vendor code pulls one in);
- the identity map is `our print id → engine card id`, computed from the
  arena card map over every print of our catalog: runtime deck lists (which
  key by canonical print id — league decks and `DeckState.cards` share the id
  space) resolve inside the bundle, so the app never needs the arena card map;
- output: `public/data/engine-bundle-<commit8>.js` (~8.3 MB raw / ~1.9 MB
  gzip — the full rules engine plus the 14-set card catalog with i18n text;
  lazy-loaded once, only when the winrate section runs) plus an
  `engine-bundle.json` sidecar recording the commit; stale bundles of other
  commits are deleted by the builder;
- `engine-bundle.test.ts` imports the real artifact, checks it against
  PIN.md and the opponents artifact, and replays one game twice to pin
  determinism — after an engine bump this test fails until the bundle is
  rebuilt (PIN.md's bump procedure gains the rebuild step).

The wrapper API mirrors what the runtime needs and nothing more:
`createGame({deckA, deckB, seed, firstPlayer?}) → {winner, turns, actions,
incomplete, loreTimeline, log}` where `log` is one entry per turn with both
seats' action lines (card names resolved through the engine's instance →
definition lookup) and end-of-turn lore totals. `firstPlayer` defaults to a
seed-derived seat so seat advantage cancels across games.

## Opponents

`scripts/training/export-winrate-opponents.ts` takes the league's
`kind: 'real'` members (real held-out tournament decks, not generated ones)
from `league-6de59de1.json`, validates each is 60 cards and fully engine-
mapped, and emits `public/data/winrate-opponents.json` (committed):
`{ format, engineCommit, strategyId, generatedOn, decks: [{id, name, inks,
cards}] }`. `cards` keeps canonical print ids — the same id space the engine
bundle resolves. The artifact doubles as the pointer to the right bundle era.

## The estimator

`src/stats/engine-winrate.ts` keeps the old estimator's proven shape
(chunked/cancellable/run-token/Wilson), swapping the engine under it:

- **Budget (pre-committed)**: 4 opponents × 16 games, seat-alternating
  (even = user on p1, odd = mirrored) = 64 games. The whole schedule and its
  seeds are derived up front from `mulberry32(fnv1a32(deckSignature))` —
  consumed in schedule order — so batch boundaries never shift the stream and
  the result is a pure function of the deck.
- **Batching**: batches of 4 games; `setTimeout(0)` between batches; the run
  token is checked before every batch; progress fires after each batch.
- **Injection**: `playGame` and `opponents` are options — tests play fake
  games without any bundle; production wires `bundlePlayGame(commit)`, which
  `import(/* @vite-ignore */ <url>)`s the artifact once and caches it.
- **Failure**: a thrown game (unmapped card, engine error) voids the whole
  run — a partial winrate would overstate the deck. Same for a missing
  bundle/opponent pool. Wilson math moves here from the deleted estimator
  unchanged.
- **Throughput**: measured ~0.9-1.1 games/s in Node (avg ~16.5 turns/game),
  so the full budget is ~60-70 s of chunked background compute; each batch is
  a ~4 s slice with a yield after. The budget stays as pre-committed; the
  loader shows movement every batch.

## Panel

`EngineWinrateSection` moves to the deck page's aside, ABOVE the validation
panel, gated on a legal deck (the estimate is a completed-deck metric — same
gate the analysis panel used). It keeps the signature-keyed run-token effect
(title edits keep the run), adds progress state for the loader, and renders
the review disclosure: one row per game (Win/Loss, opponent, seat, turns)
with a click-to-expand turn log (mounted lazily per open game — 64 collapsed
rows otherwise). No meta-model surface exists anywhere in it.

## Deviations from the original sketch

- **`src/stats/goldfish.ts` is NOT deleted**: it is not orphaned —
  `src/stats/fingerprint.ts` consumes `matchupEstimates`/`simulateRace` for
  the viability radar's Tempo/Resilience axes and the lore-race chart, which
  this change keeps. Only `winrate-estimate.ts` (+ its test) is deleted; the
  goldfish race's own tests stay with the code that still ships.
- The bundle builder lives in `scripts/training/arena/` (not
  `scripts/training/`) so it typechecks under the arena's tsconfig program
  with the `@tcg/*` shims — the vendor sources must never enter the root tsc
  program.
- `esbuild` is added to `devDependencies` explicitly (it was only a
  transitive Vite dependency).
