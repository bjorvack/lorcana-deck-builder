import type { Card, DeckState, Ink } from '../data/types';

export interface CostBucket {
  cost: number;
  inkable: number;
  notInkable: number;
}

export interface DeckStats {
  total: number;
  inkable: number;
  inkablePct: number;
  inkabilityByCost: CostBucket[];
  /** copies per ink; dual-ink cards count toward both */
  byInk: Partial<Record<Ink, number>>;
  /** subset of byInk coming from dual-ink cards */
  byInkDual: Partial<Record<Ink, number>>;
  byType: Record<string, number>;
  byRarity: Record<string, number>;
  byFranchise: Record<string, number>;
  byTag: Record<string, number>;
  avgStrength: number | null;
  avgWillpower: number | null;
  avgLore: number | null;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

/** weighted average over characters, copies-weighted; null when no characters */
function average(entries: { card: Card; count: number }[], pick: (c: Card) => number | undefined): number | null {
  let sum = 0;
  let n = 0;
  for (const { card, count } of entries) {
    if (card.type !== 'Character') continue;
    const value = pick(card);
    if (value === undefined) continue;
    sum += value * count;
    n += count;
  }
  return n === 0 ? null : sum / n;
}

export function computeStats(deck: DeckState, byId: Map<number, Card>): DeckStats {
  const entries: { card: Card; count: number }[] = [];
  for (const [idStr, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(idStr));
    if (card && count > 0) entries.push({ card, count });
  }

  const total = entries.reduce((s, e) => s + e.count, 0);
  const inkable = entries.reduce((s, e) => s + (e.card.inkwell ? e.count : 0), 0);

  const byInk: Partial<Record<Ink, number>> = {};
  const byInkDual: Partial<Record<Ink, number>> = {};
  const byType: Record<string, number> = {};
  const byRarity: Record<string, number> = {};
  const byFranchise: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  const costBuckets = new Map<number, CostBucket>();

  for (const { card, count } of entries) {
    for (const ink of card.inks) {
      byInk[ink] = (byInk[ink] ?? 0) + count;
      if (card.isDualInk) byInkDual[ink] = (byInkDual[ink] ?? 0) + count;
    }
    bump(byType, card.type, count);
    bump(byRarity, card.rarity, count);
    if (card.franchise) bump(byFranchise, card.franchise, count);
    for (const tag of card.tags) bump(byTag, tag.tag, count);
    const bucket = costBuckets.get(card.cost) ?? { cost: card.cost, inkable: 0, notInkable: 0 };
    if (card.inkwell) bucket.inkable += count;
    else bucket.notInkable += count;
    costBuckets.set(card.cost, bucket);
  }

  return {
    total,
    inkable,
    inkablePct: total === 0 ? 0 : inkable / total,
    inkabilityByCost: [...costBuckets.values()].sort((a, b) => a.cost - b.cost),
    byInk,
    byInkDual,
    byType,
    byRarity,
    byFranchise,
    byTag,
    avgStrength: average(entries, (c) => c.strength),
    avgWillpower: average(entries, (c) => c.willpower),
    avgLore: average(entries, (c) => c.lore),
  };
}
