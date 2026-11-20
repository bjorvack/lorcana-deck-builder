import type { Card } from '../../src/data/types';
import type { TrainRow } from './model-types';
import { mulberry32 } from './prng';

/**
 * Interaction miner (M2): card-pair synergy from tournament deck
 * co-occurrence, weighted by deck performance.
 *
 * Raw co-occurrence rewards popularity — a popular card "pairs" with
 * everything. The signal is therefore pair LIFT under deck-quality weighting:
 * a deck contributes weight max(0.05, winRate), so pairs that only appear
 * together in losing decks deflate, and support shrinkage pulls thin pairs to
 * neutral (lift 1). The gate is temporal: pairs selected on the training
 * split must keep their lift advantage on the holdout split (newest events),
 * i.e. the synergy generalizes to future events rather than describing the
 * training era.
 */

export const LIFT_RANDOM_PAIRS = 20_000;
export const LIFT_THRESHOLD = 1.1; // same bar as the relations coherence gate
const SHRINKAGE = 3; // weighted pseudo-co-occurrences
const MIN_SUPPORT = 5; // unweighted decks containing both cards
const TOP_PARTNERS = 8;
const MIN_LIFT = 1.05; // a partner must beat neutral by this much to ship

export interface InteractionGateMetrics {
  metric: 'holdout_lift_ratio';
  /** mean shrunk lift of the selected pairs on the holdout split */
  value: number;
  /** mean shrunk lift of a seeded random-pair baseline on the holdout split */
  random: number;
  threshold: number;
  passed: boolean;
  holdoutDecks: number;
  /** selected synergy pairs */
  pairs: number;
  /** cards with a partner table */
  cards: number;
}

export interface InteractionPartners {
  version: '1';
  /** lift → int8 score factor: score = round((lift − 1) · scale), 0..255 */
  scale: number;
  /** canonical card id → top partners [partnerId, score], score desc */
  partners: Record<string, Array<[number, number]>>;
}

export interface InteractionsOutput {
  passed: boolean;
  partners: InteractionPartners;
  metrics: InteractionGateMetrics;
}

export interface SynergyCapabilityInput {
  /** training split */
  rows: TrainRow[];
  /** holdout split (newest events, evaluation only) */
  holdout: TrainRow[];
  cards: Card[];
  seed?: number;
}

/** pair key: a < b, packed (ids < 4096) */
const pairKey = (a: number, b: number): number => a * 4096 + b;

/** deck weight: winning decks count more, losing decks still count a little */
const deckWeight = (winRate: number): number => Math.max(0.05, winRate);

interface PairStats {
  /** Σ weights of decks containing both */
  co: number;
  /** unweighted decks containing both */
  support: number;
}

function accumulate(rows: TrainRow[]): {
  n: Map<number, number>;
  pairs: Map<number, PairStats>;
  total: number;
  count: number;
} {
  const n = new Map<number, number>();
  const pairs = new Map<number, PairStats>();
  let total = 0;
  let count = 0;
  for (const row of rows) {
    const w = deckWeight(row.winRate);
    total += w;
    count += 1;
    const ids = [...row.counts.keys()].sort((a, b) => a - b);
    for (const id of ids) n.set(id, (n.get(id) ?? 0) + w);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i]!, ids[j]!);
        const stat = pairs.get(key) ?? { co: 0, support: 0 };
        stat.co += w;
        stat.support += 1;
        pairs.set(key, stat);
      }
    }
  }
  return { n, pairs, total, count };
}

/**
 * Shrunk lift: thin support collapses toward 1 (neutral), strong support
 * keeps its measured advantage. lift = co·N / (n_a·n_b), shrunk by
 * co/(co + S).
 */
function shrunkLift(
  co: number,
  nA: number,
  nB: number,
  total: number,
  shrinkage = SHRINKAGE,
): number {
  const expected = (nA * nB) / total;
  if (expected <= 0) return 1;
  const raw = co / expected;
  const confidence = co / (co + shrinkage);
  return 1 + confidence * (raw - 1);
}

/**
 * Holdout evaluation uses stronger shrinkage than training: a pair that
 * happens to co-occur in one holdout deck is noise, not confirmation. Without
 * this, small random corpora pass the gate on variance.
 */
const HOLDOUT_SHRINKAGE = 8;
/** and the pair must appear together in at least this many holdout decks */
const HOLDOUT_MIN_SUPPORT = 3;

