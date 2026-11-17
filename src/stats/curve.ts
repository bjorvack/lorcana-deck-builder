import type { Card, DeckState } from '../data/types';

export interface CurveConsistency {
  trials: number;
  /** per turn 1..maxTurns: P(a cost-t card was played on turn t); null when the deck has no cost-t cards */
  byTurn: (number | null)[];
  /** mean ink available to spend on each turn (after the ink step), indexed 1..maxTurns */
  expectedInk: number[];
  /** median consecutive on-curve turns starting at turn 1; turns the deck has no matching cost for are skipped */
  onCurveThrough: number;
}

export const CURVE_TRIALS = 20_000;
export const CURVE_MAX_TURNS = 7;
/** fixed so the dashboard shows stable numbers between renders */
export const CURVE_SEED = 20261117;

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

/**
 * Monte Carlo estimate of how reliably a deck plays "on curve" (a cost-t card
 * on turn t). Each trial shuffles the deck, draws 7, then per turn draws 1 and
 * inks once with a greedy policy: ink the highest-cost inkable that is
 * unaffordable this turn (preserving plays), else the cheapest affordable
 * inkable; then play the best affordable card, preferring exact curve cost.
 * Inking before playing is legal, and ink momentum is preferred over
 * off-curve plays.
 */
export function curveConsistency(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: { trials?: number; maxTurns?: number; seed?: number } = {}
): CurveConsistency | null {
  const trials = opts.trials ?? CURVE_TRIALS;
  const maxTurns = opts.maxTurns ?? CURVE_MAX_TURNS;
  const rng = mulberry32(opts.seed ?? CURVE_SEED);

  const pool: { cost: number; inkwell: boolean }[] = [];
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card || count <= 0) continue;
    for (let i = 0; i < count; i++) pool.push({ cost: card.cost, inkwell: card.inkwell });
  }
  if (pool.length === 0) return null;
  const hasCost = new Set(pool.map((c) => c.cost));

  const onCurveCount = new Array<number>(maxTurns + 1).fill(0);
  const inkSum = new Array<number>(maxTurns + 1).fill(0);
  const streaks: number[] = [];

  for (let trial = 0; trial < trials; trial++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const hand = pool.slice(0, Math.min(7, pool.length));
    let deckIdx = hand.length;
    let ink = 0;
    let streak = 0;
    let broken = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      if (deckIdx < pool.length) hand.push(pool[deckIdx++]!);

      // ink step: unaffordable-highest first, else cheapest affordable
      let unaffordable = -1;
      let unaffordableCost = -1;
      let affordable = -1;
      let affordableCost = Infinity;
      for (let i = 0; i < hand.length; i++) {
        const c = hand[i]!;
        if (!c.inkwell) continue;
        if (c.cost > ink + 1) {
          if (c.cost > unaffordableCost) {
            unaffordableCost = c.cost;
            unaffordable = i;
          }
        } else if (c.cost < affordableCost) {
          affordableCost = c.cost;
          affordable = i;
        }
      }
      const inkIdx = unaffordable !== -1 ? unaffordable : affordable;
      if (inkIdx !== -1) {
        ink++;
        hand.splice(inkIdx, 1);
      }
      inkSum[turn]! += ink;

      // play step: best affordable card, exact curve cost wins
      let curveIdx = -1;
      let bestIdx = -1;
      let bestCost = -1;
      for (let i = 0; i < hand.length; i++) {
        const c = hand[i]!;
        if (c.cost > ink) continue;
        if (c.cost === turn) {
          if (curveIdx === -1) curveIdx = i;
        } else if (c.cost > bestCost) {
          bestCost = c.cost;
          bestIdx = i;
        }
      }
      const played = curveIdx !== -1 ? turn : bestIdx !== -1 ? hand[bestIdx]!.cost : null;
      if (curveIdx !== -1) hand.splice(curveIdx, 1);
      else if (bestIdx !== -1) hand.splice(bestIdx, 1);

      if (played === turn) onCurveCount[turn]!++;
      if (!broken) {
        if (played === turn) streak++;
        else if (hasCost.has(turn)) broken = true; // no matching cost in deck → skipped, not a miss
      }
    }
    streaks.push(streak);
  }

  const sorted = [...streaks].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;

  return {
    trials,
    // index 0 is an unused placeholder so array index === turn number
    byTurn: [
      null,
      ...Array.from({ length: maxTurns }, (_, i) => (hasCost.has(i + 1) ? onCurveCount[i + 1]! / trials : null)),
    ],
    expectedInk: [0, ...Array.from({ length: maxTurns }, (_, i) => inkSum[i + 1]! / trials)],
    onCurveThrough: median,
  };
}
