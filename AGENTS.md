# AGENTS.md — agent guidance for lorcana-deck-builder

Non-obvious project knowledge, distilled from building the offline training
stack. Read this before working in `scripts/training/` or on the engine.

## What this repo is

A static-site Lorcana deck builder (GitHub Pages, no backend) plus an
**offline training stack** (`scripts/training/`) that runs AI-vs-AI games on
a vendored rules engine, mines tournament data, and ships gated model
artifacts. Everything runs client-side at runtime — the site never calls an
API.

- Stack: TypeScript, Vite, Vitest, Biome, Node 22+, lefthook (biome pre-commit, typecheck+tests pre-push)
- App: `src/` (generate, meta, stats, deck, rules, ui, data)
- Pipeline: `scripts/` → committed snapshots in `public/data/`
- Training: `scripts/training/` → gated artifacts in `public/data/meta-model.json`

## Commands

```bash
npm run dev            # site
npm test               # vitest (~375 tests; CI runs test:coverage with thresholds)
npm run typecheck      # root tsc + arena typecheck program (see below)
npm run lint           # biome (must be clean)
npm run data:pipeline  # rebuild public/data from lorcanajson snapshot
npm run arena:map      # card-ID mapping + coverage into public/data/report.json
npm run arena:panel    # meta deck panel for the arena
npx tsx scripts/training/arena/batch.ts --games 10 --decks 16 --parallel 8
npx tsx scripts/training/arena/evolve.ts --generations 6 --population 24
npx tsx scripts/training/arena/ab.ts --seeds 16 --games 4 --parallel 8
```

## Architecture map

- `src/meta/score.ts` — shared candidate scoring (relation+text fusion, synergy lookup). Used by both the app and the trainer; one implementation by design (D1).
- `src/meta/infer.ts` — client meta-model parser. **Degrades per-capability**: a corrupt payload disables just that capability, never sinks the artifact.
- `scripts/training/train.ts` — gated capability assembly (relations, calibration, interactions, encoder). Each publishes independently; any-pass rule; failing gates are recorded, never silent.
- `scripts/training/arena/` — the arena: vendored-engine runner, mapping, panel, batch, A/B, evolution, ranker. Parallel harnesses split work across child `tsx` processes (seed-split); follow `batch.ts`'s pattern.
- `scripts/training/vendor/` — pinned CardGoat `tcg-engines` subset. **Never edit vendor sources** (they're a pinned checkout; `pull.ts` reproduces them). Bump procedure in `PIN.md`.
- `openspec/` — spec-driven workflow: changes in `changes/<name>/` (proposal/design/tasks/specs), archived via `npx openspec archive <name> --yes` when done. Delta spec files need `## ADDED Requirements` sections — other headers make the parser abort.

## The vendored engine — hard-won gotchas

1. **Instance ids are random.** `fromDeckToCardInstances` draws card instance
   ids from `Math.random()`, and the planner breaks candidate ties by
   instance-id comparison. The arena MUST re-key instances deterministically
   (`play.ts deterministicCardsMaps`) or identical seeds produce different
   games.
2. **Play entries ≠ our instance ids.** The projected board's `play` array
   contains engine-namespaced instance ids. Resolve cards through
   `board.cards[instanceId]` (definitionId + controllerId + stats live there)
   or `lorcana.getCardDefinitionByInstanceId` — not through
   `catalog.byId[tail]` (the tail is not a definition id).
3. **`cardType` is lowercase** in engine definitions (`'character'`); our
   catalog uses `'Character'`. Compare case-insensitively.
4. **Challenge candidates** expose `attackerId`/`defenderId`, not `cardId`.
5. Strategies are ordering functions: `summarizeCandidates(context, candidates)`
   returns summaries in preference order; the planner executes top-down and
   tie-breaks by instance id. Custom strategies may be passed as objects to
   `playGame({ strategyA })` — registry ids also work.

## Training discipline (the gates)

- **Every capability/claim ships only behind a pre-committed gate**, validated
  on fresh seeds disjoint from any selection data. Negative verdicts are
  recorded in `ROADMAP.md` and the archived change — never silently dropped,
  never tuned away.
- **Selection bias is the recurring failure**: best-of-N on small samples
  inflates fitness ~1σ (M3 lesson). Fitness samples must exceed the noise
  floor; re-validate winners on fresh seeds.
- **Determinism**: seeded `mulberry32` only; no `Math.random` in training
  paths. Same inputs → byte-identical records (asserted by tests).
- Arena caches are keyed by (deck pair, map format, strategies, seeds, engine
  commit) — an engine bump starts a new era and never mixes records.
- Long-running compute (searches, gates, training, acceptance runs) is launched
  detached (`nohup … > log 2>&1 &`) instead of blocking on a foreground
  timeout; check progress through artifacts (cache files, summaries, verdict
  JSON), not by polling the log. Every long-running CLI must be interruptible
  and resumable: re-invoking with the same flags continues from checkpoints
  and caches — completed work is never redone from zero, and leftover
  `.parts-*` work is merged on startup, never discarded. Sweeps only merge
  parts of dead processes (concurrent runs keep theirs) and validate merged
  parts against the run's own flags; anything that fails validation is
  re-evaluated, not trusted.
- Artifact budget: `meta-model.json` ≤ 300 KB gzip (currently ~300.9 — thin
  headroom; measure before adding payload sections).

## Data gotchas

- lorcanajson **flattens promo sub-sets** into the parent set: set 7 has three
  cards numbered "26". `normalize.ts` disambiguates collector numbers from
  `fullIdentifier` ("26/P2" → "P2-26"). `setNumber` is always 0 — use
  `setCode`.
- Our catalog `type` is `'Character'` (capitalized); engine defs use
  `'character'`.
- Moana/Vaiana are the same printing's two localized names — a legitimate
  duplicate pair (the card map's name fallback handles it).

## TypeScript program split

- Root `tsconfig.json` excludes `scripts/training/{arena,vendor,data}`.
- The arena has its own program (`tsconfig.typecheck.json`) with **hand-rolled
  shims** in `types/` for `@tcg/*` packages — vendor sources must never enter
  a tsc program (they're authored for upstream's Bun toolchain). Runtime
  (tsx/vitest) resolves the real modules.
- Adding fields to trace/record types: update the type in `play.ts`, the
  trace writer, AND the trainer's local interfaces (three places).

## Testing / coverage

- CI runs `test:coverage` with per-directory thresholds (`src/generate` 87%
  lines). New code paths need tests or coverage fails the PR.
- Arena tests live next to the code (`scripts/training/arena/*.test.ts`).
- The full suite is ~375 tests, <1 min. Pre-push runs typecheck + tests.
