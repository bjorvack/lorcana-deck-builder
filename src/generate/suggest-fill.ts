import type { Card, DeckState, Format, Ink } from '../data/types';
import { INKS } from '../data/types';
import type { MetaModel } from '../meta/infer';
import {
  buildScoringContext,
  candidateComponents,
  deckVectors,
  type ScoringContext,
} from '../meta/score';
import { validateDeck } from '../rules/engine';
import { simulateRace } from '../stats/goldfish';
import { cardSatisfiesName } from '../text/refs';

/**
 * The suggest-fill pick loop (suggest-fill-generation capability): every pick
 * scores the full legal pool with the fused suggestion score against the
 * evolving deck, plus needs boosts (cost-curve gaps, type quotas), soft
 * payoff boosts, a copy-deepening bias and a novelty weight — then samples
 * from the top-K with temperature, seeded for reproducibility.
 *
 * Payoffs are learned, never forced: they only raise scores, so decks stay
 * legal and playable whether or not a payoff resolved.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// benchmarked against official precons (73-88% inkable) and competitive
// lists (73-90%, median 80%): target the competitive midpoint, never drop
// below the observed competitive floor
export const INKABLE_TARGET_SHARE = 0.75;
export const INKABLE_FLOOR_SHARE = 0.7;

/** score-boost tunables (D4: isolated here; the spec fixes endpoint behavior only) */
const TOP_K = 8;
const DEEPEN_WEIGHT = 0.35;
/**
 * Playrate weighting for the slider endpoints (D4 candidate weighting:
 * (1−novelty)·w_meta + novelty·w_novel). Must compete with the fused
 * similarity (0–1) so the endpoints deliver their defined behavior —
 * playrate-led decks at the meta end, unplayed-led at the novel end. The two
 * terms cancel exactly at the middle, leaving similarity in charge there.
 */
const NOVELTY_WEIGHT = 1.0;
const PAYOFF_WEIGHT = 0.15;
const CURVE_WEIGHT = 0.2;
const TYPE_WEIGHT = 0.1;
/** target share per cost band (≤2, 3–4, 5–6, 7+) — the smart-mode curve */
const CURVE_TARGETS = [0.25, 0.4, 0.25, 0.1];

/** D4 — one knob (the slider) maps to every novelty weight */
export interface SliderMapping {
  /** seed-card weighting exponent over playrate: +2 (meta) … −1 (novel) */
  seedExponent: number;
  /** fusion weights shift from 0.6/0.4 (meta) toward pure text (novel) */
  fusionRelationWeight: number;
  fusionTextWeight: number;
  /** candidate boost for unplayed cards: 0 (meta) … full (novel) */
  noveltyBias: number;
  /** sampling temperature: 0.3 (meta) … 1.2 (novel) */
  temperature: number;
}

export function mapSlider(novelty: number): SliderMapping {
  const n = Math.max(0, Math.min(1, novelty));
  const relation = 0.6 * (1 - n);
  return {
    seedExponent: 2 - 3 * n,
    fusionRelationWeight: relation,
    fusionTextWeight: 1 - relation,
    noveltyBias: n,
    temperature: 0.3 + 0.9 * n,
  };
}

/** group limits are per full name across prints; fills must respect the group, not the print */
export function buildGroupLimits(
  cards: Card[],
): Map<string, number | 'unlimited'> {
  const limits = new Map<string, number | 'unlimited'>();
  for (const card of cards) {
    const current = limits.get(card.groupKey);
    if (card.maxCopies === 'unlimited') limits.set(card.groupKey, 'unlimited');
    else if (current === undefined || current === 'unlimited')
      limits.set(card.groupKey, card.maxCopies);
    else limits.set(card.groupKey, Math.min(current, card.maxCopies));
  }
  return limits;
}

const costBand = (cost: number): number =>
  cost <= 2 ? 0 : cost <= 4 ? 1 : cost <= 6 ? 2 : 3;

/** benchmarked smart-mode cost pressure: cheap cards fill first, finishers stay reachable */
const costFactor = (cost: number): number =>
  cost <= 4 ? 1 : cost <= 5 ? 0.7 : cost <= 6 ? 0.5 : 0.3;

