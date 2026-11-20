# Design

## Context

The app is a static Vite + React 19 site (GitHub Pages) with a single 1,170-line global stylesheet and a coherent dark identity. Recharts 3 is already integrated behind a lazy async chunk (`charts-rich.tsx`, 145 KB gz) with four one-off charts. The official Disney Lorcana brand palette (Kelp `#1C1C1A`, Lorcana Indigo `#373B70`, Illuminary Gold `#D3BA84`, Parchment `#E3CAA8`) comes from the public Ravensburger media guide and is designed to complement the six ink colors. PR #14 established the responsive behaviors (filter drawer, compact brand, tappable deck rows) that the migration must preserve.

## Goals / Non-Goals

**Goals:**
- Tailwind v4 as the only styling system; brand tokens as the single color source.
- Pixel-safe, view-by-view migration with screenshot verification (1280px + 390px).
- A reusable chart kit (`src/ui/charts/`) where app charts are thin configurations.
- Zero initial-bundle regression (charts stay in the lazy chunk).

**Non-Goals:**
- No visual redesign beyond the brand palette (layout and information architecture stay as reviewed).
- No dark/light theme switch (the app is always dark).
- No migration of the cost × ink heatmap to a chart library (no library heatmap exists; it stays custom SVG).
- No official logo usage or trade-dress imitation (brand compliance guardrail).

## Decisions

- **Tailwind v4 with CSS-first `@theme`, no `tailwind.config.js`.** The Vite plugin keeps the build single-tool; `@theme` maps the brand palette to utilities (`bg-kelp`, `text-gold`, `border-indigo`…). Alternative considered: Tailwind v3 config file — more boilerplate, no benefit on v4.
- **Brand palette replaces the old ad-hoc palette 1:1 at the token level**, not per component: `--bg → kelp`, accent `#d9a520 → gold`, interactive blues → indigo, headings → parchment. Ink colors (`INK_COLORS` in `charts.tsx`) remain a JS constant because they are data-driven (dynamic per card) — Tailwind owns static styling only.
- **Component bridge classes in `@layer components`** (`.panel`, `.btn`, `.chip`, `.bar-row`) so early PRs don't have to inline every utility. They are deleted in the final PR as views inline their utilities. Alternative: full inline from day one — noisier diffs, no benefit during migration.
- **One view per PR with screenshot verification.** Each PR is revertible; before/after screenshots at 1280px and 390px are the visual-regression net (no pixel-diff tooling exists).
- **Chart kit as primitives + thin configs.** `src/ui/charts/` exports `Donut`, `RadarChart`, `MultiLineChart`, `BarsWithLine`, `StackedBars`, `chartTheme` (palette, tooltip style, axis/legend props). The current `charts-rich.tsx` charts become configurations; the generic `Bar`/`StatDistributions` div charts migrate to `StackedBars`/`BarsWithLine`. The heatmap stays custom. Alternative considered: keep div charts — rejected, the user wants all graphs on the library for consistency.
- **Explicit chart dimensions (no `ResponsiveContainer`)**, scaled via CSS `max-width: 100%; height: auto` — deterministic in jsdom tests and avoids zero-height rendering pitfalls.
- **Lazy chunk preserved**: the kit stays behind `React.lazy` with the current Suspense placeholders.

## Risks / Trade-offs

- [Visual regressions during migration] → per-view before/after screenshots at two widths reviewed in each PR; view-scoped PRs are small and revertible.
- [Recharts bundle size (145 KB gz chunk)] → acceptable: async, below the fold, initial bundle unchanged; revisiting visx is cheap later because all charts go through the kit boundary.
- [`@apply` bridge classes delay full utility adoption] → they are explicitly temporary; the final PR deletes them.
- [Brand colors reduce contrast on some surfaces (gold on kelp)] → verify text contrast per view in the screenshot review; parchment carries body text, gold is accent-only.
- [Merge conflicts while `styles.css` still exists mid-migration] → accepted, short-lived: each migrated view deletes its block; by PR D the file is gone.

## Migration Plan

1. **PR A** — Tailwind scaffold: plugin, `@theme` tokens, component bridge classes; shell (header/background/buttons) re-themed. App identical apart from brand colors.
2. **PR B** — Browse (header, filter drawer, card tiles, pagination, suggestion strip).
3. **PR C** — Deck view (controls, deck list, IO panel, stats grid layout, empty state).
4. **PR D** — Generator + AnalysisPanel; delete `styles.css` and the bridge classes.
5. **PR E** — chart kit: `src/ui/charts/` primitives, migrate all charts, remove `charts-rich.tsx`.

Each PR: full test suite green, typecheck + Biome clean, screenshots attached. Rollback = revert the single view PR.

## Open Questions

- None blocking. Final hex for the derived panel surfaces (Kelp-tinted vs Indigo-tinted darks) is chosen during PR A against the screenshot review.
