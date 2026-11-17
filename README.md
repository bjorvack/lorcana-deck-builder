# Lorcana Deck Builder

Browse every Disney Lorcana card, build rule-legal decks for any franchise/ink pool, and generate decks — as a static site on GitHub Pages. Unofficial fan tool, not affiliated with Disney or Ravensburger.

## Features

- **Browse** all cards (dual-ink, promos, Quest sets) with filters for franchise, ink, set, type, cost, rarity, gameplay/mechanic tags, and free text.
- **Deck building** with live legality validation: 60-card minimum, copy limits (including exceptions like *Dalmatian Puppy* ×99, *Microbots* unlimited, *The Glass Slipper* ×2), two-ink declaration, dual-ink rules, Core/Infinity formats, rotation and bans — plus card-text rule modifiers (e.g. *Christopher Robin – Hunny Sage* lets off-ink Hunny characters in).
- **Statistics**: inkability (overall + per cost), cost curve, inks, types, rarity, franchises, tag counts.
- **Generator** with a smart curve-aware mode and a chaos mode; completes a partial deck.
- **Persistence**: localStorage, plain-text import/export, shareable URLs (`?d=…`).

## Development

```bash
npm install
npm run dev          # local dev server
npm test             # vitest suite (rules, stats, generator, codec, pipeline)
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build
```

## Data pipeline

Card data comes from [lorcanajson.org](https://lorcanajson.org) (primary: text, franchise, dual-ink colors, copy limits, format legality) and the [Lorcast API](https://lorcast.com/docs/api) (supplementary: prices, second image source). Both are fetched **at build time only** — lorcanajson.org sends no CORS headers, so the app never calls APIs at runtime; it bundles a committed snapshot.

```bash
npm run data:fetch   # download to .data-cache/ (gitignored), verify MD5, fetch Lorcast (SKIP_LORCAST=1 to skip)
npm run data:build   # normalize → enrich → tag → emit public/data/*.json + validation report
npm run data:pipeline  # both steps
```

The build exits non-zero on checksum mismatch, per-set count mismatch, or any card missing its franchise. `public/data/report.json` documents needs-review items and derived fields.

A scheduled GitHub Action (`data.yml`, weekly) refreshes the snapshot and commits changes.

## Deployment

Pushes to `main` deploy to GitHub Pages via `deploy.yml` (base path = repo name). Enable Pages with the "GitHub Actions" source in the repository settings.

## Architecture

```
scripts/            data pipeline (fetch → normalize → enrich → tag → emit), tag rules + deck-rule overrides
src/data/           canonical Card schema + snapshot loader
src/rules/          deck legality engine (pure, typed violations)
src/stats/          deck statistics (pure)
src/generate/       smart/chaos generator with seeded RNG + constraint relaxation (pure)
src/deck/           persistence, text import/export, URL codec (pure)
src/ui/             Browse / Deck / Generator views (React)
public/data/        committed snapshot (cards, sets, meta, validation report)
```
