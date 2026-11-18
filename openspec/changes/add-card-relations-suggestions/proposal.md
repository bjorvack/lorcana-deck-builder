# Proposal

## Why

The analysis panel describes pace, consistency, and meta fit, but cannot answer the most common deckbuilding question: "what should I add?". Two complementary signals exist and have different natural lifecycles: card **relations** (what appears alongside what) evolve weekly as tournament decks arrive, while card **content** (what a card does) is static per card and only changes when a set or errata lands. Co-occurrence embeddings trained weekly on the tournament stream capture the former; deterministic text-feature vectors computed from the card snapshot capture the latter — including complete cold-start coverage for brand-new sets.

## What Changes

- **Weekly meta-model artifact** (`meta-model.json`): co-occurrence relation embeddings (skip-gram with negative sampling over the accumulated, canonicalized tournament corpus) plus the calibration data (archetype stats, per-card top-cut weights) — retrained on every sync; relation and calibration capabilities are gated **independently** (relation coherence check vs win-rate MAE), so one failing does not block the other.
- **Canonical card registry**: one embedding identity per card — the latest print per `fullName` (newest release date) — so reprints never duplicate embeddings and errata flow in automatically via the snapshot. Deck lists are canonicalized at training time; the client canonicalizes from its own snapshot (`groupKey` + release date).
- **Client-side text-feature embeddings**: a deterministic pure function of card content (game keywords, gameplay tags, type, cost band, ink, scaled stats) computed in the browser from the live snapshot — no artifact bytes, no pipeline step, unchanged cards derive identical vectors automatically.
- **`suggestCards()`**: fused suggestion scoring (co-occurrence similarity + text similarity, documented weights) with legality filters — format, declared inks, group copy limits, cards already in the deck — returning the top 8 with an affinity basis label.
- **Analysis panel "Suggested additions" section**: cost badge, ink dots, similarity, basis label, add-on-click; hidden when the artifact lacks relation embeddings; quiet empty state when the pool is exhausted.
- **Non-goals**: no runtime external calls; no transformer/text-model dependencies (feature vectors come from already-parsed data); no per-print embeddings; suggestions make no win-rate claims — the basis label says "appears alongside in tournament decks" / "plays similarly".

## Capabilities

### New Capabilities

(none — this change refines the existing `meta-model` capability)

### Modified Capabilities

- `meta-model`: the artifact becomes a weekly `meta-model.json` carrying relation embeddings and calibration as independently gated capabilities; the suggestion requirement is detailed (canonical identity, fused scoring, legality filters, affinity basis); new requirements cover client-side text-feature derivation and the canonical card identity rule.

## Impact

- **Code**: `scripts/training/train.ts` (relation training + capability gates), new `scripts/training/canonical.ts` (registry), `src/meta/infer.ts` (text features, suggestCards), `src/ui/AnalysisPanel.tsx` (suggestions section), `src/ui/DeckView.tsx` (wiring), `.github/workflows/data.yml` (trainer command/emit path verified).
- **Artifacts**: `public/data/meta-model.json` gains relation embeddings (Int16-quantized, base64) and a `capabilities` block; size budget check (≤ 300 KB gzip) unchanged.
- **Cadences**: relation training + calibration run on every weekly sync (cheap — full retrain of the accumulated corpus, well under a second at current scale); text features recompute client-side only when the snapshot changes.
- **Dependencies**: none new; the trainer stays dependency-free (SGNS + k-means hand-rolled, seeded).