/** what a deck card asks of its partners, derived once per distinct card */
interface PayoffDesire {
  /** candidate ids that satisfy a named target (shift/named) */
  nameTargets?: { name: string };
  /** classification target (classification shift / classification payoff) */
  classification?: string;
  /** items with this name (potato shift) */
  itemNamed?: string;
  /** MIMICRY: any character (advanced) or any character with a Shift keyword */
  mimicry?: 'any' | 'shifters';
  /** sing payoff: characters with cost ≥ minCost make the song playable */
  singMinCost?: number;
}

function desiresFor(card: Card): PayoffDesire[] {
  const desires: PayoffDesire[] = [];
  for (const payoff of card.payoffs) {
    switch (payoff.kind) {
      case 'shift':
        if (payoff.variant === 'classification') {
          desires.push({ classification: payoff.classification });
        } else if (payoff.variant === 'potato') {
          desires.push({ itemNamed: payoff.names?.[0] ?? 'Potato' });
        } else if (
          payoff.variant === 'named' ||
          payoff.variant === 'duo' ||
          payoff.variant === 'combo'
        ) {
          for (const name of payoff.names ?? [])
            desires.push({ nameTargets: { name } });
        }
        // universal shift: every character satisfies it — no differential boost
        break;
      case 'mimicry':
        desires.push({ mimicry: payoff.advanced ? 'any' : 'shifters' });
        break;
      case 'named':
        desires.push({ nameTargets: { name: payoff.name } });
        break;
      case 'classification':
        desires.push({ classification: payoff.classification });
        break;
      case 'sing':
        desires.push({ singMinCost: payoff.minCost });
        break;
      default:
        break; // keyword grants are data-only (coverage display)
    }
  }
  return desires;
}

/**
 * Soft payoff boosts: raise the score of candidates that complete a payoff a
 * deck card asks for. Coverage is never a requirement — unmet payoffs simply
 * boost nothing.
 */
function payoffBoostMap(
  deck: Record<number, number>,
  byId: Map<number, Card>,
  pool: Card[],
): Map<number, number> {
  const boosts = new Map<number, number>();
  const desireCache = new Map<number, PayoffDesire[]>();
  for (const [idStr, count] of Object.entries(deck)) {
    const card = byId.get(Number(idStr));
    if (!card || count <= 0) continue;
    let desires = desireCache.get(card.id);
    if (!desires) {
      desires = desiresFor(card);
      desireCache.set(card.id, desires);
    }
    if (desires.length === 0) continue;
    for (const candidate of pool) {
      let boost = 0;
      for (const desire of desires) {
        if (
          desire.nameTargets &&
          cardSatisfiesName(candidate, desire.nameTargets.name)
        )
          boost += PAYOFF_WEIGHT;
        else if (
          desire.classification &&
          candidate.subtypes.includes(desire.classification)
        )
          boost += PAYOFF_WEIGHT;
        else if (
          desire.itemNamed &&
          candidate.type === 'Item' &&
          cardSatisfiesName(candidate, desire.itemNamed)
        )
          boost += PAYOFF_WEIGHT;
        else if (desire.mimicry === 'any' && candidate.type === 'Character')
          boost += PAYOFF_WEIGHT;
        else if (
          desire.mimicry === 'shifters' &&
          candidate.type === 'Character' &&
          candidate.keywords.some((k) => k === 'Shift' || k.endsWith(' Shift'))
        ) {
          boost += PAYOFF_WEIGHT;
        } else if (
          desire.singMinCost !== undefined &&
          candidate.type === 'Character' &&
          candidate.cost >= desire.singMinCost
        ) {
          boost += PAYOFF_WEIGHT;
        }
      }
      if (boost > 0)
        boosts.set(
          candidate.id,
          (boosts.get(candidate.id) ?? 0) + boost * Math.min(count, 4),
        );
    }
  }
  return boosts;
}

export interface SuggestFillOptions {
  pool: Card[];
  /** deck counts so far (partial or empty); mutated in place */
  deck: Record<number, number>;
  need: number;
  novelty: number;
  seed: number;
  /** trained artifact — null means neutral weighting, text-space-only scoring */
  model: MetaModel | null;
  cards: Card[];
  /** the pool's ink universe (auto mode passes all inks) */
  inks: Ink[];
  /** user-declared inks; 0 = ink-emergent mode (derive from the picked cards) */
  declaredInks?: Ink[];
  format: Format;
  targetSize: number;
  /** partial-deck card ids: kept unchanged, never deepened */
  locked: Set<number>;
  /** group copy counts already in the deck */
  groupCounts: Map<string, number>;
  inkableBaseline: number;
  byId: Map<number, Card>;
}

