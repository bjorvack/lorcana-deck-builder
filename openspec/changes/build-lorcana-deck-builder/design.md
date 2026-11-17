# Design

## Context

Empty repository; greenfield app. All data decisions were verified against live sources during planning:

- **lorcanajson.org** is the only source with `story` (franchise, 100% coverage over 3,556 cards), `colors` (dual-ink), `maxCopiesInDeck` (rule exceptions: Dalmatian Puppy = 99, Microbots = unlimited, absent = 4), `allowedInFormats` (Core rotation/bans). It sends **no CORS headers**, so it is only usable at build time.
- **api.lorcast.com** has CORS `*` and serves prices (`prices.usd`), `classifications`, and avif images, but its `ink` field is `null` for all dual-ink cards — useless for color logic, fine for prices/images.
- Core Constructed rules: minimum 60 cards, max 4 copies per full name (exceptions via `maxCopiesInDeck`), two declared inks, all cards must be one of them; dual-ink cards require **both** inks to match the declared pair; Quest sets are not tournament-legal.

## Goals / Non-Goals

**Goals:**
- Static app that works offline after first load (snapshot bundled, images lazy-loaded from CDNs).
- Pure, heavily unit-tested logic modules (rules, stats, generator, tagger) independent of React.
- Reproducible data pipeline: pinned sources, checksums, validation report, committed snapshot diffs.

**Non-Goals:**
- Runtime "live refresh" of card data (deferred; snapshot + weekly Action is current enough).
- Collection management, card prices in UI beyond detail view, meta/playrate tagging (needs external deck data).
- Multi-language UI (snapshot is English-only in v1); mobile-native builds.

## Decisions

- **Vite + React 18 + TypeScript, no UI/state libraries.** Card grids, filter panels, and stats are simple enough; hash-based routing avoids server rewrites on Pages. Alternative (Next.js) rejected: static export adds weight with no benefit here.
- **Snapshot committed to repo** (`public/data/cards.min.json` + `sets.json` + `meta.json`): the site gains offline capability and each refresh is a reviewable git diff. Alternative (fetch at runtime from a CORS proxy) rejected: extra moving part, proxy flakiness.
- **Canonical Card schema mirrors lorcanajson, not Lorcast**, because lorcanajson carries every field we need; Lorcast only *fills gaps* (prices, second image). `inks: string[]` + `isDualInk` derived from `colors`; `maxCopies: number | "unlimited"` normalized from `maxCopiesInDeck` (absent → 4, null → unlimited).
- **Rules engine as declarative checks** returning `Violation[]` (`rule`, `cardIds`, `message`), grouped by full name across prints (variants/reprints share `fullName`; use `simpleName`-style normalization + set-agnostic identity). Pure functions over `(deck, cards, options)`; no React imports.
- **Text-driven rule modifiers via structured effects + curated override table.** Copy limits are fully data-driven (`maxCopiesInDeck`: absent = 4, 2 = Glass Slipper, 99 = Dalmatian Puppy, null = unlimited Microbots). Ink exemptions exist only in card text (Christopher Robin - Hunny Sage: Hunny characters legal regardless of ink) and come from a repo-owned table keyed by card id emitting `deckRuleEffects`. The validator collects active effects from the deck before checking ink legality. Conservative stance: the exemption does not lift the dual-ink both-inks rule — moot today (all dual-ink Hunny cards are Amethyst/Sapphire, same as Christopher Robin), and flagged in the UI as an assumption. Text parsing of exemptions is deliberately avoided; new rule-modifying cards are caught by a pipeline scan that greps deck-rule phrasing ("regardless of ink", "any number of cards named", "copies of ... in your deck") against the override table and reports unknowns for review.
- **Tagging: deterministic rules only in v1**, rules file at `scripts/tag-rules.json` (tag → include/exclude regexes). Tags ship with provenance; a `needs-review` list surfaces unclassifiable cards in the CI report. Embedding-model phase explicitly deferred — schema (`provenance`, confidence) is in place for it.
- **Generator: constraint-driven fill.** Build allowed pool (declared inks incl. dual-ink filter, format, optional set/franchise), respect existing partial deck, then fill: smart mode scores candidates (inkable weight, curve position 2–4, type mix, copy-limit weighting), chaos mode samples uniformly. Relaxation ladder: drop optional filters → fail with reason. Deterministic with seeded RNG (seedable for tests).
- **Persistence: localStorage key `ldb.deck.v1`**; text format `COUNTx Full Name`; URL shares via `?deck=<base64url json>`. Deck codec round-trip tested.
- **Stats: plain SVG bar charts** (no chart library) — curves, distributions; keeps bundle small.
- **Images:** `images.thumbnail`/`full` from lorcanajson (official-app CDN), Lorcast `image_uris.digital` as fallback chain.

## Risks / Trade-offs

- [Snapshot grows with each set (currently ~3.5k cards, few MB JSON)] → compact JSON, per-field pruning of unused lorcanajson fields; gzip on Pages makes it small in practice.
- [Upstream schema change in lorcanajson breaks pipeline] → pipeline validates required fields and exits non-zero; MD5 + per-set count checks catch partial data.
- [Text-pattern tagging false positives (negations like "opponent can't draw")] → exclude-patterns per tag in rules file; needs-review list; tags are advisory data, not rules input.
- [Copy-limit identity across reprints] → group by normalized full name; manual override table available if a rare edge case appears.
- [Pages base path mismatch] → build reads `BASE_PATH` env set to repo name in the deploy workflow.

## Migration Plan

Greenfield: scaffold → pipeline (fixtures + tests) → pure modules → UI → workflows. Rollback is trivial (git). No data migration.

## Open Questions

None blocking; the deferred embedding-model phase and runtime refresh are recorded as future changes.
