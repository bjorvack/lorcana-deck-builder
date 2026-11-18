# Benchmark notes — fingerprint v1 over 19 measured decks

Computed with `computeFingerprint` (10k curve/hand trials, 5k race trials, fixed seeds) against the
normalized snapshot of 2026-11-17. Deck sources: 3 official The First Chapter precons (Mushu Report)
+ 16 competitive lists (Dreamborn/lorcana-decks repo). Win% columns are the lore-race estimates vs the
three scripted baselines; they measure pace under interaction, not real matchups (our own interaction
is deliberately not modelled in the race — see the Interaction axis for that dimension).

| deck | ink% | Tempo | Cons | Resil | Int | Reach | win% agg/mid/ctl |
|---|---|---|---|---|---|---|---|
| Sa/Am Midrange (sparring) | 87 | 47 | 74 | 37 | 0 | 75 | 31/45/37 |
| Thiago Top4 DLC Bangkok Em/Ste | 88 | 39 | 83 | 21 | 0 | 19 | 9/25/21 |
| Rockstar Aggro Am/Ste | 80 | 39 | 76 | 14 | 0 | 38 | 7/7/14 |
| Y/P Hyper Aggro Am/Am | 77 | 39 | 76 | 14 | 0 | 50 | 10/7/14 |
| Em/Ste Evasives | 80 | 33 | 84 | 11 | 0 | 13 | 4/15/11 |
| OFF Amber & Amethyst | 88 | 31 | 84 | 11 | 20 | 25 | 3/5/11 |
| Tempo Rush Am/Em | 77 | 36 | 76 | 11 | 0 | 44 | 14/17/11 |
| Elinor Aggro Am/Em | 73 | 34 | 76 | 10 | 0 | 31 | 8/5/10 |
| OFF Sapphire & Steel | 82 | 26 | 84 | 6 | 30 | 88 | 2/5/6 |
| Queen Behavior | 73 | 31 | 76 | 9 | 0 | 25 | 2/3/9 |
| Zootopia Detectives Am/Sa | 77 | 29 | 76 | 9 | 100 | 88 | 2/3/9 |
| Princess aggro Ru/Sa | 88 | 28 | 76 | 9 | 20 | 94 | 8/9/9 |
| Sa/Ste Big Ramp | 78 | 24 | 74 | 12 | 30 | 100 | 1/5/12 |
| OFF Emerald & Ruby | 80 | 25 | 76 | 7 | 30 | 94 | 0/2/7 |
| New Steel Song Am/Ste | 83 | 25 | 75 | 7 | 50 | 88 | 1/3/7 |
| Ruby/Steel Aggro (sparring) | 53 | 20 | 76 | 1 | 0 | 25 | 0/1/1 |
| MisterZa Nordcana Winner Em/Ru | 90 | 5 | 82 | 0 | 100 | 88 | 0/0/0 |
| Leviathan Week6 Em/Ru | 90 | 5 | 75 | 0 | 100 | 94 | 0/0/0 |
| Fungus CCQ Winner Am/Em | 83 | 16 | 56 | 2 | 100 | 100 | 0/0/2 |

## Findings

- **Separation works where the sim has visibility**: evasive/rush lists top the race table;
  Interaction cleanly separates control-style lists (Zootopia 100, Steel Song 50) from aggro (0);
  Reach tracks ramp/Leviathan lists (88–100); consistency is uniformly high (56–84), matching the
  73–90% inkability floor of real decks. Fungus CCQ's low consistency (56) reproduces its real
  curve gap (only 4 one-drops).
- **Known limitation, by design**: interaction-heavy tournament winners (Leviathan, MisterZa) score
  0% in the pure race because the goldfish never uses their removal — the race is a pace estimate.
  The phase-4 meta calibration is what will reconcile this with their real results; the panel shows
  both the Interaction axis and the race bars so the gap is visible, not hidden.
- Performance: full fingerprint ≈ 100–160 ms per deck (10k curve/hand + 3×5k race trials), memoized
  per deck — comfortably within the panel's "well under a second" requirement.

## Training run — TopDeck interim corpus (2026-11-17, task 4.3)

- Backfill: 25 tournaments / 663 decklists / 36,408 mapped cards (participantMin ≥ 8, last 730 days,
  Lorcana Core Constructed). 553 usable lists after mapping/dedupe filters (110 dropped: snapshot lag
  on newest-set names, missing win rates, duplicate players) across only **10 events**.
- Training: k-means archetype centroids (k=12, seeded) + L2 logistic top-cut weights; holdout = newest
  25% of events. **Gate REJECTED**: holdout win-rate MAE 0.174 vs global-mean baseline 0.154 (also
  rejected with event-centered targets at k=3/5/8/12, margins ±0.01).
- Interpretation: Swiss pairing and player skill dominate within-event win rates, and 10 events carry
  no learnable archetype→performance signal. The gate behaved as specified — publication refused, the
  app stays deterministic-only. The same pipeline re-runs unchanged on the Lorcanahunter corpus
  (~17k lists, structured cards, archetype labels), where the gate has real data to evaluate.
- Interim artifact: `scripts/training/data/topdeck.json` (committed derived dataset); raw windows
  cached in `.data-cache/topdeck/` (gitignored).
