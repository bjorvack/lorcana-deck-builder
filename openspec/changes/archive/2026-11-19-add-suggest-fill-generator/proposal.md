# Proposal

## Why

The generator fills decks with a static per-card heuristic (`smartScore`) that never looks at the deck it is building, so generated decks are legal but generic — and they cannot surface the designed synergies (Shift lines, named-character effects, classification payoffs) or deliberately novel card choices that the new relation embeddings, text features, and payoff data make possible. The suggestion engine already fuses meta-proven co-occurrence with deterministic text similarity; generation should be driven by it.

## What Changes

- Replace the static score-and-fill generator with a **suggest-fill pick loop**: each pick scores the full legal pool with the fused suggestion score against the evolving deck, plus needs boosts (curve bands, type quotas), soft payoff boosts, and a novelty weight; sampling is from the top-K with temperature, seeded for reproducibility
- Add a **Meta ↔ Novel slider** (default middle) that scales seed weighting (playrate-weighted ↔ inverse-playrate), candidate novelty boosts, and temperature
- Add a **copy policy**: the loop deepens good cards toward their trained typical copy count instead of producing 60 singletons, capped by per-card copy limits
- Interactions are **learned, never forced**: Shift/named/classification payoffs are score boosts only — decks are legal and playable whether or not a payoff resolved (e.g. a Shift card without its target)
- Add a **structured payoff layer** extracted from card text by versioned pattern rules with manual overrides, semantics matching official rulings: standard named Shift, Classification Shift, Universal Shift, Duo Shift (two distinct characters, one per name; a dual-named character counts once), Combo Shift (either name or one of each), Temporary Shift, Potato Shift (item target), MIMICRY/ADVANCED MIMICRY wildcards, non-ink shift costs (discard / ink-drop removal), and conditional grants
- Surface **payoff coverage as information** in the analysis panel (e.g. "shift target present"), never as a validation violation
- Emit per-card **playrate** and **typical copies when played** (quantized bytes) in `meta-model.json`; model version bumps to `'3'`, parser accepts both versions
- Add an optional **goldfish polish** toggle: hill-climb single-card swaps scored by the existing race simulator (default off; generation stays instant)
- **BREAKING**: generator `smart`/`chaos` modes are replaced by the slider (chaos ≈ novel end + high temperature); `GenerateOptions.mode` is removed

## Capabilities

### New Capabilities
- `card-payoffs`: typed payoff extraction from card text (shift variants with ruling-accurate target/cost semantics, named references, classification payoffs, sing payoffs, keyword grants), pattern rules + manual overrides, needs-review reporting, and payoff-coverage reporting for a deck
- `suggest-fill-generation`: the slider-driven, seeded, deck-aware generation loop — seed weighting, candidate scoring, copy policy, soft payoff boosts, novelty sampling, and the optional goldfish polish

### Modified Capabilities
- `deck-generation`: fill behavior changes from static score-and-fill with smart/chaos modes to the suggest-fill loop driven by the novelty slider; legality, partial-deck completion, and relaxation requirements are unchanged
- `meta-model`: artifact gains per-card playrate and typical-copies maps and bumps to version `'3'`; stale-version parsing degrades gracefully

## Impact

- `src/generate/generator.ts` (rewrite of the fill path; `GenerateOptions.mode` removed), new `src/generate/suggest-fill.ts`
- `src/meta/infer.ts` (playrate/typical-copies in `MetaModel`, version tolerance), `src/ui/GeneratorView.tsx` (slider, seed, refine toggle), `src/ui/AnalysisPanel.tsx` (payoff-coverage info line)
- New shared `src/text/refs.ts` (reference + payoff extraction) — trainer imports it, replacing `scripts/training/text-refs.ts` extraction internals
- `scripts/tag-rules.json` (payoff pattern rules), `scripts/deck-rule-overrides.json` (special-case entries), `scripts/pipeline.ts`/`scripts/normalize.ts` (payoff emission into the snapshot)
- `scripts/training/train.ts` + `scripts/emit-model.ts` (playrate/typical-copies maps, version bump)
- Trainer depends on the in-flight dot.gg corpus only for data quality; the generator degrades gracefully (neutral weighting, text-space-only) before the next artifact refresh
