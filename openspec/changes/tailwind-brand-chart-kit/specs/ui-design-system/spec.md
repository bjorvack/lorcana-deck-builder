# Spec Delta

## Purpose

Owns the application's visual theme: the official Disney Lorcana brand palette as design tokens, Tailwind-based styling ownership, responsive presentation rules, and brand-compliance guardrails. Every view's look derives from these tokens; no component hardcodes colors outside the ink data colors.

## ADDED Requirements

### Requirement: Brand token palette

The app SHALL define its visual theme exclusively through design tokens: foundation **Kelp** `#1C1C1A`, primary **Lorcana Indigo** `#373B70`, accent **Illuminary Gold** `#D3BA84`, light neutral **Parchment** `#E3CAA8` (the official Disney Lorcana brand colors), plus the six ink colors as game-data colors. Components SHALL NOT hardcode colors outside these tokens and the ink palette.

#### Scenario: Tokens drive the theme
- **WHEN** any view renders
- **THEN** its background, panels, text, interactive accents and highlights derive from the brand tokens, and the six ink colors appear only where game data is ink-specific

#### Scenario: Interactive states use the primary and accent tokens
- **WHEN** a primary button, active tab, focus ring or selected filter renders
- **THEN** it uses Lorcana Indigo or Illuminary Gold, not ad-hoc colors

### Requirement: Tailwind is the styling system

The app SHALL be styled with Tailwind utilities and token-derived theme values; the legacy global stylesheet SHALL be removed once all views are migrated. Recurring multi-property patterns MAY be encapsulated as component classes defined against the tokens.

#### Scenario: Legacy stylesheet removed
- **WHEN** the migration is complete
- **THEN** no global `styles.css` remains and all styling resolves through Tailwind and the token theme

#### Scenario: App renders identically after migration
- **WHEN** a view is migrated to Tailwind
- **THEN** its layout, content and interactions are unchanged apart from the token-driven brand colors, verified by before/after screenshots at desktop and mobile widths

### Requirement: Per-view style ownership

Styling for each view SHALL be owned by that view (colocated with the component or scoped to it) such that independently changing one view's presentation does not require editing shared style code owned by other views.

#### Scenario: Parallel view styling
- **WHEN** two views are restyled in parallel branches
- **THEN** the changes touch disjoint files and produce no merge conflicts in shared style code

### Requirement: Responsive presentation rules

Below a 720px viewport the app SHALL render a compact brand mark in the header, hide the data-source caption, and collapse the catalog filter selects behind a toggle labelled with the number of active filters; the search field and ink filter chips SHALL remain visible.

#### Scenario: Compact header on mobile
- **WHEN** the viewport is narrower than 720px
- **THEN** the header shows the compact brand mark and omits the data-source caption

#### Scenario: Collapsed filter drawer
- **WHEN** the viewport is narrower than 720px and the user has one active filter
- **THEN** the filter selects are hidden behind a toggle labelled "Filters (1)" until expanded

### Requirement: Brand compliance guardrails

The app SHALL NOT display official Disney Lorcana/Ravensburger logos or imitate brand trade dress; it SHALL keep its own text wordmark, the fan-tool disclaimer, and the Community Code reference. Brand colors and materials SHALL be used only for identification and discussion of the game.

#### Scenario: No official logo
- **WHEN** the header or any view renders
- **THEN** the brand mark is the app's own text wordmark, and the footer disclaimer with the Community Code reference is visible