export interface SuggestFillResult {
  placed: number;
  /** the 2-ink pair the picks collapsed to (auto mode, when one emerged) */
  pair?: InkPair;
  /** the pick whose addition collapsed the viable pairs to one */
  decidedBy?: Card;
  /** ink representation notes (two-ink guarantee corrections) */
  representedInks: Ink[];
}

type InkPair = [Ink, Ink];

/** every 2-ink combination that covers all of `cards` (card.inks ⊆ pair) */
export function viablePairs(cards: Card[], base: InkPair[]): InkPair[] {
  return base.filter((pair) =>
    cards.every(
      (c) =>
        c.inks.length === 0 ||
        (pair.includes(c.inks[0]!) &&
          (c.inks.length === 1 || pair.includes(c.inks[1]!))),
    ),
  );
}

const allInkPairs = (inks: readonly Ink[]): InkPair[] => {
  const pairs: InkPair[] = [];
  for (let i = 0; i < inks.length; i++) {
    for (let j = i + 1; j < inks.length; j++) pairs.push([inks[i]!, inks[j]!]);
  }
  return pairs;
};

const cardFitsPair = (card: Card, pair: InkPair): boolean =>
  card.inks.length === 0 ||
  (pair.includes(card.inks[0]!) &&
    (card.inks.length === 1 || pair.includes(card.inks[1]!)));

const cardFitsSomePair = (card: Card, pairs: InkPair[]): boolean =>
  pairs.some((p) => cardFitsPair(card, p));

/** target share per declared ink (two-ink representation, D7) */
const INK_REPR_TARGET = 0.25;
const INK_REPR_WEIGHT = 0.6;

interface FillState {
  deck: Record<number, number>;
  groupCounts: Map<string, number>;
  inkable: number;
  nonInkable: number;
  typeCounts: Record<string, number>;
  bandCounts: Record<number, number>;
  deckSize: number;
}

const toDeckState = (
  deck: Record<number, number>,
  inks: Ink[],
  format: Format,
): DeckState => ({
  title: '',
  inks,
  format,
  cards: deck,
});

/** softmax sample from the top-K scored candidates at the given temperature */
export function sampleTopK<T extends { score: number }>(
  scored: T[],
  k: number,
  temperature: number,
  rng: () => number,
): T {
  const top = scored.slice(0, Math.max(1, k));
  const best = top[0]!.score;
  const weights = top.map((s) => Math.exp((s.score - best) / temperature));
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < top.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return top[i]!;
  }
  return top[top.length - 1]!;
}

/**
 * Fill `need` copies into `opts.deck` via the suggest-fill loop. Deterministic
 * for the same inputs (D4 mapping + seeded RNG + fixed iteration order).
 *
 * Ink emergence (card-first): with fewer than 2 declared inks, the viable
 * 2-ink pairs are tracked across picks — every candidate must fit at least
 * one pair that still covers all chosen cards, and the deck's inks are
 * decided when a single pair survives. With 2 declared inks, an ink
 * representation boost plus a final guarantee pass keep both inks in the
 * deck (D7).
 */
