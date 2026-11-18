import type { Card, DeckState } from '../data/types';

/**
 * Keep rule used for the opening-hand metric (documented in the panel):
 * a hand is keepable when it holds at least 3 inkable cards and at least
 * one card of cost 2 or less. When the first look fails, the once-per-game
 * hand alteration (CR 2.2.2.1 — free partial mulligan) bottoms the non-inkable
 * cards and redraws up to 7; the deck is shuffled afterwards (CR 2.2.2.3).
 */
export const KEEP_RULE = '≥3 inkable cards and ≥1 card of cost ≤ 2';

export interface HandQuality {
  trials: number;
  /** P(keepable opening hand, using the once-per-game alteration when the first look fails) */
  keepableRate: number;
  /** share of games where the alteration was used */
  alteredShare: number;
}

export const HAND_TRIALS = 5_000;
export const HAND_SEED = 20261117;

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

const keepable = (hand: { cost: number; inkwell: boolean }[]): boolean =>
  hand.filter((c) => c.inkwell).length >= 3 && hand.some((c) => c.cost <= 2);

export function openingHandQuality(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: { trials?: number; seed?: number } = {}
): HandQuality | null {
  const trials = opts.trials ?? HAND_TRIALS;
  const rng = mulberry32(opts.seed ?? HAND_SEED);

  const pool: { cost: number; inkwell: boolean }[] = [];
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card || count <= 0) continue;
    for (let i = 0; i < count; i++) pool.push({ cost: card.cost, inkwell: card.inkwell });
  }
  if (pool.length === 0) return null;

  let keepableCount = 0;
  let alteredCount = 0;
  for (let trial = 0; trial < trials; trial++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const hand = pool.slice(0, Math.min(7, pool.length));
    if (!keepable(hand)) {
      alteredCount++;
      // alteration: bottom the non-inkable cards, shuffle the deck, draw back up to 7
      const kept = hand.filter((c) => c.inkwell);
      const need = hand.length - kept.length;
      // the deck (minus the kept hand) is shuffled, so redraws are uniform draws
      const rest = [...pool.slice(hand.length)];
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [rest[i], rest[j]] = [rest[j]!, rest[i]!];
      }
      hand.length = 0;
      hand.push(...kept, ...rest.slice(0, need));
    }
    if (keepable(hand)) keepableCount++;
  }

  return { trials, keepableRate: keepableCount / trials, alteredShare: alteredCount / trials };
}
