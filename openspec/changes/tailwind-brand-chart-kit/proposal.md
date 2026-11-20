# Proposal

## Why

The UI has outgrown its single global stylesheet: every PR appends to `styles.css` (two merge conflicts already), there is no token-driven theming, and the charts are one-off components. At the same time the project should align its frame with the official Disney Lorcana brand palette (public media guide) instead of ad-hoc colors. Adopting Tailwind v4 with the brand palette as design tokens, and consolidating all charts behind a reusable Recharts kit, makes every future UI change cheaper and the look officially on-brand.

## What Changes

- **Adopt Tailwind v4** (`@tailwindcss/vite`, CSS-first `@theme`) as the styling system; no CSS framework previously.
- **Adopt the official Disney Lorcana brand palette** (public media guide) as design tokens: Lorcana Indigo `#373B70` (interactive), Illuminary Gold `#D3BA84` (accent), Parchment `#E3CAA8` (light text/highlights), Kelp `#1C1C1A` (foundation) — the frame colors that complement the six ink colors. The six **ink colors stay unchanged** as game-data colors.
- **Migrate all views** (shell/header, Browse, Deck, Generator, AnalysisPanel) from `styles.css` classes to Tailwind utilities, one view per PR, each visually verified at 1280px and 390px; `styles.css` is **removed** at the end.
- **Consolidate all charts behind a reusable Recharts kit** (`src/ui/charts/`): generic `Donut`, `RadarChart`, `MultiLineChart`, `BarsWithLine` primitives + a shared chart theme; the app-specific charts (ink split, viability, lore race, curve consistency, histograms, ink-curve bars) become thin configurations. The cost × ink heatmap stays a custom SVG component (no library heatmap).
- **Compliance guardrails** (per the media guide's terms): keep the app's own text wordmark (no official logo, no trade-dress imitation); keep the footer disclaimer and Community Code reference.
- Charts remain lazy-loaded in a separate chunk; `role="img"` + aria-labels are preserved and extended.

## Capabilities

### New Capabilities
- `ui-design-system`: owns the brand token palette, the Tailwind-based styling contract (tokens are the single source of truth for color/spacing/typography), per-view style ownership, and brand compliance guardrails.
- `chart-visualization`: owns the reusable chart primitives (donut, radar, multi-line, composed bar+line, stacked bars), their accessible presentation (aria labels, tooltips), lazy loading, and the brand chart theme.

### Modified Capabilities
- `deck-fingerprint`: the analysis-panel presentation requirement changes — the viability profile renders as a radar (with a midpoint reference ring and per-axis value chips) instead of bars, and a lore-race line chart (our accumulated lore per turn vs the selected baseline) is added alongside the matchup win-rate bars.

## Impact

- **Dependencies**: adds `tailwindcss`, `@tailwindcss/vite`; `recharts` already present (since the rich-charts change).
- **Code**: `vite.config.ts` (Tailwind plugin), `src/styles.css` (deleted at the end), all components in `src/ui/`, new `src/ui/charts/` kit, `src/ui/charts-rich.tsx` (replaced by the kit).
- **Tests**: chart-kit tests rewritten against the primitives; per-view suites keep passing; visual verification via before/after screenshots per view (1280px + 390px).
- **Delivery**: no pipeline change; the charts remain a lazy async chunk so the initial bundle stays ~97 KB gz.