export function suggestFill(opts: SuggestFillOptions): SuggestFillResult {
  const mapping = mapSlider(opts.novelty);
  const rng = mulberry32(opts.seed);
  const ctx: ScoringContext = buildScoringContext(
    opts.cards,
    opts.model ?? {
      version: '0',
      dataThroughDate: '0000-00-00',
      capabilities: { relations: false, calibration: false },
    },
  );
  const groupLimits = buildGroupLimits(opts.pool);
  const declared = opts.declaredInks ?? [];
  const auto = declared.length < 2;

  const state: FillState = {
    deck: opts.deck,
    groupCounts: opts.groupCounts,
    inkable: opts.inkableBaseline,
    nonInkable: Math.max(0, opts.targetSize - opts.need - opts.inkableBaseline),
    typeCounts: {},
    bandCounts: {},
    deckSize: opts.targetSize,
  };
  for (const [idStr, count] of Object.entries(opts.deck)) {
    const card = opts.byId.get(Number(idStr));
    if (!card) continue;
    if (card.type !== 'Character')
      state.typeCounts[card.type] = (state.typeCounts[card.type] ?? 0) + count;
    state.bandCounts[costBand(card.cost)] =
      (state.bandCounts[costBand(card.cost)] ?? 0) + count;
  }

  // viable pairs start from the declared inks and narrow with every pick
  let pairs: InkPair[] =
    declared.length === 2
      ? [[declared[0]!, declared[1]!]]
      : viablePairs(
          Object.keys(state.deck)
            .map((id) => opts.byId.get(Number(id)))
            .filter((c): c is Card => c !== undefined),
          declared.length === 1
            ? allInkPairs(INKS).filter((p) => p.includes(declared[0]!))
            : allInkPairs(INKS),
        );
  let decidedBy: Card | undefined;
  const pickOrder: number[] = [];

  const room = (card: Card): number => {
    if (opts.locked.has(card.id)) return 0; // partial-deck cards are kept unchanged
    const limit = groupLimits.get(card.groupKey) ?? 4;
    if (limit === 'unlimited') return opts.need;
    return Math.max(0, limit - (state.groupCounts.get(card.groupKey) ?? 0));
  };

  // caps are relative to the whole deck so completing a partial deck
  // re-balances it toward the same inkability band
  const inkableCap = Math.ceil(opts.targetSize * INKABLE_TARGET_SHARE);
  const nonInkableCap = Math.ceil(opts.targetSize * (1 - INKABLE_FLOOR_SHARE));
  const typeCap = Math.ceil(opts.targetSize * 0.3);

  const scoreCard = (
    card: Card,
    canonical: Card,
    vectors: ReturnType<typeof deckVectors>,
    boost: number,
  ): number => {
    const comps = candidateComponents(canonical, ctx, vectors);
    let score =
      mapping.fusionRelationWeight * (comps.relationSim ?? 0) +
      mapping.fusionTextWeight * comps.textSim;
    // D4 candidate weighting: (1−novelty)·w_meta + novelty·w_novel — playrate
    // boosts proven cards at the meta end, unplayed cards at the novel end.
    // The sqrt shaping spreads the long tail of low-playrate cards (most
    // played cards sit at 1–13% tournament share), so "played" actually
    // differentiates from unplayed; the terms still cancel at the middle.
    const playrate = ctx.playrate(card);
    if (playrate !== null) {
      const shaped = Math.sqrt(playrate);
      score += (1 - mapping.noveltyBias) * NOVELTY_WEIGHT * shaped;
      score += mapping.noveltyBias * NOVELTY_WEIGHT * (1 - shaped);
    }
    // cost-curve pressure on the similarity portion (smart-mode playability
    // target: modal cost 2–4) — payoff/deepening boosts stay unmultiplied so
    // expensive shift targets are not suppressed
    score *= costFactor(card.cost);
    // copy policy (D3): deepen toward the trained typical count with a
    // geometric-ish decay; unknown typicals still deepen, just more softly
    const count = state.deck[card.id] ?? 0;
    if (count > 0) {
      const typical = ctx.typicalCopies(card);
      score +=
        DEEPEN_WEIGHT *
        (typical !== null ? Math.max(0, 1 - count / typical) : 0.5 ** count);
    }
    score += boost;
    // needs boosts: cost-curve gaps, character dominance, ink representation
    const band = costBand(card.cost);
    const bandDeficit =
      CURVE_TARGETS[band]! - (state.bandCounts[band] ?? 0) / state.deckSize;
    if (bandDeficit > 0) score += CURVE_WEIGHT * bandDeficit;
    if (
      card.type === 'Character' &&
      (state.typeCounts.Character ?? 0) / state.deckSize < 0.6
    ) {
      score += TYPE_WEIGHT;
    }
    // D7: with two declared inks, lift the under-represented ink
    if (declared.length === 2) {
      const total = Math.max(1, state.inkable + state.nonInkable);
      for (const ink of card.inks) {
        const deficit = INK_REPR_TARGET - (inkCounts[ink] ?? 0) / total;
        if (deficit > 0) score += INK_REPR_WEIGHT * deficit;
      }
    }
    return score;
  };

  // seed weighting (D4): with an empty deck there is nothing to score
  // against, so the first pick samples by playrate^seedExponent —
  // playrate-weighted at the meta end, inverse-playrate at the novel end
  const seedWeight = (card: Card): number => {
    const playrate = ctx.playrate(card);
    const p = (playrate ?? 0.001) + 1e-6;
    return p ** mapping.seedExponent;
  };

  let placed = 0;
  const inkCounts: Partial<Record<Ink, number>> = {};
  for (const [idStr, count] of Object.entries(state.deck)) {
    const card = opts.byId.get(Number(idStr));
    if (!card) continue;
    for (const ink of card.inks) inkCounts[ink] = (inkCounts[ink] ?? 0) + count;
  }
  const deckState = toDeckState(state.deck, opts.inks, opts.format);
  for (let pass = 0; pass < 3 && placed < opts.need; pass++) {
    for (;;) {
      if (placed >= opts.need) break;
      const eligible = opts.pool.filter((card) => {
        if (room(card) <= 0) return false;
        // ink emergence: every pick must keep at least one viable 2-ink pair
        // (an empty pair set — a partial deck spanning 3+ inks — admits nothing)
        if (auto && !cardFitsSomePair(card, pairs)) return false;
        // pass 0: inkables up to the ~75% target; pass 1: non-inkables down
        // to the 70% inkable floor (non-character types capped); pass 2:
        // anything (pool too thin for the targets)
        if (pass === 0) return card.inkwell && state.inkable < inkableCap;
        if (pass === 1) {
          if (card.inkwell || state.nonInkable >= nonInkableCap) return false;
          if (
            card.type !== 'Character' &&
            (state.typeCounts[card.type] ?? 0) >= typeCap
          )
            return false;
          return true;
        }
        return true;
      });
      if (eligible.length === 0) break;

      const vectors = deckVectors(deckState, ctx);
      let picked: Card;
      if (!vectors.text) {
        // empty deck: seed-weighted pick
        const weighted = eligible
          .map((card) => ({ card, score: seedWeight(card) }))
          .sort((a, b) => b.score - a.score || a.card.id - b.card.id);
        picked = sampleTopK(weighted, TOP_K, mapping.temperature + 1, rng).card;
      } else {
        const boosts = payoffBoostMap(state.deck, opts.byId, eligible);
        const scored = eligible
          .map((card) => ({
            card,
            score: scoreCard(
              card,
              ctx.canonicalOf(card),
              vectors,
              boosts.get(card.id) ?? 0,
            ),
          }))
          .sort((a, b) => b.score - a.score || a.card.id - b.card.id);
        picked = sampleTopK(scored, TOP_K, mapping.temperature, rng).card;
      }

      state.deck[picked.id] = (state.deck[picked.id] ?? 0) + 1;
      state.groupCounts.set(
        picked.groupKey,
        (state.groupCounts.get(picked.groupKey) ?? 0) + 1,
      );
      if (picked.inkwell) state.inkable += 1;
      else state.nonInkable += 1;
      if (picked.type !== 'Character')
        state.typeCounts[picked.type] =
          (state.typeCounts[picked.type] ?? 0) + 1;
      state.bandCounts[costBand(picked.cost)] =
        (state.bandCounts[costBand(picked.cost)] ?? 0) + 1;
      for (const ink of picked.inks) inkCounts[ink] = (inkCounts[ink] ?? 0) + 1;
      pickOrder.push(picked.id);
      placed += 1;

      if (auto) {
        const deckCards = Object.keys(state.deck)
          .map((id) => opts.byId.get(Number(id)))
          .filter((c): c is Card => c !== undefined);
        const next = viablePairs(deckCards, pairs);
        if (next.length === 1 && pairs.length !== 1) decidedBy = picked;
        pairs = next;
      }
    }
  }

  // D7 guarantee: with two declared inks, a deck that somehow ended without
  // one of them swaps its most recent non-locked picks for cards of the
  // missing ink until both are represented
  if (declared.length === 2) {
    const missing = declared.find((ink) => (inkCounts[ink] ?? 0) === 0);
    if (missing !== undefined) {
      const pair: InkPair = [declared[0]!, declared[1]!];
      const vectors = deckVectors(deckState, ctx);
      while ((inkCounts[missing] ?? 0) === 0) {
        // replacement first: never strip a card the pool cannot replace
        const candidates = opts.pool
          .filter(
            (card) =>
              card.inks.includes(missing) &&
              cardFitsPair(card, pair) &&
              room(card) > 0,
          )
          .map((card) => ({
            card,
            score: scoreCard(card, ctx.canonicalOf(card), vectors, 0),
          }))
          .sort((a, b) => b.score - a.score || a.card.id - b.card.id);
        const replacement = candidates[0]?.card;
        const removeId = [...pickOrder].reverse().find((id) => {
          const card = opts.byId.get(id);
          return (
            card !== undefined &&
            !opts.locked.has(id) &&
            (state.deck[id] ?? 0) > 0 &&
            !card.inks.includes(missing)
          );
        });
        if (!replacement || removeId === undefined) break;
        const removed = opts.byId.get(removeId)!;
        state.deck[removeId] = (state.deck[removeId] ?? 0) - 1;
        if (state.deck[removeId] === 0) delete state.deck[removeId];
        state.groupCounts.set(
          removed.groupKey,
          Math.max(0, (state.groupCounts.get(removed.groupKey) ?? 1) - 1),
        );
        for (const ink of removed.inks)
          inkCounts[ink] = Math.max(0, (inkCounts[ink] ?? 1) - 1);
        pickOrder.splice(pickOrder.indexOf(removeId), 1);

        state.deck[replacement.id] = (state.deck[replacement.id] ?? 0) + 1;
        state.groupCounts.set(
          replacement.groupKey,
          (state.groupCounts.get(replacement.groupKey) ?? 0) + 1,
        );
        for (const ink of replacement.inks)
          inkCounts[ink] = (inkCounts[ink] ?? 0) + 1;
        pickOrder.push(replacement.id);
      }
    }
  }

  const representedInks = declared.filter((ink) => (inkCounts[ink] ?? 0) > 0);
  const result: SuggestFillResult = { placed, representedInks };
  if (auto && pairs.length === 1) {
    result.pair = pairs[0];
    if (decidedBy) result.decidedBy = decidedBy;
  }
  return result;
}

