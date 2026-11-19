import { type Card, type DeckState, INKS, type Ink } from '../data/types';
import { resolveEntries } from '../rules/engine';

export interface CostBucket {
  cost: number;
  inkable: number;
  notInkable: number;
}

/** one matrix row: an ink (pure cards) or a dual-ink combination */
export interface CostInkRow {
  key: string;
  label: string;
  inks: Ink[];
  /** cost -> copy count */
  cells: Record<number, number>;
}

export interface StatDistributions {
  strength: Record<number, number>;
  willpower: Record<number, number>;
  lore: Record<number, number>;
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
  /** copies per ink per cost; one row per ink plus one per dual combination */
  costInkRows: CostInkRow[];
  maxCost: number;
  byType: Record<string, number>;
  byRarity: Record<string, number>;
  byFranchise: Record<string, number>;
  byTag: Record<string, number>;
  /** characters only, copies-weighted */
  distributions: StatDistributions;
  avgStrength: number | null;
  avgWillpower: number | null;
  avgLore: number | null;
}

function bump(
  map: Record<string | number, number>,
  key: string | number,
  by = 1,
): void {
  map[key] = (map[key] ?? 0) + by;
}

/** weighted average over characters, copies-weighted; null when no characters */
function average(
  entries: { card: Card; count: number }[],
  pick: (c: Card) => number | undefined,
): number | null {
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

export function computeStats(
  deck: DeckState,
  byId: Map<number, Card>,
): DeckStats {
  const entries = resolveEntries(deck, byId);

  const total = entries.reduce((s, e) => s + e.count, 0);
  const inkable = entries.reduce(
    (s, e) => s + (e.card.inkwell ? e.count : 0),
    0,
  );

  const byInk: Partial<Record<Ink, number>> = {};
  const byInkDual: Partial<Record<Ink, number>> = {};
  const distributions: StatDistributions = {
    strength: {},
    willpower: {},
    lore: {},
  };
  const byType: Record<string, number> = {};
  const byRarity: Record<string, number> = {};
  const byFranchise: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  const costBuckets = new Map<number, CostBucket>();
  const rowMap = new Map<string, CostInkRow>();

  for (const { card, count } of entries) {
    for (const ink of card.inks) {
      byInk[ink] = (byInk[ink] ?? 0) + count;
      if (card.isDualInk) byInkDual[ink] = (byInkDual[ink] ?? 0) + count;
    }
    bump(byType, card.type, count);
    bump(byRarity, card.rarity, count);
    if (card.franchise) bump(byFranchise, card.franchise, count);
    for (const tag of card.tags) bump(byTag, tag.tag, count);
    if (card.type === 'Character') {
      for (const [key, value] of [
        ['strength', card.strength],
        ['willpower', card.willpower],
        ['lore', card.lore],
      ] as const) {
        if (value !== undefined) bump(distributions[key], value, count);
      }
    }
    const bucket = costBuckets.get(card.cost) ?? {
      cost: card.cost,
      inkable: 0,
      notInkable: 0,
    };
    if (card.inkwell) bucket.inkable += count;
    else bucket.notInkable += count;
    costBuckets.set(card.cost, bucket);
    // matrix rows: pure cards land on their ink, duals on a shared dual row
    const rowKey = card.isDualInk
      ? `dual:${[...card.inks].sort().join('/')}`
      : (card.inks[0] ?? 'none');
    const row = rowMap.get(rowKey) ?? {
      key: rowKey,
      label: card.isDualInk
        ? `Dual (${card.inks.join('/')})`
        : (card.inks[0] ?? 'No ink'),
      inks: card.inks,
      cells: {},
    };
    row.cells[card.cost] = (row.cells[card.cost] ?? 0) + count;
    rowMap.set(rowKey, row);
  }

  const inkOrder = (row: CostInkRow): number => {
    const idx = row.inks.length === 1 ? INKS.indexOf(row.inks[0]!) : 99;
    return idx === -1 ? 98 : idx;
  };
  const costInkRows = [...rowMap.values()].sort((a, b) => {
    const diff = inkOrder(a) - inkOrder(b);
    return diff !== 0 ? diff : a.key.localeCompare(b.key);
  });
  const maxCost = entries.reduce((m, e) => Math.max(m, e.card.cost), 0);

  return {
    total,
    inkable,
    inkablePct: total === 0 ? 0 : inkable / total,
    inkabilityByCost: [...costBuckets.values()].sort((a, b) => a.cost - b.cost),
    byInk,
    byInkDual,
    costInkRows,
    maxCost,
    byType,
    byRarity,
    byFranchise,
    byTag,
    distributions,
    avgStrength: average(entries, (c) => c.strength),
    avgWillpower: average(entries, (c) => c.willpower),
    avgLore: average(entries, (c) => c.lore),
  };
}
