# Tasks

## 1. PR A — Tailwind scaffold + brand frame

- [x] 1.1 Commit and push the staged `styles.css` orphan fix on `fix/ui-mobile-rebalance`; verify PR #14 CI green; merge #14
- [x] 1.2 Branch off main; add `tailwindcss` + `@tailwindcss/vite`; wire the Vite plugin; `@import "tailwindcss"` entry
- [x] 1.3 Define `@theme` tokens: kelp `#1C1C1A`, indigo `#373B70`, gold `#D3BA84`, parchment `#E3CAA8`, panel surface derivations, plus the six ink colors as data-color aliases
- [x] 1.4 Recreate `.panel`, `.btn`, `.chip`, `.bar-row` and the base body styles in `@layer components` against the tokens; re-theme the shell (header background, LDB/brand-full variants, buttons, focus rings)
- [x] 1.5 Verify: app renders with brand frame, screenshots at 1280px + 390px match pre-migration layout; full test suite, typecheck, Biome green; open PR A

## 2. PR B — Browse migration

- [x] 2.1 Migrate the Browse view (search bar, filter drawer + toggle, ink chips, suggestion strip, result count) to utilities; delete the migrated `styles.css` blocks
- [x] 2.2 Migrate card tiles, cost badge and ink dots to utilities (dynamic ink fills stay inline styles)
- [x] 2.3 Before/after screenshots at 1280px + 390px; suite + gates green; open PR B *(screenshot comparison waived by user; parity verified rule-by-rule, PR #18)*

## 3. PR C — Deck view migration

- [x] 3.1 Migrate deck controls, deck list rows (steppers, refusal notes), IO panel and validation panel to utilities; delete migrated blocks
- [x] 3.2 Migrate the stats grid layout, empty state and card-insights tabs to utilities
- [x] 3.3 Before/after screenshots at 1280px + 390px; suite + gates green; open PR C *(screenshot comparison waived by user; parity verified rule-by-rule, PR #19)*

## 4. PR D — Generator, AnalysisPanel, styles.css removal

- [x] 4.1 Migrate the Generator view (ink picker, sliders, archetype selector, notes) to utilities
- [x] 4.2 Migrate the AnalysisPanel (radar block, matchup bars, race tabs, meta section) and the card modal/preview to utilities
- [x] 4.3 Delete `styles.css` and the `@layer components` bridge classes; verify zero unreferenced CSS and no visual drift *(tokens/base moved to `theme.css`; bridge patterns → `src/ui/styles.ts` constants; shell, AddSearch, ErrorBoundary and the div-chart components migrated in the same pass since styles.css had to go)*
- [ ] 4.4 Before/after screenshots at 1280px + 390px; suite + gates green; open PR D

## 5. PR E — reusable chart kit

- [ ] 5.1 Create `src/ui/charts/theme.ts` (brand chart palette, shared tooltip/axis/legend props) and the primitives: `Donut`, `RadarChart`, `MultiLineChart`, `BarsWithLine`, `StackedBars`
- [ ] 5.2 Re-express the app charts as kit configurations: ink-split donut, viability radar (midpoint ring), lore-race lines (baseline tabs), curve consistency (bars + ink line), ink-curve stacked bars, stat histograms; keep the cost × ink heatmap as custom SVG
- [ ] 5.3 Rewrite chart tests against the primitives (labels, aria summaries, series rendering, profile switching); keep lazy chunk + Suspense placeholders
- [ ] 5.4 Remove `charts-rich.tsx`; screenshots of all charts at 1280px + 390px; suite + gates green; open PR E

## 6. Verification

- [ ] 6.1 Full suite, typecheck, Biome and coverage gates green on every PR; initial bundle ≤ ~97 KB gz verified after PR E
- [ ] 6.2 Final review pass: brand tokens are the only color source (no hardcoded colors outside ink data), no `styles.css`, no official logo usage, footer disclaimer intact
