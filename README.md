# Lorcana Deck Builder

Browse every Disney Lorcana card, build rule-legal decks for any franchise/ink pool, and generate decks — as a static site on GitHub Pages. Unofficial fan tool, not affiliated with Disney or Ravensburger.

## Features

- **Browse** all cards (dual-ink, promos, Quest sets) with filters for franchise, ink, set, type, cost, rarity, gameplay/mechanic tags, and free text.
- **Deck building** with live legality validation: 60-card minimum, copy limits (including exceptions like *Dalmatian Puppy* ×99, *Microbots* unlimited, *The Glass Slipper* ×2), two-ink declaration, dual-ink rules, Core/Infinity formats, rotation and bans — plus card-text rule modifiers (e.g. *Christopher Robin – Hunny Sage* lets off-ink Hunny characters in).
- **Statistics dashboard**: inkability (overall + per cost), cost curve with per-column counts, cost × ink heatmap, ink-split bar (dual-ink hatching), character stat distributions, tag/rarity/franchise bars, opening-hand odds.
- **Deck analysis** (valid 60-card decks): a viability profile (Tempo / Consistency / Resilience / Interaction / Reach) from seeded simulations — curve consistency with card effects (Sing, cost reduction, ramp, flooding), opening-hand quality under the real alteration rule, and lore-race estimates against three scripted opponent baselines. Every number carries a tooltip explaining its derivation; all compute is local and deterministic.
- **Meta fit** (when a trained model artifact ships): archetype matching with observed tournament win rates and a viability score split into sim strength + meta alignment. Trained offline from tournament data; without the artifact the panel degrades to deterministic metrics only.
- **Suggested additions** (when the artifact's relation capability ships): "what should I add?" — top-8 candidate cards ranked by fused tournament co-occurrence + card-content similarity, filtered to deck legality, each with a visible affinity basis label.
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

### Meta model (optional artifact)

Tournament data for the meta-fit feature comes from [TopDeck.gg](https://topdeck.gg) and [Lorcanahunter](https://lorcanahunter.com) — fetched **offline only** (never from the running app):

```bash
npx tsx scripts/sources/topdeck.ts       # TOPDECK_API_KEY in .env — incremental sync (only new events; --full to reset)
npx tsx scripts/sources/lorcanahunter.ts # LH_CLIENT_ID/LH_CLIENT_SECRET once the application is approved
npm run data:inkdecks                    # local backfill only — see below
npx tsx scripts/training/train.ts        # trains on scripts/training/data/*.json, holdout-gated
npm run data:pipeline                    # emits public/data/meta-model.json when a training gate passed
```

The `inkdecks` fetcher is **not** an API client: inkdecks.com has no public API and its terms forbid automated access, so it exists as a one-time, locally-directed backfill that drives a real, visible Chrome on your own machine (resumable phases: `--phases=index,tournaments`, then `--phases=decks`, then `--phases=build`; progress cached in `.data-cache/inkdecks/`). It must never run in CI, and a written permission from inkdecks supersedes it. Inkdecks data is used with attribution in the analysis panel footer.

The fetchers are **incremental**: per-event caches and the sync state live in `scripts/training/data/<source>/` (committed), so each run fetches only events newer than the last synced date minus a 7-day overlap — completed events are never refetched. The GitHub Actions weekly run (`data.yml`) performs the same sync and commits the changed state. Training publishes only when a capability passes its gate — **calibration** (win-rate MAE must beat a global-mean baseline on a recent-events holdout) and **relations** (co-occurrence embedding coherence on holdout decks) gate independently; failing parts are omitted, and with no passing capability no artifact ships and the app stays deterministic-only.

When the artifact ships, the deck analysis panel gains the **"Suggested additions"** section: candidate cards ranked by a fused similarity — 60% tournament co-occurrence (relation embeddings from the weekly corpus, keyed to one canonical identity per card: the newest print of a full name) + 40% card-content similarity (text-feature vectors derived client-side from keywords, tags, type, cost band, ink and stats — no artifact bytes, cold-start coverage for new sets) — filtered to the deck's format, declared inks and copy limits, each with a visible affinity basis label. Run the topdeck/lorcanahunter fetchers at most weekly — both APIs are rate limited and their terms require visible attribution (shown in the analysis panel footer).

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
