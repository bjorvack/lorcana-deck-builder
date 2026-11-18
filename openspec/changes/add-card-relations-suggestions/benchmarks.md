# Benchmarks

## 2026-11-18 — First full run on the real TopDeck corpus (tasks 2.3 / 2.4)

Corpus: 553 usable lists (110 dropped by mapping/win-rate filters, 0 lost to
canonicalization) from 10 TopDeck events · train 462 / holdout 91.

| Gate | Metric | Value | Threshold | Outcome |
|---|---|---|---|---|
| Calibration | holdout win-rate MAE | 0.1576 (baseline 0.1542) | beat baseline by 2% | **REJECTED** |
| Relations | holdout coherence ratio | 0.7193 own vs 0.6805 random (margin 1.06) | ≥ 1.1 | **REJECTED** |

- **No artifact emitted** — neither capability passed, per the D6 publication
  rule (`scripts/training/output/rejected.json` only). The panel stays
  deterministic-only, as designed for a thin corpus.
- Artifact size: n/a (nothing emitted). The 300 KB gzip gate in
  `scripts/emit-model.ts` is unchanged; at the current corpus scale the
  quantized relation vectors (Int16 + per-vector scale, only-corpus-cards
  rule) would sit well under the budget once the coherence gate passes.
- SGNS training cost: full retrain over the accumulated corpus runs in well
  under a second — the weekly cadence is not constrained by training time.
- Relations margin 1.06 vs the 1.1 bar is close: the Lorcanahunter corpus
  (re-runs the identical pipeline) is expected to push the coherence gate
  over the bar as the accumulated deck stream grows.

## 2026-11-18 — Live verification (task 4.2)

Because the real corpus fails both gates (no artifact ships), the browser
check ran against a **locally synthesized fixture artifact** (relations +
calibration over real Amber card ids from the live snapshot; gitignored
output, emitted copy removed after the check — committed state has no
artifact). Reproducible with `npx tsx scripts/verify-fixture.mts`,
`npx tsx scripts/emit-model.ts`, `npx tsx scripts/verify-ranking.mts`.

Procedure: dev server + a valid 60-card Amber deck loaded via a `?d=` share
URL, page driven with Playwright.

- ✅ Suggestions appear for a valid deck ("Suggested additions" section in
  the analysis panel, below Meta fit).
- ✅ Offline ranking matches the browser: top suggestion
  "Daisy Duck - Musketeer Spy — 91% (rel 91%, text 90%)" with fused basis
  "appears alongside in tournament decks + plays similarly"; text-only rows
  below it at 90% with basis "plays similarly" — identical to
  `verify-ranking.mts` output.
- ✅ Filters respected: only Amber, core-legal, non-owned candidates appear
  (the Ruby test card never surfaces; deck groups never surface).
- ✅ Add-on-click wired to the deck handler: clicking + on a suggestion added
  the card (60 → 61 cards, 16 distinct).
- ✅ Section hidden without relation embeddings (component test; also
  re-verified live by removing the artifact → "Meta model unavailable").
- Screenshot: `verification-suggestions-panel.png` (post-add state, ranking
  recomputed for the 61-card deck as expected).

Side fix found during verification: `scripts/emit-model.ts`'s CLI entry
resolved the repo root one level too deep (`../..` from `scripts/`) — the
pipeline path was unaffected; CLI now emits correctly.

## 2026-11-18 — Lorcanahunter initial backfill (temporary website scrape)

While the Lorcanahunter OAuth application is unapproved, the public website
was scraped as a one-off initial backfill
(`scripts/sources/lorcanahunter-scrape.ts`; the official API adapter
`lorcanahunter.ts` seeds from these event caches once approved and never
re-fetches them). Politeness: sequential, 350 ms between requests, CORE
events only, public pages (listing → standings → per-player deck payload).

