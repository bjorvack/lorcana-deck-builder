# Contributing

## Setup

```bash
nvm use          # Node 22 (.nvmrc)
npm install      # installs dependencies and git hooks (lefthook)
npm run dev      # local dev server
```

## Quality gates

| Command | What it does |
| --- | --- |
| `npm run lint` | Biome lint + format check (`lint:fix` to auto-fix) |
| `npm run typecheck` | `tsc --noEmit` (strict mode) |
| `npm test` | Vitest suite |
| `npm run test:coverage` | Vitest with coverage thresholds |
| `npm run build` | typecheck + vite build |

All of these run in CI on every PR and must pass before merge. Git hooks
(installed automatically on `npm install`) run the same checks locally:

- **pre-commit** — `biome check --write` on staged files
- **commit-msg** — commitlint (Conventional Commits)
- **pre-push** — typecheck + full test suite

CI is authoritative; hooks are only for fast feedback.

## Commits

Messages must follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): summary`. Allowed types: `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `chore`, `build`, `ci`. Examples from this repo:

```
feat(generate): slider-driven suggest-fill generator
fix(ui): truthful meta-fit panel and lift-based archetype names
chore(data): weekly snapshot + meta sync
```

Enforced by commitlint in CI and via the commit-msg hook.

## Tests

- New features and bug fixes must ship with tests. CI enforces per-directory
  coverage thresholds (`src/rules`, `src/stats`, `src/generate`, `src/meta`,
  `src/deck`, `src/text`, `src/ui`) — coverage must not regress.
- Thresholds are set just below the current baseline and are meant to be
  ratcheted up over time. Keep new logic fully covered so the bar can tighten.
- Entry points (`main.tsx`) and `src/state.tsx` are not gated yet; prefer
  adding tests there too.

## Code style

Enforced by Biome (`biome.json`). Two deliberate allowances:

- `noNonNullAssertion` is off — non-null assertions are pervasive in this
  codebase together with `noUncheckedIndexedAccess` (bounds-checked
  `arr[i]!`). Banning them is a separate refactor.
- `useMathMinMax` is off — its unsafe fix corrupts ISO date-string
  comparisons (`Math.max('2026-01-01', '')` coerces to numbers); date-string
  comparisons stay as ternaries.

Markdown and YAML files are excluded from formatting (openspec-managed
specs, hand-written workflow quoting), as are committed data snapshots
(`public/data/`, `scripts/training/data/`).

## PRs

Open PRs against `main` using the PR template. Merging is blocked until CI
passes (lint, commitlint, typecheck, coverage, build) — make sure required
status checks are enabled in the repo's branch protection settings
(Settings → Branches), including for administrators.
