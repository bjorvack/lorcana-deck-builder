# Tasks

## 1. Shared text/payoff extraction

- [ ] 1.1 Move `extractNameReferences` + `referenceDecks` from `scripts/training/text-refs.ts` to `src/text/refs.ts`; trainer imports the shared module (existing trainer tests pass unchanged) — verify: `npm test scripts/training/text-refs.test.ts`
- [ ] 1.2 Add `payoffRules` to `scripts/tag-rules.json` extracting shift variants (named/Classification/Universal/Duo/Combo/Temporary/Potato incl. the `⬡` between cost and parenthetical), named references, classification payoffs, sing payoffs, keyword grants; extend `scripts/normalize.ts` to emit typed `payoffs` per card — verify: pipeline snapshot contains payoffs for the audit's known counts (≈349 shift, ≈343 classification, 56 sing)
- [ ] 1.3 Add override entries to `scripts/deck-rule-overrides.json` for Baymax – Amped Up (ink-drop cost), Morph ×2 (MIMICRY/ADVANCED MIMICRY), Belle SALVAGE, Anna conditional Shift, with ruling citations — verify: those cards carry payoffs and drop out of needsReview
- [ ] 1.4 Flag unparseable shift-like text as needsReview in the validation report — verify: a synthetic unparseable card in the pipeline test lands in the report
- [ ] 1.5 Dual-name expansion: target resolution expands `X & Y` base names to X, Y, and `X & Y` — verify: unit test with Sulley & Boo satisfying a "named Sulley" payoff and NOT a "named Sulley & Boo" mismatch case

## 2. Artifact: playrate + typical copies

- [ ] 2.1 Emit playrate (byte) and typical-copies (1–4, byte) per-card maps in `scripts/emit-model.ts`; bump `TrainedModel.version` to `'3'` — verify: emitted artifact reports version `'3'` and passes the emit size gate
- [ ] 2.2 `parseMetaModel` accepts `'2'` and `'3'`; `'2'` yields neutral playrate / unknown copies — verify: unit test parsing a version-2 fixture
- [ ] 2.3 Expose the generator-facing scoring inputs (relation vectors, text vectors, cosine, legality filters, playrate, typical copies) as one shared module used by `suggestCards` — verify: score-component equality test between panel and generator paths

## 3. Suggest-fill generator

- [ ] 3.1 New `src/generate/suggest-fill.ts`: per-iteration candidate scoring (fused score vs evolving deck, needs boosts for curve/type quotas, payoff boosts, slider novelty weight, temperature sampling from top-K, seeded RNG) — verify: unit tests for scoring order and seeded determinism
- [ ] 3.2 Copy policy: deepen bias toward trained typical copies, capped by `maxCopies`/uniques — verify: generated deck has multiplicities (distinct count < deck size) and zero copy-limit violations
- [ ] 3.3 Soft payoff boosts only: shift/named/classification payoffs raise scores, never gate legality — verify: Morph-case test (deck legal with zero shift targets)
- [ ] 3.4 Slider mapping (seed weighting, candidate weights, temperature) with endpoints per spec — verify: novel-end run picks zero/near-zero-playrate cards; meta-end run picks high-playrate cards; middle default
- [ ] 3.5 Integrate into `src/generate/generator.ts`: remove `mode: 'smart' | 'chaos'` (BREAKING), keep partial-deck completion, ink exemptions, and relaxation behavior — verify: existing generator tests updated and green; typecheck clean
- [ ] 3.6 Goldfish polish toggle (default off): bounded hill-climb (≤ 20 swaps, single race per candidate), keep only legality-clean improvements — verify: polish improves goldfish score on a fixture deck and stays off by default

## 4. UI

- [ ] 4.1 `GeneratorView`: Meta ↔ Novel slider (default middle), seed input + regenerate, refine toggle — verify: UI renders, generation responds to slider/seed changes
- [ ] 4.2 `AnalysisPanel`: payoff-coverage info line (informational, no violation) — verify: shift card without target shows the info line and validation stays clean

## 5. Verification

- [ ] 5.1 Full suite green: `npm run typecheck && npm test`
- [ ] 5.2 End-to-end determinism: same seed + slider twice → identical decks; different seed → different decks — verify: scripted check
- [ ] 5.3 Performance: generation without polish completes interactively (< 1 s on the full pool) — verify: timing assertion or manual measure
