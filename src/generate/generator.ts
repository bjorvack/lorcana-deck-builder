import type { Card, DeckState, Format, GeneratorNote, Ink } from '../data/types';
import { MIN_DECK_SIZE } from '../rules/engine';

export type GenerateMode = 'smart' | 'chaos';

export interface GenerateOptions {
  cards: Card[];
  inks: Ink[];
  format: Format;
  /** optional set-code filter (a relaxation candidate) */
  sets?: string[];
  /** optional franchise filter (a relaxation candidate) */
  franchises?: string[];
  /** partial deck to complete; cards are kept unchanged even if they violate rules */
  partial?: Record<number, number>;
  mode: GenerateMode;
  seed?: number;
  targetSize?: number;
}

export interface GenerateResult {
  deck: DeckState | null;
  notes: GeneratorNote;
  error?: string;
}

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

export function inkLegal(card: Card, inks: Ink[]): boolean {
  if (card.isDualInk) return card.inks.every((i) => inks.includes(i));
  return card.inks.some((i) => inks.includes(i));
}

export function formatLegal(card: Card, format: Format): boolean {
  return format === 'core' ? card.formats.core : card.formats.infinity;
}

/** ink + format legal pool, optionally restricted to sets/franchises */
export function buildPool(
  cards: Card[],
  opts: Pick<GenerateOptions, 'inks' | 'format' | 'sets' | 'franchises' | 'partial'>
): {
  pool: Card[];
  exemptionActive: boolean;
} {
  const partial = opts.partial ?? {};
  const partialCards = Object.entries(partial)
    .map(([id, count]) => ({ card: cards.find((c) => c.id === Number(id)), count }))
    .filter((e): e is { card: Card; count: number } => e.card !== undefined && e.count > 0);

  // an ink exemption present in the partial deck widens the pool for its targets
  const exemptions = partialCards.flatMap(({ card }) =>
    card.deckRuleEffects.filter((e): e is Extract<(typeof card)['deckRuleEffects'][number], { kind: 'inkExemption' }> => e.kind === 'inkExemption')
  );
  const exempt = (card: Card): boolean =>
    exemptions.some(
      (e) =>
        e.targetTypes.includes(card.type) &&
        e.targetSubtypes.some((s) => card.subtypes.includes(s)) &&
        !(e.exceptSelf && card.id === e.sourceCardId)
    );

  const pool = cards.filter((card) => {
    if (!formatLegal(card, opts.format)) return false;
    if (!inkLegal(card, opts.inks) && !exempt(card)) return false;
    if (opts.sets && opts.sets.length > 0 && !opts.sets.includes(card.setCode)) return false;
    if (opts.franchises && opts.franchises.length > 0 && !opts.franchises.includes(card.franchise)) return false;
    return true;
  });
  return { pool, exemptionActive: exemptions.length > 0 };
}

export function smartScore(card: Card): number {
  let score = 1;
  if (card.inkwell) score *= 1.7;
  score *= { Character: 1.0, Action: 0.35, Item: 0.2, Location: 0.05 }[card.type] ?? 0.3;
  score *= card.cost <= 4 ? 1.0 : card.cost <= 5 ? 0.7 : card.cost <= 6 ? 0.5 : 0.3;
  // build-around enablers (deck-rule effects like Christopher Robin's Hunny
  // exemption) are worth including even when expensive
  if (card.deckRuleEffects.length > 0) score *= 1.5;
  return score;
}

// benchmarked against official precons (73-88% inkable) and competitive
// lists (73-90%, median 80%): target the competitive midpoint, never drop
// below the observed competitive floor
const INKABLE_TARGET_SHARE = 0.75;
const INKABLE_FLOOR_SHARE = 0.7;

function sumCards(deck: Record<number, number>): number {
  return Object.values(deck).reduce((s, c) => s + c, 0);
}

/** group limits are per full name across prints; fills must respect the group, not the print */
function buildGroupLimits(cards: Card[]): Map<string, number | 'unlimited'> {
  const limits = new Map<string, number | 'unlimited'>();
  for (const card of cards) {
    const current = limits.get(card.groupKey);
    if (card.maxCopies === 'unlimited') limits.set(card.groupKey, 'unlimited');
    else if (current === undefined || current === 'unlimited') limits.set(card.groupKey, card.maxCopies);
    else limits.set(card.groupKey, Math.min(current, card.maxCopies));
  }
  return limits;
}

function buildGroupCounts(deck: Record<number, number>, byId: Map<number, Card>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, count] of Object.entries(deck)) {
    const card = byId.get(Number(id));
    if (card) counts.set(card.groupKey, (counts.get(card.groupKey) ?? 0) + count);
  }
  return counts;
}

