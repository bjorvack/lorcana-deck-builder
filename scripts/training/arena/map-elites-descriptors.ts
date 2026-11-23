/**
 * MAP-Elites behaviour descriptors (self-play-league, task 4.1).
 *
 * A behaviour descriptor compresses a deck into a few deterministic numbers
 * computed from card data only; the archive indexes elite decks by the binned
 * descriptor cell (see map-elites-archive.ts). Everything here is a pure
 * function of (identity counts × card snapshot) — no RNG, no engine, no I/O —
 * so identical decks always produce identical cell keys (the deterministic
 * archive requirement, task 4.4).
 */
import type { Card } from '../../../src/data/types';

export interface BehaviourDescriptor {
  /** count-weighted mean cost over all copies */
  avgCost: number;
  /** share of copies that are inkwell (inkable) */
  inkableRatio: number;
  /**
   * share of copies per type. Location copies (rare) count towards the
   * denominator but none of the three shares, so the mix can sum to < 1.
   */
  typeMix: { character: number; action: number; item: number };
  /**
   * Expected lore per turn over the whole deck (see LORE_HORIZON_TURNS):
   * Σ over character copies of lore × max(0, H − cost) / H. A character
   * costing C is assumed to enter play around turn C+1 and quest every
   * surviving turn of an H-turn game; dividing by H turns total lore into a
   * per-turn rate. Deliberately ignores ink ramp, removal and challenges —
   * it is a transparent, card-data-only proxy, not a simulation.
   */
  lorePerTurnProxy: number;
}

/** game horizon of the lore/turn proxy, in turns */
export const LORE_HORIZON_TURNS = 10;

/**
 * Describe a deck (identity id → count) from the card snapshot. Unknown
 * identities are skipped defensively (same convention as
 * src/rules resolveEntries); an empty deck yields the zero descriptor.
 */
export function describeDeck(
  deck: Record<string, number>,
  cards: readonly Card[],
): BehaviourDescriptor {
  const byId = new Map(cards.map((c) => [c.id, c]));
  let total = 0;
  let costSum = 0;
  let inkable = 0;
  const types = { Character: 0, Action: 0, Item: 0 };
  let loreSum = 0;
  for (const [identity, count] of Object.entries(deck)) {
    if (count <= 0) continue;
    const card = byId.get(Number(identity));
    if (!card) continue;
    total += count;
    costSum += count * card.cost;
    if (card.inkwell) inkable += count;
    if (card.type === 'Character') {
      types.Character += count;
      loreSum +=
        count * (card.lore ?? 0) * Math.max(0, LORE_HORIZON_TURNS - card.cost);
    } else if (card.type === 'Action') {
      types.Action += count;
    } else if (card.type === 'Item') {
      types.Item += count;
    }
  }
  const share = (copies: number): number => (total === 0 ? 0 : copies / total);
  return {
    avgCost: share(costSum),
    inkableRatio: share(inkable),
    typeMix: {
      character: share(types.Character),
      action: share(types.Action),
      item: share(types.Item),
    },
    lorePerTurnProxy: loreSum / LORE_HORIZON_TURNS,
  };
}

export interface CellBins {
  /** avgCost bin width, floor(avgCost / width) (default 0.5) */
  avgCostWidth?: number;
  /**
   * ascending inkableRatio bin edges; bins are right-open [e_i, e_{i+1})
   * with the last bin closed (default quartiles [0, 0.25, 0.5, 0.75, 1])
   */
  inkableRatioEdges?: number[];
  /** secondary type-share bin edges, same convention (default [0, 0.1, 0.2, 0.3, 1]) */
  secondaryShareEdges?: number[];
  /** lorePerTurnProxy bin width, floor(value / width) (default 0.5) */
  lorePerTurnWidth?: number;
}

const DEFAULT_AVG_COST_WIDTH = 0.5;
const DEFAULT_INKABLE_EDGES = [0, 0.25, 0.5, 0.75, 1];
const DEFAULT_SECONDARY_EDGES = [0, 0.1, 0.2, 0.3, 1];
const DEFAULT_LORE_WIDTH = 0.5;

/**
 * Index of `value` in ascending right-open bins: bin i = [edges[i], edges[i+1])
 * for i < last, the last bin closed. Requires edges[0] to be the lower bound.
 */
export function binIndex(value: number, edges: readonly number[]): number {
  const sorted = [...edges].sort((a, b) => a - b);
  let count = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (value >= sorted[i]!) count += 1;
  }
  return Math.min(count, Math.max(0, sorted.length - 2));
}

const TYPE_ORDER = ['character', 'action', 'item'] as const;

/** dominant type (ties broken in character > action > item order) + runner-up share */
export function dominantAndSecondary(mix: BehaviourDescriptor['typeMix']): {
  dominant: (typeof TYPE_ORDER)[number];
  secondaryShare: number;
} {
  const shares: Array<[(typeof TYPE_ORDER)[number], number]> = [
    ['character', mix.character],
    ['action', mix.action],
    ['item', mix.item],
  ];
  shares.sort(
    (a, b) =>
      b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]),
  );
  return { dominant: shares[0]![0], secondaryShare: shares[1]![1] };
}

/**
 * Stable archive cell key over binned descriptor dimensions:
 *   cost-<i>_ink-<j>_mix-<dominant>-<k>_lore-<m>
 * A pure function of the descriptor (and bins): same input → same key.
 */
export function descriptorCell(
  descriptor: BehaviourDescriptor,
  bins: CellBins = {},
): string {
  const avgCostWidth = bins.avgCostWidth ?? DEFAULT_AVG_COST_WIDTH;
  const inkEdges = bins.inkableRatioEdges ?? DEFAULT_INKABLE_EDGES;
  const secEdges = bins.secondaryShareEdges ?? DEFAULT_SECONDARY_EDGES;
  const loreWidth = bins.lorePerTurnWidth ?? DEFAULT_LORE_WIDTH;
  const { dominant, secondaryShare } = dominantAndSecondary(descriptor.typeMix);
  return [
    `cost-${Math.floor(descriptor.avgCost / avgCostWidth)}`,
    `ink-${binIndex(descriptor.inkableRatio, inkEdges)}`,
    `mix-${dominant}-${binIndex(secondaryShare, secEdges)}`,
    `lore-${Math.floor(descriptor.lorePerTurnProxy / loreWidth)}`,
  ].join('_');
}
