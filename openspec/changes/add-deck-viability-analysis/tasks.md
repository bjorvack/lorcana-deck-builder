# Tasks

Phases are independently shippable; each phase lands its own tests and keeps `tsc`/`vitest` green.

## Phase 1 — Fingerprint core (deterministic metrics)

- [x] 1.1 Verify the CR 2.2 hand-alteration wording from the official comprehensive-rules PDF and record the chosen semantics in a comment + panel doc constant. Verify: wording quoted in the source file; reviewed
- [x] 1.2 Add tempo-effect extraction (sing board rule, self-discount, ramp-on-play, additional-ink-per-turn, ink-drop grants, flexible inking) parsed once per card snapshot, with spot-check tests against the real snapshot asserting known cards (One Jump Ahead ramps; Fishbone Quill flexible-inks; Steel Song songs singable; LeFou's conditional discount absent in v1). Verify: unit tests + `npx vitest run src/stats`
- [x] 1.3 Upgrade `curve.ts` to sim v2: effective ink (ramp arrives exerted next turn, additional inking, ink drops, flexible inking of uninkable cards), effective cost (self-discount), Sing via a minimal board (songs sung by dry in-play characters, singer forgoes questing that turn), flood (spend leftover ink most expensive first), and on-the-play first-draw skip; keep seeded determinism and skip semantics. Verify: new tests (song sung the turn after the singer lands, ramp-next-turn, additional ink, determinism) + existing curve tests green
- [x] 1.4 Add opening-hand quality (real alteration rule from 1.1), redundancy (P(core enabler by playable turn)), interaction density, singer coverage, and Shift coverage (Shift card has a same-name character target) metrics. Verify: unit tests with constructed decks (4-copy enabler → redundancy ≈ known hypergeometric value; Shift card without target → unshiftable)
- [x] 1.5 Create `src/stats/fingerprint.ts` composing all metrics into a versioned serializable fingerprint object, memoized per deck; null for empty decks. Verify: unit test for stability (two computations identical) and empty-deck null

## Phase 2 — Lore-race goldfish

- [x] 2.1 Build opponent baseline profiles (aggressive / midrange / control: curve histogram, threat lore per turn, removal events per turn window) as documented constants, seeded from the benchmarked official/competitive lists. Verify: profile table reviewed against measured benchmark curves; unit test that profiles are valid distributions
- [x] 2.2 Implement `src/stats/goldfish.ts` reusing the sim core: characters dry on arrival (quest from next turn; Rush challenges only), locations pay automatic lore, challenges target only exerted characters with keyword legality (Evasive/Alert, Bodyguard redirect, Ward vs effect targeting, Reckless), persistent damage, deck-out loss at end of own turn; outputs win rate vs each baseline and turn-to-20-lore distribution over seeded trials. Verify: unit tests — 2-drop deck's first lore lands turn 2; Evasive board survives baseline challenges; high-removal baseline lowers the win rate for thin-character decks; determinism
- [x] 2.3 Add matchup results and tempo axes (Tempo / Consistency / Resilience / Interaction / Reach) to the fingerprint with a documented deterministic axis formula. Verify: unit tests — axes stay within 0–100 and move in the expected direction for constructed decks (aggro deck scores higher Tempo than control deck)

## Phase 3 — Deck analysis panel

- [x] 3.1 Add the analysis panel under the stats section, rendered only when the deck is valid (complete and rule-clean): viability profile bars, matchup bars vs the three baselines (win rate + median clock), tooltips explaining derivation and documented simplifications; recompute on deck change within interactive latency. Verify: typecheck + component render tests (valid deck → panel renders; incomplete/illegal deck → no panel and no placeholder)
- [x] 3.2 Benchmark the full fingerprint + goldfish suite across the 19 measured decks (official precons + competitive lists) and record the output table in the change notes; confirm the metric separates archetypes sensibly. Verify: benchmark run recorded; fingerprint < 50 ms per deck (timing note)

## Phase 4 — Meta calibration (offline-trained, bundled)

- [ ] 4.1 Set up credentials: `LH_CLIENT_ID`/`LH_CLIENT_SECRET` in untracked `.env` + GitHub secret when the Lorcanahunter application is approved; token fetcher with atomic refresh-token rotation (reuse revokes the app). Verify: token round-trip works against the live API once granted; state file gitignored
- [ ] 4.2 Implement the Lorcanahunter backfill/sync fetcher per the pinned contract (tournaments → standings → decklists, paginated ≤100, 429/Retry-After aware; card mapping by setCode/number with their cost/inkwell fields as snapshot-lag fallback; skip `decklistsAvailable: false` events), caching raw JSON in `.data-cache/` and committing a derived dataset. TopDeck.gg used as cross-check on shared events; api-lorcana.com/Dreamborn lists added as unlabeled structure for embeddings. Verify: backfill script pulls one real DLC event end-to-end; dataset schema documented; attribution strings present
- [x] 4.3 Train per-card meta weights and archetype centroids (archetype labels from the API's `deck.archetype`/`/archetypes`; regularized logistic; clustering on ink-pair and card vectors) with a recent-events holdout; artifact embeds `backtest` metrics and refuses publication when it fails to beat the archetype-prior baseline. Verify: training script emits `model.json` with backtest block; holdout report printed
- [x] 4.4 Emit the artifact to `public/data/model.json` (fp16, version + dataThroughDate + cardSchemaVersion, ≤ 300 KB compressed) via the data pipeline. Verify: artifact size check in pipeline test; `npm run data:pipeline` produces the file
- [x] 4.5 Client inference (`src/meta/infer.ts`): load artifact with card data; compute archetype match (similarity + observed win rate), meta-adjusted viability score with visible sim-strength vs meta-alignment decomposition; unavailable/stale states per spec. Verify: unit tests with a fixture artifact (match found, score decomposition, fallback paths); stale indicator for backdated artifact
- [x] 4.6 Wire meta sections into the analysis panel (archetype line, score decomposition, unavailable/stale states) with TopDeck.gg + Lorcanahunter attribution in the panel footer. Verify: render tests for present/absent/stale artifact states

## Phase 4 pre-work (executable before the Lorcanahunter grant)

- [x] 4.7 Pre-build the Lorcanahunter token/fetcher modules against the pinned OpenAPI contract: OAuth2 client-credentials with atomic refresh-token rotation (reuse revokes the app), paginated backfill into the shared dataset schema, card mapping by setCode/number; unit-tested with recorded fixture responses and an injected fetch (live run deferred to 4.1/4.2). Verify: fixture tests pass; no network in tests
- [x] 4.8 Model conditional self-discounts in the sims: "if <character> in play, you pay N less to play this card" applies only while a same-named character is on the board. Verify: unit tests (LeFou discounts only with Gaston on board; snapshot spot-check)
- [x] 4.9 Tune fingerprint compute into the ~50 ms design budget (trial counts / hot paths), documenting the precision trade-off. Verify: timing assertion or measured note under 50 ms on a real deck
- [x] 4.10 Update README: stats dashboard, analysis panel and its gating, meta-model states, data sources and attribution. Verify: README section present, links valid

## Phase 4 CI sync (incremental updates in GitHub Actions)

- [x] 4.11 Sync-state layer: committed per-source state (lastSync, lastEventDate, pending queue, per-event decklist counts) with event caches as the immutable source of truth; datasets rebuilt by merging cached events. Verify: unit tests — fresh seed from an existing dataset, overlap window, pending promotion/drop
- [x] 4.12 Incremental sync in both adapters: Lorcanahunter lists with `dateFrom = lastEventDate − 7d overlap` (server-side filter, no full enumeration), TopDeck windows only from the overlap; `--full` flag resets state; CI does a fresh client-credentials grant per run (no refresh-token state). Verify: fixture tests — second run with no new events makes ~1 listing request; pending event retried and promoted; only new windows fetched
- [x] 4.13 Workflow integration: extend data.yml with incremental meta sync (TopDeck always, Lorcanahunter gated on secrets), training + gated artifact emit when datasets changed, commit state/caches/dataset/artifact, graceful skip while Lorcanahunter is unapproved. Verify: workflow yaml valid; local dry-run of the sync produces committed state

## Phase 5 — Synergy suggestions (moved)

Phase 5 was re-planned with its own detailed design and tasks: see the `add-card-relations-suggestions` change (canonical card identity, weekly relation embeddings, client-side text features, fused suggestions).

## Workflow follow-up

- Re-run the benchmark suite (task 3.2) after phase 4 to compare sim-only vs meta-adjusted scores on the same 19 decks; record in the change notes.
- Update the README feature list when the analysis panel ships.
- Archive via `/opsx-archive` after all phases complete.
