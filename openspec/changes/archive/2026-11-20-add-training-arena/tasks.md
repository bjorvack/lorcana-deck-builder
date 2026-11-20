# Tasks

## 1. Vendor the engine — done

- [x] 1.1 Engine runtime deps in root `package.json` (@logtape/logtape,
      @logtape/pretty, mutative, nanoid, seedrandom, zod, @types/seedrandom).
- [x] 1.2 Minimal upstream subset (`6de59de1`) committed under
      `scripts/training/vendor/`: lorcana-engine/src, lorcana-types/src,
      lorcana-cards/src (cards/helpers/utils only — upstream `data/` JSONs,
      tests, pack-simulator/parser/testing excluded), bot-core, shared,
      protocol, and the `@discord/embedded-app-sdk` stub. ~33 MB.
- [x] 1.3 `vendor/PIN.md` (repo, commit, exclusions, bump procedure,
      attribution); `vendor/pull.ts` reproduces the subset from a checkout and
      verifies the pin; vendored package.json internals (`@tcg/*`,
      `link:`/`workspace:`/`catalog:` refs, devDependencies) are stripped.
- [x] 1.4 Smoke test: `scripts/training/vendor/smoke.ts` plays a full
      AI-vs-AI game through the `@tcg/*` aliases.

## 2. Card mapping — done (hardened)

- [x] 2.1 `scripts/training/arena/card-map.ts` + `map.ts` CLI →
      `card-map.json`: identity-level (printings alias via `canonicalAlias()`),
      resolution through the registry-canonical print with a name-match gate
      and a normalized name+version fallback index.
- [x] 2.2 Coverage merged into `public/data/report.json` (`arena` section:
      mapped/via, ineligible reasons incl. name-mismatch,
      missingImplementation count).
- [x] 2.3 Vitest: mapping stability, join rules, drift guard, eligibility.
- [x] 2.4 Mapping hardening (follow-up pass): key hits must match names;
      name+version fallback with printing-evidence disambiguation; normalized
      name comparison (typography + stylized punctuation). Result:
      2,681/2,785 mapped (2,679 key + 2 name), 104 quest ineligible by
      design, 0 name mismatches, 0 unknown; regressions for each fixed issue
      (set7-026 collision → Moana must not resolve to Calhoun; Vaiana → its
      own engine card; Dalmatian Puppy → kvV; Heaaaaaaart → punctuation).
      Cache keyed on map format so remapping never reuses old records.

## 3. Arena runner — done

- [x] 3.1 `play.ts`: deterministic instance-id re-key (owner/cardId/index —
      the spike determinism fix), `createLorcanaServerGame` +
      `getCurrentActorId`/`takeAutomatedActionForCurrentActor` loop with
      per-seat strategies, fallback counters, lore timeline, termination
      guard, incomplete-game recording.
- [x] 3.2 `run.ts` batch CLI (`--deck`, `--opponent`, `--games`,
      `--strategies`, `--seed-base`, `--parallel`) writing JSONL under
      `scripts/training/data/arena/<engineCommit>/…`.
- [x] 3.3 Cache keyed by (deck pair, map format, strategy pair, seed base,
      game count, engine commit); reruns reuse, engine bumps and remaps never
      read older eras.
- [x] 3.4 Vitest: determinism replay (byte-identical), seed sensitivity,
      mapping/eligibility, cache-path keying, fixture legality.

## 4. Roadmap + docs — done

- [x] 4.1 `scripts/training/ROADMAP.md` (written during spike; header numbers
      updated with measured results).
- [x] 4.2 Arena + bump procedure documented in `README.md` (offline-only,
      like topdeck).
- [x] 4.3 Follow-up changes named in ROADMAP M2: `add-interaction-mining`,
      `add-inductive-card-encoder`, `add-synergy-deck-generation`.

## 5. Verification — done

- [x] 5.1 `npm run typecheck` (root + arena typecheck program with vendor
      shims), `npm test` (343 tests), `npm run lint` all green; vendor
      excluded from Biome, root tsc, and coverage gates (`vitest` covers
      `src/**` only).
- [x] 5.2 E2E: 20-game matchup deck-a vs deck-b (oracle vs fair-info
      strategies) in ~7 s across 4 workers, 20/20 finished, 0 errors;
      second run hits the cache and replays nothing.

## Spike addendum (implementation discoveries worth keeping)

- `fromDeckToCardInstances` seeds instance ids from `Math.random()` and the
  planner breaks ties by instance id — the runner MUST re-key
  deterministically (implemented in `play.ts`).
- Engine challenge/promo printings reuse the base card's set/collector fields;
  join keys must come from plain printing ids only (`set{n}-{num}`).
- Our snapshot's `setNumber` is always 0; `setCode` carries the set.
- Our snapshot's collector numbers collide within a set (set 7: Calhoun base +
  Moana/Vaiana P2 promos all "26") — the name-match gate is what keeps the
  join honest; flagged as a data-pipeline needs-review.
- `@logtape/pretty` must pair with `@logtape/logtape@^2.4.2` (peer range).
- Vendor sources are typechecked upstream with a different TS toolchain; the
  arena typecheck program resolves `@tcg/*` through hand-rolled shims
  (`arena/types/*.d.ts` + `tsconfig.typecheck.json`) so vendor sources never
  enter our program.
