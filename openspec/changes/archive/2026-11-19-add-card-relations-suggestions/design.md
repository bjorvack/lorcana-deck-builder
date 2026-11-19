# Design

## Context

Phases 1–4 of `add-deck-viability-analysis` shipped the deterministic fingerprint, goldfish race, analysis panel, and the meta-model client/emit plumbing. The weekly sync (incremental, committed state) is live for TopDeck; Lorcanahunter awaits approval. The remaining phase-5 scope — relation embeddings and suggestions — was re-planned around two user constraints: card embeddings update only when cards change, while relations evolve weekly from the tournament stream; and embeddings must key on one identity per card, resolved to the latest print, because wording/keywords/classifications can change between printings.

## Goals / Non-Goals

**Goals:**

- Weekly `meta-model.json` with independently gated capabilities: relation embeddings (coherence gate) and calibration (win-rate MAE gate, unchanged)
- Deterministic client-side text-feature vectors — zero artifact bytes, complete cold-start coverage
- Canonical card identity shared by trainer and client
- Suggestions fused from both spaces with strict legality filters and visible basis
- Determinism everywhere (seeded SGNS, pure-function text features)

**Non-Goals:**

- Transformer/text-model dependencies (feature vectors come from already-parsed card data)
- Per-print embeddings; shipping text vectors in the artifact (they derive client-side)
- Win-rate claims for suggestions (basis labels are co-occurrence/similarity statements)
- Incremental/frozen embedding training (full retrain each run is cheap and keeps relations current — user decision)

## Decisions

**D1 — Canonical card registry from the snapshot.**
`scripts/training/canonical.ts` builds `Map<printId, canonicalId>` by grouping `cards.min.json` on `groupKey` (full name, lowercased — already emitted) and picking the print with the newest `releasedAt` (tiebreak: highest `setCode`). The client resolves identically from its own snapshot, so no alias map ships. Deck datasets reference print ids from fetch-time snapshots; canonicalization at training time maps them through the registry (ids are stable per print, and every print exists in the snapshot).
*Alternative considered:* shipping an alias map in the artifact — redundant, since the client holds the same snapshot.

**D2 — Two embedding kinds, two cadences, one weekly artifact.**

| Kind | Trained from | Captures | Gate | Cadence |
|---|---|---|---|---|
| Relation embeddings (SGNS, dim 32) | accumulated canonicalized tournament decks | "appears alongside in the current meta" | holdout coherence check | weekly sync |
| Calibration (centroids + card weights) | same corpus + outcomes | meta fit | win-rate MAE vs global mean | weekly sync |
| Text-feature vectors | the card snapshot itself | "does the same kind of thing" | none — pure function | client-side, per snapshot |

Relations and calibration train in one run and ship as independently gated capabilities of one `meta-model.json` — they share the corpus, so one file keeps them consistent; the capabilities block lets the client use whichever passed. Text vectors never ship: they are a pure function of card content, computed client-side (memoized per snapshot, ~20–35 ms for all cards).
*Alternative considered:* separate artifacts per cadence — rejected: card content changes ride the snapshot, so only one artifact cadence (weekly) remains; splitting adds fetch/skew handling for no benefit.

**D3 — SGNS details.** Skip-gram with negative sampling over canonicalized decks (each deck = a document; cards = tokens; dim 32; 5 negative samples; ~10 epochs; linear learning-rate decay; seeded shuffle → deterministic). Expected cost: ~1M updates on the current corpus (< 1 s). Only cards appearing in the corpus receive relation vectors. Quantization for the artifact: Int16 with a per-vector scale factor, base64-encoded.
*Alternative considered:* PMI + random projection — deterministic and simpler, but loses to SGNS on quality; the trainer complexity difference is ~40 lines.

**D4 — Text-feature vectors (client-side).** Feature blocks, all already parsed in the snapshot: game keywords (one-hot, 15), gameplay tags (one-hot from tag rules: removal, board-wipe, damage, draw, ramp, discard, bounce, heal, lockdown, reanimate, lore-burst), card type (one-hot), cost band (≤2 / 3–4 / 5–6 / 7+), ink (one-hot), scaled stats (strength/willpower/lore ÷ 10). L2-normalized. These also feed the archetype flavor: lore-burst/high-lore clusters ≈ finishers, challenge/damage density ≈ aggro, interaction density ≈ control — noted as future stretch, not a task.

**D5 — Suggestion scoring.** Fused score = `0.6 × cos(relation) + 0.4 × cos(text)` (weights documented in code and tooltip; candidates need ≥ 1 present space). Filters applied before ranking: format legality (`card.formats[deck.format]`), declared inks (`inkLegal` semantics from the generator), group copy limit (`groupKey` count vs `maxCopies`), not already in the deck (by `groupKey`). Top 8 returned.
*Alternative considered:* single-space ranking with the other as tiebreak — loses the honest blend and complicates the basis label.

**D6 — Gates.** Relation coherence: on holdout events, a deck's own cards must average higher embedding similarity than random card pairs (margin ≥ 1.1×) — a self-coherence bar, not a performance claim. Calibration: existing win-rate MAE gate (2% margin). The artifact records `capabilities` and per-gate metrics; the emit step ships whatever passed.

## Risks / Trade-offs

- [Thin corpus (663 lists) yields weak relations] → coherence gate may reject; that ships no embeddings and the panel stays deterministic — the Lorcanahunter corpus re-runs the identical pipeline. Text features are unaffected (pure function).
- [Version skew: weekly artifact vs card snapshot] → `dataThroughDate` + `cardSchemaVersion` + staleness label (already built); text vectors self-correct (derived from the live snapshot).
- [SGNS determinism across JS engines] → seeded PRNG, integer-only shuffle indices, fixed iteration order; CI runs the same training the artifact claims.
- [Suggestion pool exhausts for narrow ink pairs] → quiet empty state; text space still ranks same-ink cards, so exhaustion is unlikely in practice.
- [Budget growth as the corpus adds canonical cards] → Int16 quantization + only-corpus-cards rule; measured per emit (existing 300 KB gate).

## Migration Plan

Single new artifact plus one new client module; nothing existing changes behavior. The weekly workflow already calls the trainer and emit steps — the trainer gains relation output internally, so the workflow needs no structural change. Rollback: delete `meta-model.json` → panel degrades to deterministic-only (already implemented).

## Open Questions

- None blocking. Corpus augmentation from open Dreamborn/api-lorcana decks (stronger embeddings) remains a documented stretch, not in scope.