function fillSmart(
  deck: Record<number, number>,
  pool: Card[],
  need: number,
  rng: () => number,
  inkableBaseline: number,
  locked: Set<number>,
  groupCounts: Map<string, number>,
  deckSize: number
): number {
  const current = (id: number): number => deck[id] ?? 0;
  const groupLimits = buildGroupLimits(pool);
  const remainingLimit = (card: Card): number => {
    if (locked.has(card.id)) return 0; // partial-deck cards are kept unchanged
    const limit = groupLimits.get(card.groupKey) ?? 4;
    if (limit === 'unlimited') return need;
    const groupCount = groupCounts.get(card.groupKey) ?? 0;
    return Math.max(0, limit - groupCount);
  };

  // caps are relative to the whole deck so completing a partial deck
  // re-balances it toward the same inkability band
  let inkableSoFar = inkableBaseline;
  let nonInkableSoFar = deckSize - need - inkableBaseline;
  const inkableCap = Math.ceil(deckSize * INKABLE_TARGET_SHARE);
  const nonInkableCap = Math.ceil(deckSize * (1 - INKABLE_FLOOR_SHARE));
  // keep any single non-character type below ~30% so characters stay the
  // dominant type; pass 2 lifts the cap when the pool is too thin
  const typeCap = Math.ceil(deckSize * 0.3);
  const typeCounts: Record<string, number> = {};
  let placed = 0;
  for (let pass = 0; pass < 3 && placed < need; pass++) {
    const candidates = pool
      .map((card) => ({ card, score: smartScore(card) + rng() * 0.35 }))
      .sort((a, b) => b.score - a.score);
    for (const { card } of candidates) {
      if (placed >= need) break;
      if (pass === 0 && !card.inkwell) continue;
      if (pass === 1 && card.inkwell) continue;
      // pass 0: inkables up to the ~75% target; pass 1: non-inkables down to
      // the 70% inkable floor; pass 2: anything (pool too thin for the targets)
      let room = Math.min(
        remainingLimit(card),
        need - placed,
        pass === 0 ? inkableCap - inkableSoFar : pass === 1 ? nonInkableCap - nonInkableSoFar : need
      );
      if (pass === 1 && card.type !== 'Character') {
        room = Math.min(room, typeCap - (typeCounts[card.type] ?? 0));
      }
      if (room <= 0) continue;
      deck[card.id] = current(card.id) + room;
      placed += room;
      groupCounts.set(card.groupKey, (groupCounts.get(card.groupKey) ?? 0) + room);
      if (card.inkwell) inkableSoFar += room;
      else nonInkableSoFar += room;
      if (card.type !== 'Character') typeCounts[card.type] = (typeCounts[card.type] ?? 0) + room;
    }
  }
  return placed;
}

function fillChaos(deck: Record<number, number>, pool: Card[], need: number, rng: () => number, locked: Set<number>, groupCounts: Map<string, number>): number {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const groupLimits = buildGroupLimits(pool);
  let placed = 0;
  for (const card of shuffled) {
    if (placed >= need) break;
    if (locked.has(card.id)) continue; // partial-deck cards are kept unchanged
    const limit = groupLimits.get(card.groupKey) ?? 4;
    const groupUsed = groupCounts.get(card.groupKey) ?? 0;
    const room = Math.min(limit === 'unlimited' ? need : limit - groupUsed, need - placed);
    if (room <= 0) continue;
    deck[card.id] = (deck[card.id] ?? 0) + room;
    groupCounts.set(card.groupKey, groupUsed + room);
    placed += room;
  }
  return placed;
}

export function generateDeck(opts: GenerateOptions): GenerateResult {
  if (opts.inks.length === 0 || opts.inks.length > 2) {
    return { deck: null, notes: { relaxations: [], notes: [] }, error: 'Pick 1 or 2 inks first' };
  }
  const targetSize = opts.targetSize ?? MIN_DECK_SIZE;
  const byId = new Map(opts.cards.map((c) => [c.id, c]));
  const notes: GeneratorNote = { relaxations: [], notes: [] };

  const partial: Record<number, number> = {};
  for (const [id, count] of Object.entries(opts.partial ?? {})) {
    if (byId.has(Number(id)) && count > 0) partial[Number(id)] = count;
  }
  const partialTotal = sumCards(partial);
  if (partialTotal > 0) {
    notes.notes.push(`Kept ${partialTotal} cards from your partial deck unchanged.`);
  }

  const attempt = (sets: string[] | undefined, franchises: string[] | undefined): Record<number, number> => {
    const deck = { ...partial };
    const need = targetSize - partialTotal;
    if (need > 0) {
      const { pool } = buildPool(opts.cards, { ...opts, sets, franchises, partial });
      const rng = mulberry32(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
      const inkableBaseline = Object.entries(deck).reduce(
        (s, [id, count]) => s + (byId.get(Number(id))?.inkwell ? count : 0),
        0
      );
      const locked = new Set(Object.keys(partial).map(Number));
      const groupCounts = buildGroupCounts(deck, byId);
      if (opts.mode === 'smart') fillSmart(deck, pool, need, rng, inkableBaseline, locked, groupCounts, targetSize);
      else fillChaos(deck, pool, need, rng, locked, groupCounts);
    }
    return deck;
  };

  const hasFilters = (opts.sets?.length ?? 0) > 0 || (opts.franchises?.length ?? 0) > 0;
  let cards = attempt(opts.sets, opts.franchises);
  if (sumCards(cards) < targetSize && hasFilters) {
    notes.relaxations.push('Not enough cards in the filtered pool — expanded to the full pool of your inks.');
    cards = attempt(undefined, undefined);
  }
  if (sumCards(cards) < targetSize) {
    return {
      deck: null,
      notes,
      error: `Only ${sumCards(cards)}/${targetSize} cards available — the ${opts.inks.join('/')} pool is too small`,
    };
  }

  return {
    deck: { title: 'Generated Deck', inks: [...opts.inks], format: opts.format, cards },
    notes,
  };
}
