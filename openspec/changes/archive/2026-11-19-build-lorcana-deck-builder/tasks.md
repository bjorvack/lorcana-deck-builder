# Tasks

## 1. Scaffold project

- [x] 1.1 Initialize npm project with Vite + React 18 + TypeScript, Vitest, strict tsconfig; verify `npm run build` and `npx vitest run` succeed on a stub app
- [x] 1.2 Add `.gitignore` (node_modules, dist, raw data cache), `.nvmrc`, ESLint-free minimal setup; verify `git status` is clean of build artifacts

## 2. Data pipeline (`scripts/`)

- [x] 2.1 Define canonical `Card`/`SetInfo` types in `src/data/types.ts` shared by pipeline and app; verify with `tsc --noEmit`
- [x] 2.2 Implement fetch step (lorcanajson allCards en + MD5 verify, Lorcast per-set optional with graceful skip) writing raw JSON to a gitignored cache dir; verify with a fixture-based unit test for the MD5/Lorcast-failure paths and one live `npm run data:fetch` run
- [x] 2.3 Implement normalize + enrich: canonical mapping, `inks[]`/`isDualInk` from `colors`, `maxCopies` from `maxCopiesInDeck` (absent→4, null→unlimited, 2→Glass Slipper), derived inkability fallback, full-name grouping key, `deckRuleEffects` from the curated override table (Christopher Robin - Hunny Sage ink exemption) plus a deck-rule-phrase scan reporting unknown text modifiers; unit tests with fixtures for dual-ink, copy-limit exceptions, ink exemption, Quest cards, missing-field derivation
- [x] 2.4 Implement rule-based tagger loading `scripts/tag-rules.json` (mechanic tags from keywords, gameplay tags from include/exclude patterns, provenance, needs-review list); unit tests with fixture cards (removal, draw-with-negation, keyword copy)
- [x] 2.5 Implement emit + validation report: compact `public/data/cards.min.json`, `sets.json`, `meta.json` (sources, generatedOn, tag rules version), report with per-set counts vs `cardCounts`, missing `story` check that exits non-zero; verify by running full pipeline and committing the snapshot
- [x] 2.6 Add `npm run data:fetch` / `data:build` / `data:pipeline` scripts; verify snapshot files parse and card count matches source

## 3. Pure logic modules (`src/rules`, `src/stats`, `src/generate`)

- [x] 3.1 Implement deck rules engine returning structured `Violation[]`: min-60, per-full-name copy limits (default 4, exceptions incl. Glass Slipper's 2, cross-print grouping), declared inks, dual-ink both-inks rule, deck-rule effects (collect active ink exemptions from deck cards, e.g. Christopher Robin - Hunny Sage enabling off-ink Hunny characters), Core/Infinity format checks (rotation, bans, Quest exclusion); Vitest cases for every spec scenario in `deck-rules`
- [x] 3.2 Implement stats module: inkability overall + per cost, ink/type/rarity/franchise distributions, cost curve inkable-split, character stat averages, tag counts (copies-weighted); Vitest cases in `deck-statistics`
- [x] 3.3 Implement generator with seeded RNG: pool building (inks + dual-ink filter, format, optional set/franchise), partial-deck preservation, smart mode (40–43% inkable target, curve peak 2–4, character-heavy mix), chaos mode, relaxation ladder with report; Vitest cases for every spec scenario in `deck-generation`
- [x] 3.4 Implement deck codec: localStorage persistence, plain-text `COUNTx Full Name` import/export with unmatched-line report, base64url URL codec; round-trip Vitest cases in `deck-persistence`

## 4. Web app (`src/`)

- [x] 4.1 App shell: hash routing (Browse / Deck / Generator), snapshot loader with typed errors, dark theme CSS, base-path-aware assets; verify manual smoke via `npm run dev`
- [x] 4.2 Browse view: filter bar (franchise, ink, set, type, cost, rarity, tags, text search), result count, lazy-loaded card grid with image fallback, detail modal, add-to-deck with copy-limit guard; verify filters against snapshot counts
- [x] 4.3 Deck view: deck list with counts, declared-ink + format selectors, live validation panel from rules engine, live stats panel with SVG charts, import/export/share controls; verify all `deck-rules`/`deck-statistics`/`deck-persistence` scenarios render correctly
- [x] 4.4 Generator view: ink picker, optional franchise/set filters, partial-deck source, smart/chaos toggle, result loaded into Deck view with relaxation notes; verify both modes produce valid decks from the real snapshot

## 5. CI and deployment (`.github/workflows/`)

- [x] 5.1 `ci.yml`: typecheck + vitest + build on push/PR; verify locally with `act --list`-equivalent dry reasoning and by ensuring all three commands pass
- [x] 5.2 `data.yml`: weekly cron + workflow_dispatch pipeline run committing snapshot changes; verify script entrypoint matches `npm run data:pipeline`
- [x] 5.3 `deploy.yml`: build with `BASE_PATH=/lorcana-deck-builder/` and deploy to Pages via actions/deploy-pages on main; verify build output structure
- [x] 5.4 README: setup, data refresh, deployment, architecture overview; verify instructions match package.json scripts

## 6. Final verification

- [x] 6.1 Full verification pass: `tsc --noEmit`, `npx vitest run`, `npm run build`, generated deck from each mode validates with zero violations against the committed snapshot
