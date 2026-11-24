# Proposal: engine-winrate

## Why

The deck page's winrate estimate is a goldfish lore-race against a scripted
baseline: our side never interacts, the opponent is a parameterized pace
curve, and the number systematically flatters aggro builds while underselling
control. The repo already ships a pinned, deterministic full-rules engine
(`scripts/training/vendor/`, used only by training code) with a strong
heuristic bot — the same machine the arena uses to referee league games. We
can play REAL games in the browser against real tournament decks and get an
engine-verified winrate, with per-game logs a player can actually review.

## What Changes

- **Engine bundle**: a training script bundles the pinned vendored engine +
  the shipped heuristic bot (`best-deck-aware-lore-race`) into
  `public/data/engine-bundle-<commit8>.js` (ESM, lazy-loadable, browser-only),
  exposing `createGame({deckA, deckB, seed, firstPlayer}) → {winner, turns,
  loreTimeline, log}` plus the engine commit and upstream attribution. The
  bundle is rebuilt on every arena engine bump (PIN.md's procedure) and the
  vendor tree itself is still imported only by training code.
- **Shipped opponents**: 4 real held-out tournament decks from the self-play
  league ship as `public/data/winrate-opponents.json` (committed), which also
  names the engine commit so the runtime knows which bundle to load.
- **Estimator swap**: `src/stats/winrate-estimate.ts` (goldfish batching) is
  deleted; `src/stats/engine-winrate.ts` lazily imports the bundle once and
  runs a pre-committed 64-game budget (4 opponents × 16 seat-alternating
  games) in batches of 4 with macrotask yields, a caller-owned run token for
  deck-change cancellation, progress callbacks, deterministic per-deck seeds,
  a Wilson 95% CI, and per-game turn logs.
- **Panel**: the winrate section moves out of the analysis panel to the deck
  page, rendered ABOVE the deck-validity check: loader ("Simulating X/64
  games…"), completed estimate with Wilson CI and game count, and a
  "Review games" disclosure with a per-game, turn-by-turn log. Works with no
  meta-model artifact.
- **Kept**: the goldfish race itself (`src/stats/goldfish.ts`) and
  `src/stats/profiles.ts` stay — the lore-race chart and the fingerprint's
  Tempo/Resilience axes still consume them (they are not the winrate
  estimator).

## Capabilities

### New Capabilities

- (none — new requirements fold into existing capabilities)

### Modified Capabilities

- `deck-statistics` — "Simulated winrate probability" now runs full-rules
  vendored-engine games against shipped baseline decks instead of goldfish
  races, with progress, cancellation, reviewable logs and a pre-committed
  64-game budget.
- `training-arena` — gains a "Browser simulation bundle" requirement: the
  pinned checkout is bundled for browser use by a training script, records
  its provenance, and is rebuilt on engine bumps.

## Impact

- `scripts/training/arena/engine-bundle-entry.ts` +
  `scripts/training/arena/build-engine-bundle.ts` (+ `engine:bundle` npm
  script) — the bundle and its builder; `esbuild` added as a devDependency.
- `scripts/training/export-winrate-opponents.ts` — emits the committed
  opponent pool; `public/data/engine-bundle-6de59de1.js` and
  `public/data/winrate-opponents.json` are shipped artifacts.
- `src/stats/engine-winrate.ts` (+ tests) replaces `src/stats/winrate-
  estimate.ts` (+ tests, deleted); `src/ui/AnalysisPanel.tsx` loses the
  winrate section; `src/ui/EngineWinrateSection.tsx` (+ tests) renders it on
  the deck page (`src/ui/DeckView.tsx`).
- Measured throughput: ~0.9-1.1 games/s in Node (heuristic bot, both seats),
  so the 64-game budget takes ~60-70 s of chunked background compute in the
  worst case — the loader and batch yields keep the page responsive.
