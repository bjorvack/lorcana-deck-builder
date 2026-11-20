# Design

## Synergy lookup (both evidence directions)

The emitted partner table is per-card top-8: `partners[a]` lists a's best
partners. A strong pair may therefore be recorded on only one side (the card
with fewer stronger partners holds the entry). The lookup takes the best
score from EITHER direction:

- **own-list**: `partners[candidate]` ∩ deck identities — "the candidate
  names a deck card";
- **granted edges**: for each deck identity d, `partners[d]` naming the
  candidate — "a deck card names the candidate" (precomputed once per fill
  iteration as `deckSynergyEdges`).

Scores normalize by 255 (0 = lift 1.0 neutral, 255 = the emit-time max lift).

## Blend

`score = (1 − w) · fusion + w · synergy` applied to the similarity portion
before cost-curve pressure (synergy picks must still respect the curve). The
share `w` is `SuggestFillOptions.synergyWeight` with **shipping default 0
(off)** — the A/B gate measured the blend as neutral-to-negative under bot
evaluation at 0.25 and 0.1 (both −4.1% uplift, CIs spanning zero), because
pair lift from tournament co-occurrence encodes human-exploited synergies
the fixed heuristic bots cannot play out. With the capability absent the
term is skipped entirely: scores are byte-identical to the pre-change
behavior (regression-tested).

Determinism: everything is table lookups and maxes — no new randomness.

## A/B gate

Matched variants: for seed s, both variants generate with identical inks
(seeded pair), novelty 0.5, and seed — only the model differs (baseline =
interactions stripped). Each generated deck plays the top-8 panel decks with
games per matchup (default 4) and seat parity alternating by game index.
Report: win rate per variant with Wilson intervals; uplift with a normal-
approximation 95% CI; **PASS when the CI lower bound > 0**.

This is a relative comparison under one engine, one strategy pair, one panel
— engine quirks cancel; tournament data remains the absolute anchor.

## Parser rules

- payload shape validated per field; a corrupt table degrades only the
  interactions flag (pattern-match the relations/calibration handling);
- an interactions-only artifact (relations and calibration failed their
  gates) is now accepted — the trainer's any-pass rule can ship one;
- old artifacts without the flag parse unchanged (`interactions` undefined →
  false semantics).