function meanHoldoutLift(
  pairs: Array<[number, number]>,
  holdout: {
    n: Map<number, number>;
    pairs: Map<number, PairStats>;
    total: number;
  },
): number {
  if (pairs.length === 0) return 1;
  let sum = 0;
  for (const [a, b] of pairs) {
    const stat = holdout.pairs.get(pairKey(Math.min(a, b), Math.max(a, b)));
    // thin or absent holdout evidence → neutral, not zero: a pair that never
    // (or barely) co-occurred on the holdout neither confirms nor refutes
    const lift =
      stat && stat.support >= HOLDOUT_MIN_SUPPORT
        ? shrunkLift(
            stat.co,
            holdout.n.get(a) ?? 0,
            holdout.n.get(b) ?? 0,
            holdout.total,
            HOLDOUT_SHRINKAGE,
          )
        : 1;
    sum += lift;
  }
  return sum / pairs.length;
}

export function synergyCapability(input: SynergyCapabilityInput): {
  interactions: InteractionsOutput;
} {
  const { rows, holdout, cards, seed } = input;
  const rng = mulberry32(seed ?? 20261120);

  const train = accumulate(rows);
  const holdoutStats = accumulate(holdout);

  // ---- mine: candidates above min support, ranked by shrunk lift ----
  const byLift: Array<{ a: number; b: number; lift: number }> = [];
  for (const [key, stat] of train.pairs) {
    if (stat.support < MIN_SUPPORT) continue;
    const a = Math.floor(key / 4096);
    const b = key % 4096;
    const lift = shrunkLift(
      stat.co,
      train.n.get(a) ?? 0,
      train.n.get(b) ?? 0,
      train.total,
    );
    if (lift >= MIN_LIFT) byLift.push({ a, b, lift });
  }
  byLift.sort((x, y) => y.lift - x.lift || x.a - y.a || x.b - y.b);

  // ---- select: top partners per card (a pair can serve both directions) ----
  const selected: Array<[number, number]> = [];
  const seenPair = new Set<number>();
  const partnerLists = new Map<number, Array<[number, number]>>();
  for (const { a, b, lift } of byLift) {
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = partnerLists.get(self);
      if (list) {
        if (list.length < TOP_PARTNERS) {
          list.push([other, lift]);
          const key = pairKey(Math.min(self, other), Math.max(self, other));
          if (!seenPair.has(key)) {
            seenPair.add(key);
            selected.push([self, other]);
          }
        }
      } else {
        partnerLists.set(self, [[other, lift]]);
        const key = pairKey(Math.min(self, other), Math.max(self, other));
        if (!seenPair.has(key)) {
          seenPair.add(key);
          selected.push([self, other]);
        }
      }
    }
  }

  // ---- gate: selected pairs must keep their advantage on the holdout ----
  const value = meanHoldoutLift(selected, holdoutStats);
  // random baseline over the cards that actually appear on the holdout
  const vocab = [...holdoutStats.n.keys()].sort((a, b) => a - b);
  const randomPairs: Array<[number, number]> = [];
  if (vocab.length >= 2) {
    while (randomPairs.length < LIFT_RANDOM_PAIRS) {
      const a = vocab[Math.floor(rng() * vocab.length)]!;
      const b = vocab[Math.floor(rng() * vocab.length)]!;
      if (a === b) continue;
      randomPairs.push([a, b]);
    }
  }
  const random = meanHoldoutLift(randomPairs, holdoutStats);
  const ratio = random > 1e-9 ? value / random : Infinity;
  const metrics: InteractionGateMetrics = {
    metric: 'holdout_lift_ratio',
    value: round4(value),
    random: round4(random),
    threshold: LIFT_THRESHOLD,
    passed:
      Number.isFinite(ratio) && ratio >= LIFT_THRESHOLD && selected.length > 0,
    holdoutDecks: holdoutStats.count,
    pairs: selected.length,
    cards: partnerLists.size,
  };

  // ---- quantize: (lift − 1) · scale → int8 score, decode-friendly ----
  const maxLift = byLift.length > 0 ? Math.min(byLift[0]!.lift, 4) : 1;
  const scale = maxLift > 1 ? 255 / (maxLift - 1) : 1;
  const partners: Record<string, Array<[number, number]>> = {};
  if (metrics.passed) {
    const known = new Set(cards.map((c) => c.id));
    for (const [self, list] of [...partnerLists.entries()].sort(
      (x, y) => x[0] - y[0],
    )) {
      if (!known.has(self)) continue;
      partners[String(self)] = list
        .map(
          ([other, lift]) =>
            [
              other,
              Math.max(0, Math.min(255, Math.round((lift - 1) * scale))),
            ] as [number, number],
        )
        .sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    }
  }

  return {
    interactions: {
      passed: metrics.passed,
      partners: { version: '1', scale: round4(scale), partners },
      metrics,
    },
  };
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