/**
 * Opt-in goldfish polish (default off): bounded hill-climb of single-card
 * swaps scored by the lore race against one baseline. A swap is kept only
 * when the race improves and the deck stays fully legal; at most 20 swaps,
 * one race per candidate, so polish stays bounded on weak devices.
 */
export function polishDeck(
  deck: DeckState,
  byId: Map<number, Card>,
  pool: Card[],
  locked: Set<number>,
  seed: number,
): { deck: DeckState; swaps: number } {
  const rng = mulberry32(seed);
  const raceScore = (d: DeckState): number => {
    const result = simulateRace(d, byId, 'midrange', {
      trials: 400,
      seed: RACE_POLISH_SEED,
    });
    return result ? result.winRate : 0;
  };
  const groupLimits = buildGroupLimits(pool);
  let current = raceScore(deck);
  let swaps = 0;
  const replaceable = Object.keys(deck.cards)
    .map(Number)
    .filter((id) => !locked.has(id));
  if (replaceable.length === 0) return { deck, swaps: 0 };

  for (let attempt = 0; attempt < 20 && replaceable.length > 0; attempt++) {
    const outId = replaceable[Math.floor(rng() * replaceable.length)]!;
    const outCard = byId.get(outId);
    if (!outCard || (deck.cards[outId] ?? 0) <= 0) continue;
    const trial: DeckState = {
      ...deck,
      cards: { ...deck.cards, [outId]: deck.cards[outId]! - 1 },
    };
    if (trial.cards[outId] === 0) delete trial.cards[outId];
    const usedGroups = new Map<string, number>();
    for (const [id, count] of Object.entries(trial.cards)) {
      const c = byId.get(Number(id));
      if (c)
        usedGroups.set(c.groupKey, (usedGroups.get(c.groupKey) ?? 0) + count);
    }
    const candidates = pool.filter((card) => {
      if (card.id === outId) return false;
      const limit = groupLimits.get(card.groupKey) ?? 4;
      const used = usedGroups.get(card.groupKey) ?? 0;
      if (limit !== 'unlimited' && used >= limit) return false;
      if (card.formats[deck.format] !== true) return false;
      if (card.isDualInk) return card.inks.every((i) => deck.inks.includes(i));
      return card.inks.some((i) => deck.inks.includes(i));
    });
    if (candidates.length === 0) continue;
    const inCard = candidates[Math.floor(rng() * candidates.length)]!;
    trial.cards[inCard.id] = (trial.cards[inCard.id] ?? 0) + 1;
    if (validateDeck(trial, byId).length > 0) continue; // legality-clean improvements only
    const score = raceScore(trial); // single race per candidate
    if (score > current) {
      deck.cards = trial.cards;
      current = score;
      swaps += 1;
    }
  }
  return { deck, swaps };
}

const RACE_POLISH_SEED = 20261119;
