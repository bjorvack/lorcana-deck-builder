# Spec Delta

## Purpose

Owns the reusable chart primitives every quantitative view renders through: donut, radar, multi-series line, composed bar+line, and stacked bars, on the brand chart theme, accessible and lazy-loaded.

## ADDED Requirements

### Requirement: Reusable chart primitives

The app SHALL render charts through shared chart primitives — donut, radar, multi-series line, composed bar+line, and stacked bars — parameterized by data, series colors, labels and axis options. Adding a chart of an existing type SHALL require only data and configuration, not new charting code.

#### Scenario: Two charts of the same type share the primitive
- **WHEN** the ink-split donut and a future distribution donut render
- **THEN** both are configurations of the same donut primitive

#### Scenario: App charts are thin configurations
- **WHEN** the ink split, viability radar, lore race and curve-consistency charts render
- **THEN** each is a configuration of a kit primitive (data, colors, labels) with no bespoke charting logic

### Requirement: Brand chart theme

Charts SHALL draw with the brand palette: Illuminary Gold for the player's deck series, Lorcana Indigo and a neutral for baseline/opponent series, Parchment for text, Kelp-derived grid lines; ink-specific data uses the ink colors. Tooltip, legend and axis styling SHALL come from one shared chart theme.

#### Scenario: Deck vs baseline series colors
- **WHEN** the lore-race line chart renders the deck against a scripted baseline
- **THEN** the deck series is gold, the baseline series is dashed neutral/indigo, and both legend and tooltip follow the shared chart theme

### Requirement: Accessible chart presentation

Every chart SHALL expose `role="img"` with an `aria-label` summarizing the rendered data in text, and its data SHALL be available in the tooltip on hover and tap. Chart-only information SHALL NOT be inaccessible to assistive technology.

#### Scenario: Screen reader summary
- **WHEN** a chart renders
- **THEN** assistive technology can read a text summary of the data (e.g. "Ink split: Amber 26, Amethyst 34")

### Requirement: Lazy chart loading

The chart library SHALL load as a separate asynchronous chunk that the initial page load does not include; charts SHALL render a placeholder at their position until the chunk is ready.

#### Scenario: Initial load excludes the chart library
- **WHEN** the app loads without a populated deck view
- **THEN** the chart library chunk is not fetched

#### Scenario: Charts appear when needed
- **WHEN** a view containing charts renders
- **THEN** the placeholder shows briefly and the charts render once the chunk loads

### Requirement: Deck statistics chart presentation

The deck statistics SHALL present: the ink split as a donut with the total copy count in the center and dual-ink counts in the legend; curve consistency as composed bars (percentage of games on curve per turn) with the spendable-ink ramp as a line on a secondary axis; character stat, tag, rarity and franchise distributions as bar charts; and the cost × ink matrix as a custom component (no chart-library heatmap exists).

#### Scenario: Ink split donut
- **WHEN** a populated deck's statistics render
- **THEN** the ink split shows one donut segment per ink with the total copies centered and dual-ink counts in the legend

#### Scenario: Curve consistency with ink ramp
- **WHEN** curve consistency renders
- **THEN** the on-curve percentages show as bars per turn with the mean spendable ink overlaid as a line