- **24 CORE events (2026-10-24 → 2026-11-13), 968 decklists** — every list
  maps ≥ 55 cards onto the snapshot (all exactly 60), zero unmatched card
  names (the deck payload's plain names map cleanly through
  `mapCards`'s name fallback).
- Merged corpus (TopDeck + Lorcanahunter): **1518 lists, 34 events** ·
  train 1187 / holdout 331.

| Gate | Before backfill | After backfill | Outcome |
|---|---|---|---|
| Calibration (holdout MAE) | 0.1576 vs baseline 0.1542 | **0.1440 vs baseline 0.1735** | REJECTED → **PASSED** |
| Relations (coherence margin) | 1.06 (bar 1.1) | **1.15** (0.6686 own vs 0.5834 random) | REJECTED → **PASSED** |

- **Both capabilities ship**: 857 card relation vectors; artifact
  **82 584 gzip bytes** (limit 300 000) — well inside the budget.
- Both gates now have real headroom; recency weighting stays off (default)
  while the corpus keeps growing.

## 2026-11-18 — Full Lorcanahunter archive scrape

Complete crawl of every past event with public decklists (`--pages 0
--limit 100`): **185 CORE events (2026-01-04 → 2026-11-13), 4,938
decklists** — every list maps ≥ 55 cards (4,934/4,938 exactly 60), zero
unmatched card names. ~14 events skipped as unknown-format (no CORE badge)
and a handful of near-empty standings came through with 0–4 lists (players
never submitted).

- Merged corpus: **5,441 usable lists (TopDeck 503 + Lorcanahunter 4,938),
  189 events** · train 3,808 / holdout 1,633.

| Gate | 968-list backfill | Full archive | Outcome |
|---|---|---|---|
| Calibration (holdout MAE) | 0.1440 vs baseline 0.1735 | 0.1375 vs baseline 0.1396 (1.5% < 2% margin) | PASSED → **REJECTED** |
| Relations (coherence margin) | 1.15 | **1.22** (0.5663 own vs 0.4646 random) | PASSED → **PASSED** |

- The artifact ships **relations-only** (1,092 card vectors,
  **91 768 gzip bytes** / 300 000 budget) — the capability gate's
  independent publication working as specified: suggestions stay live while
  the meta-fit section shows its "calibration gate not passed" state.
- Calibration's thin edge is honest, not broken: the nearest-centroid
  predictor generalizes worse on the larger, more heterogeneous corpus
  (the bigger holdout is much harder to beat by 2%). The weekly pipeline
  re-runs it; no action needed.

### Calibration fix (same day)

Diagnosis (seed/split sensitivity sweeps, kept out of the repo — findings
recorded here): the deck→win-rate signal is thin because **event effects
dominate** (predicting by holdout per-event mean reaches 0.113 MAE vs the
0.137 global-mean baseline — field strength explains more than deck choice),
the 10-month archive drifts (old decks don't anchor current win rates), and
k=12 cluster means are too coarse for a 10× corpus while finer clusters are
noisy. Two caveats surfaced on the way: **TopDeck and Lorcanahunter win
rates have different semantics** (source means 0.44 vs 0.60 — game vs match
rate) and 4 events are duplicated across sources; both worth revisiting if
calibration stays marginal.

Fix (all three parts principled, validated over 8 seeds: +2.3 % to +3.1 %
vs baseline, never negative; k=24/32 *without* shrinkage flipped negative on
some seeds — the shrinkage is what makes finer clusters safe):

1. **Rolling 90-day calibration window** (relations still train on the full
   accumulated corpus — co-occurrence accumulates, win-rate anchoring decays).
   Falls back to the full split while the window holds < 100 lists.
2. **k = 32** (corpus grew 10×, finer archetypes).
3. **Shrinkage**: each archetype's win rate is
   `(n·mean + 25·windowMean) / (n + 25)` — small clusters regress toward the
   window mean instead of shipping noise.

Production run: **calibration MAE 0.1364 vs baseline 0.1396 → PASSED**
(2.3%, the low end of the seed range — the margin is honest but thin and may
flip week to week; the gate re-runs on every sync). Both capabilities ship:
1,092 relation vectors + 32 archetypes, **104 518 gzip bytes** / 300 000.

