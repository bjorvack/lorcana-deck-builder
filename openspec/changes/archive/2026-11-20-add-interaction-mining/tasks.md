# Tasks

## 1. Interaction miner — done

- [x] 1.1 `model-types.ts`: `InteractionGateMetrics`, `InteractionsOutput`,
      `InteractionPartners` artifact types.
- [x] 1.2 `synergy-capability.ts`: win-rate-weighted pair lift with support
      shrinkage (S=3) + minSupport 5, per-card top-8 partner selection,
      temporal holdout gate — holdout evaluation requires ≥3 co-occurrence
      decks and stronger shrinkage (H=8) so thin-evidence noise cannot pass;
      quantized payload (lift → int8 scale).
- [x] 1.3 Vitest: planted-synergy discovery + gate pass; holdout
      anti-correlation → reject; determinism; thin-support rejection.

## 2. Trainer wiring — done

- [x] 2.1 `train.ts`: third capability wired (interface, call,
      assembleMetaModel optional-interactions, three-way any-pass, report,
      rejected.json, CLI summary).
- [x] 2.2 `emit-model.ts`: optional `capabilities.interactions` boolean.
- [x] 2.3 Real run: 12,304 lists / 1,038 events — interactions lift 3.9790 vs
      random 1.1088 (margin 3.59) → PASSED; 7,041 pairs, 1,328 partner lists;
      artifact 300,885 gzip bytes (budget 307,200 — headroom thin).

## 3. Deck panel + matchup batch — done

- [x] 3.1 `arena/panel.ts`: corpus → arena-eligible deduped meta deck panel
      (16 winner decks from the recent era; drops: 19 non-core, 3 over-length,
      2 duplicates).
- [x] 3.2 `arena/batch.ts`: round-robin over the panel, per-pair seed bases,
      parallel child workers, matchup matrix JSON.
- [x] 3.3 Vitest: panel eligibility/dedupe, batch aggregation, pair/seed
      helpers.
- [x] 3.4 Real e2e: 16-deck round-robin, 8 games per pair — 960 games, 0
      incomplete (~3.5 min across 8 workers). Matrix shows real seat-balanced
      spread (e.g. panel-01 8–0 over panel-02, 0–8 under panel-13).

## 4. Docs

- [x] 4.1 ROADMAP M2 updated (miner + panel shipped, arena A/B hand-off
      noted, artifact-size headroom flagged).
