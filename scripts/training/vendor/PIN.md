# Vendor pin — TheCardGoat lorcana engine

Upstream: https://github.com/TheCardGoat/tcg-engines
Upstream commit: `6de59de1c203827edc1bc6faa1bc6184cd126a5f`
Pulled: 2026-11-20

## What is vendored

A minimal runtime subset of the upstream monorepo (upstream packages are
`private: true` — not published to npm — so a pinned checkout is the only
install path):

| Vendor path | Upstream | Notes |
|---|---|---|
| `lorcana-engine/src` | `submodules/lorcana/packages/lorcana/lorcana-engine/src` | rules engine + automation planner |
| `lorcana-types/src` | `…/lorcana-types/src` | card/effect type system |
| `lorcana-cards/src` | `…/lorcana-cards/src` | only `cards/`, `helpers/`, `utils/`, `index.ts` |
| `bot-core/src` | `submodules/agnostic-simulator/packages/bot-core/src` | strategy contracts |
| `shared/src` | `submodules/agnostic-simulator/packages/shared/src` | card-catalog + deck-list parsing |
| `protocol/src` | `submodules/agnostic-simulator/packages/protocol/src` | imported by shared |
| `stubs/@discord/embedded-app-sdk` | — | upstream's shared module imports it for Discord rich presence, unused headless |

## Exclusion rules (re-applied by `pull.ts` on every bump)

- `**/*.test.ts` (upstream tests; our own tests live in `scripts/training/arena/`)
- `lorcana-cards/src/data/` (canonical/aux JSONs; the runtime catalog is
  `cards/catalog-data.ts`, which is what deck construction consumes)
- `lorcana-cards/src/{pack-simulator,parser,testing}/`,
  `__digest-*/`, `test-globals.d.ts`
- localization `*.i18n.ts` card-text files are kept (they feed card text)
- package.json: entries for internal `@tcg/*` packages and any
  `link:`/`workspace:`/`catalog:` versions are removed (npm cannot resolve
  them inside `file:` deps — the packages come from the repo root's own
  `file:` entries), and upstream `devDependencies` are dropped

## Update procedure (engine bump)

1. `git clone --depth 1 https://github.com/TheCardGoat/tcg-engines` (or fetch
   in an existing checkout) and check out the new upstream commit.
2. Update the commit line above to match.
3. `npx tsx scripts/training/vendor/pull.ts <checkout>` — it verifies the pin
   matches the checkout HEAD before copying.
4. Re-run the mapping script and the arena tests (determinism + throughput
   smoke) and commit.

## Attribution

Upstream is MIT licensed — see `lorcana-engine`'s repository `LICENSE` /
`DISCLAIMER.md` (https://github.com/TheCardGoat/tcg-engines). This is an
unofficial fan tool; Disney Lorcana is a trademark of Disney, © Ravensburger.
The vendored code is used unmodified and only from `scripts/training/`.
