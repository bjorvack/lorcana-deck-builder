# Proposal

## Why

Disney Lorcana players have no lightweight, self-hosted tool to browse the full card database, build rule-legal decks for a chosen franchise/ink pool, and get instant deck statistics. Existing sites are closed-source, API-less, or drop data we need (franchise, dual-ink colors, deck-rule exceptions). A static GitHub Pages app with a build-time data pipeline solves this with zero server cost.

## What Changes

- Introduce a build-time data pipeline (GitHub Actions, scheduled weekly + on demand) that fetches lorcanajson.org (primary) and the Lorcast API (supplementary prices/second image source), normalizes both into one canonical card schema, enriches missing fields, applies rule-based game-mechanic tags, and emits a versioned JSON snapshot committed to the repo.
- Introduce a React + Vite + TypeScript single-page app for GitHub Pages with three views: card browser (filter by franchise, ink, set, type, cost, rarity, tags, text), deck builder (live legality validation + statistics), and deck generator (smart curve-aware + chaos modes, completes a partial deck).
- Implement a pure deck-rules engine covering: 60-card minimum, per-full-name copy limits (including dataset exceptions like 99-copy and unlimited cards), two-ink declaration, dual-ink card legality, Core/Infinity format legality (rotation + bans), and Quest-set tournament illegality.
- Implement deck statistics: inkability (overall + per cost), ink distribution, cost curve, card types, rarity, franchise breakdown, and tag distribution for both decks and filtered pools.
- Implement deck persistence: localStorage, plain-text import/export, and shareable URL encoding.
- Add CI (typecheck + tests + build), scheduled data-refresh workflow, and GitHub Pages deployment workflow.

## Capabilities

### New Capabilities

- `card-data-pipeline`: Build-time ingestion, normalization, enrichment, rule-based tagging, and snapshot emission of all Lorcana card data from external sources.
- `card-catalog`: Browsing, filtering, and searching all cards with images and detail views in the web app.
- `deck-rules`: Deck legality validation covering card counts, copy limits and their exceptions, ink restrictions, dual-ink cards, and format legality.
- `deck-statistics`: Computed deck and card-pool statistics (inkability, ink colors, cost curve, types, rarity, franchise, tags).
- `deck-generation`: Generating legal 60-card decks from ink/set/franchise choices with optional partial-deck completion, in smart and chaos modes.
- `deck-persistence`: Saving, importing, exporting, and sharing decks.
- `site-delivery`: Static hosting on GitHub Pages, CI quality gates, and scheduled snapshot refresh.

### Modified Capabilities

(none — greenfield)

## Impact

- New code: `src/` (React app + pure logic modules), `scripts/` (pipeline, Node), `public/data/` (committed snapshot), `.github/workflows/` (3 workflows), tests via Vitest.
- New dependencies: react, react-dom, vite, typescript, vitest. No runtime API dependencies — data is bundled.
- External systems: lorcanajson.org (no CORS → build-time only), api.lorcast.com (CORS open), both used by CI only.
- Repository becomes a git repo with Pages deployment (`base` path = `/lorcana-deck-builder/`).
