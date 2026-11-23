# Design: self-play-league

## Context

The arena (`scripts/training/arena/`) already runs deterministic AI-vs-AI games on the
vendored engine: `play.ts` re-keys engine instance ids deterministically
(`deterministicCardsMaps`) because the planner tie-breaks by instance id, games are
seeded with `mulberry32` only, and results are cached under
(deck pair, map format, strategies, seeds, engine commit). Parallelism follows
`batch.ts`'s seed-split child `tsx`-process pattern. The arena has its own typecheck
program (`tsconfig.typecheck.json`) with hand-rolled `@tcg/*` shims; vendor sources
must never enter a tsc program and are never edited. The trainer's gate discipline
(`train.ts`): every capability ships only behind a pre-committed gate, negative
verdicts are recorded in `ROADMAP.md`, never tuned away. `src/meta/score.ts` is the
single shared scoring implementation (app + trainer, by design). See proposal.md for
motivation; specs for the behaviour contract.

## Goals / Non-Goals

- Goals: a self-play loop whose decks and referee improve each other, gated end to end,
  reproducible byte-for-byte, with all verdicts recorded.
- Non-Goals: the learned generator (phase 5, follow-up change); any runtime `src/` UI
  change; training on human/match-level data; matchup models fitted on real results;
  changes to `meta-model.json` payload.

## Decisions

- **D1 — IS-MCTS lives in the arena layer, vendor untouched.** Implemented as a custom
  `AutomatedActionStrategy` (the same object-contract path `tunable-strategy.ts` and
  `learned-strategy.ts` already use): `summarizeCandidates` re-runs the engine's
  planner candidates and re-orders them by search value. Determinization samples
  hidden zones (opponent hand, deck order) from a `mulberry32` stream; the root
  information set is the acting seat's visible state; rollouts use the shipped
  deck-aware heuristic (`best-deck-aware-lore-race`, the public-info bot registered in
  `strategy-registry.ts`). Iteration budget configurable, default 150. Alternative
  rejected: modifying the vendored planner (hard project rule).
- **D1b — Coverage status is operationalized from existing signals.** `card-map.ts`
  already reports `mapped` (2,681/2,785 identities), `ineligible` (104 quest cards)
  and upstream's boolean `missingImplementation` (currently 6). Status mapping:
  fully = mapped ∧ ¬missingImplementation; partially = mapped ∧
  missingImplementation (engine has the card but upstream flags incomplete rules);
  unmapped/ineligible = everything else (already excluded from arena decks by
  `run.ts`/`deck-io.ineligibleIdentities`). No new fidelity source is invented;
  if a richer signal lands upstream later, the mapping updates.
- **D1c — The real-deck corpus is not small.** 13,617 lists across 1,478 tournaments
  (`scripts/training/data/{topdeck,dotgg,lorcanahunter}.json`). Held-out league
  seeding uses the same loader as `panel.ts` (`loadCorpus`), keeping real decks as
  opponents only; survivorship bias is why they are validation, not training signal.
- **D2 — Referee upgrade is gated, with honest fallback.** If the IS-MCTS gate passes,
  it referees league games; if it fails, the loop keeps the heuristic bot as referee
  and stops at the acceptance gate — the verdict is recorded, the loop is not silently
  continued with a weaker referee. Rationale: co-adaptation guard (weak player rewards
  weak decks); the issue mandates search-based player strength.
  - **D2a — Referee affordability split (measured 2026-11-22).** IS-MCTS throughput is
    ~0.022 games/s at 20 iterations/3 workers and cost is ~linear in iterations
    (~1,000 s/game at 150). Refereeing every league fitness game with IS-MCTS is
    computationally infeasible, so: league fitness during MAP-Elites search is
    refereed by the shipped heuristic bot; the IS-MCTS evaluator (once its gate
    passes) referees the **acceptance/validation matches** — winners vs held-out real
    decks — so decks cannot ship by overfitting the cheap referee alone. If the
    IS-MCTS gate fails, acceptance falls back to the heuristic referee and the loop's
    verdict is recorded honestly per the fallback rule above.
  - **D2b — Iteration budget escalation, pre-declared.** Gate budget starts at 75
    iterations (measured ≈17 h for the full 1,000-game gate at parallel 8; 150 would
    be ≈35 h). If i75 FAILS, exactly one escalation to i150 is pre-authorized; each
    budget's verdict is recorded with its own ≥1,000-game gate, and the shipped
    referee budget is whichever passed. Repeatedly lowering/raising budgets beyond
    this is gate-tuning and is not allowed.
- **D3 — League + archive are committed artifacts, not part of meta-model.json.**
  League composition and MAP-Elites archive live under `public/data/selfplay.*` /
  run-state directories keyed by engine commit; `selfplay.report.json` is the committed
  summary. Rationale: artifact budget (~300.9 KB gzip, thin headroom) — no payload
  sections added.
- **D4 — Everything cached, everything paired.** Paired seeds: mutant and parent share
  a seed base per opponent — the cache already keys records by
  `<sha256(deckA,deckB)>/arena-2-<seedBase>-<games>.jsonl` (`run.ts:124-153`), so two
  related decks against the same opponent with the same seed base see identical
  shuffles while landing in their own pair directories. SPRT stops decided pairings
  early. Rationale: M3 selection-bias lesson — fitness samples must exceed the noise
  floor; cheap reproducibility. Throughput budget: ~4 games/s single-threaded today;
  MCTS rollouts will be far slower, so league schedules must be sized against
  measured, not hoped-for, throughput.
- **D5 — Mutation through the shared rules only.** Mutations build on the proven
  `evolve-mutation.ts` operators (synergy swap / random swap / count adjust,
  `evolve-mutation.ts:138-237`), validated via `src/rules`/`deck-io` legality so
  archive decks are legal by construction; descriptor cells: average cost, inkable
  ratio, type mix, lore-per-turn proxy. Note `evolve.ts` already PASSED its gate
  (v2 0.875 CI [0.772, 0.935] vs held-out anchors) — MAP-Elites generalizes that
  single-fitness hill-climb into a diversity-preserving archive. Rationale: legality
  can then never be a learned or approximated property.
- **D6 — One scoring implementation.** Any synergy/meta weighting reused by the loop
  goes through `src/meta/score.ts`, never a trainer-local copy (project D1 rule).
- **D7 — Parallelism follows `batch.ts`.** Seed-split child processes via `tsx`; no
  `Math.random` in any training path.

## Risks / Trade-offs

- [MCTS compute cost] → paired seeds, CRN, SPRT, full caching, child-process
  parallelism; surrogate pre-screening stays optional and later.
- [Selection bias inflating fitness ~1σ (M3)] → fitness sample sizes sized above the
  noise floor; any promoted winner is revalidated on fresh, disjoint seeds before it
  enters the league.
- [Bot/engine bias flows into decks] → coverage audit gate, held-out real decks as
  fixed opponents, honest CI reporting, acceptance CI must exclude 0.5.
- [Arena typecheck program split] → new arena modules stay inside
  `tsconfig.typecheck.json` scope; trace/record type changes updated in all three
  places (play.ts, trace writer, trainer interfaces).
- [Self-play result ≠ tournament meta] → explicit in the report: result validity is
  scoped to this simulator and these bots; real decks remain the sanity check.

## Migration Plan

New offline modules plus report files only; nothing existing changes behaviour except
the additive `report.json` coverage fields and cache-key extension (old cache entries
stay valid for non-paired requests). Rollback: stop running the loop; no runtime
surface is affected.

## Open Questions

- None blocking. IS-MCTS iteration budget starts at 150 and changes only on gate
  evidence, never to pass a gate.
