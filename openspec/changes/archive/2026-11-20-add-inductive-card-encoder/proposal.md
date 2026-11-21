# Proposal

## Why

Close out the M2 roadmap item: cards without tournament history score
text-only in the suggestion fusion because the relation space has no vector
for them. An inductive encoder — ridge regression from the client's
text-feature space onto the SGNS relation space — would let unplayed and
brand-new cards join the trusted relation fusion ("day-zero suggestions").

## What Changes

- New `scripts/training/encoder-capability.ts`: ridge regression (closed
  form, deterministic) from the client text space (181 dims) onto the SGNS
  space (32 dims), gated temporally — trained on cards debuting up to the
  holdout era, evaluated on later debutants; PASS = mean
  cosine(predicted, observed) beats the mean-vector baseline by 1.1x.
- Wired as a fourth gated capability in `train.ts` (encoder requires the
  relations capability — it encodes that space).
- Client consumption (parser + predicted-vector fallback in
  `buildScoringContext`) is deliberately NOT in this change: the gate
  rejected the encoder, so there is nothing to consume.

## Verdict

**REJECTED by the gate** (2026-11-20, real corpus): cosine 0.6145 vs
mean-vector baseline 0.6003 (margin 1.02 < 1.1) over 1,590 post-cutoff
debutants. Content features alone barely predict the SGNS space linearly —
the relation space encodes tournament co-occurrence structure that text does
not determine. The capability infrastructure (solve, gate, quantization)
ships for future iteration (nonlinear features, per-dim target
normalization); the artifact payload ships only if a future gate passes.
