import type { Card, DeckState, Format, GeneratorNote, Ink } from '../data/types';
import { MIN_DECK_SIZE } from '../rules/engine';
import type { MetaModel } from '../meta/infer';
import { polishDeck, suggestFill } from './suggest-fill';

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
  /** Meta ↔ Novel slider: 0 = proven meta, 1 = fully novel; default middle */
  novelty?: number;
  seed?: number;
  targetSize?: number;
  /** trained artifact for relation vectors + popularity; null/absent → neutral weighting, text-only */
  model?: MetaModel | null;
  /** opt-in goldfish polish (default off) */
  polish?: boolean;
}

export interface GenerateResult {
  deck: DeckState | null;
  notes: GeneratorNote;
  error?: string;
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

function sumCards(deck: Record<number, number>): number {
  return Object.values(deck).reduce((s, c) => s + c, 0);
}

function buildGroupCounts(deck: Record<number, number>, byId: Map<number, Card>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, count] of Object.entries(deck)) {
    const card = byId.get(Number(id));
    if (card) counts.set(card.groupKey, (counts.get(card.groupKey) ?? 0) + count);
  }
  return counts;
}

export function generateDeck(opts: GenerateOptions): GenerateResult {
  if (opts.inks.length === 0 || opts.inks.length > 2) {
    return { deck: null, notes: { relaxations: [], notes: [] }, error: 'Pick 1 or 2 inks first' };
  }
  const targetSize = opts.targetSize ?? MIN_DECK_SIZE;
  const byId = new Map(opts.cards.map((c) => [c.id, c]));
  const notes: GeneratorNote = { relaxations: [], notes: [] };
  const novelty = opts.novelty ?? 0.5;

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
      const rngSeed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
      const inkableBaseline = Object.entries(deck).reduce(
        (s, [id, count]) => s + (byId.get(Number(id))?.inkwell ? count : 0),
        0
      );
      const locked = new Set(Object.keys(partial).map(Number));
      const groupCounts = buildGroupCounts(deck, byId);
      suggestFill({
        pool,
        deck,
        need,
        novelty,
        seed: rngSeed,
        model: opts.model ?? null,
        cards: opts.cards,
        inks: opts.inks,
        format: opts.format,
        targetSize,
        locked,
        groupCounts,
        inkableBaseline,
        byId,
      });
    }
    if (opts.polish && sumCards(deck) >= targetSize) {
      const { pool } = buildPool(opts.cards, { ...opts, sets, franchises, partial });
      const { swaps } = polishDeck(
        { title: '', inks: [...opts.inks], format: opts.format, cards: deck },
        byId,
        pool,
        new Set(Object.keys(partial).map(Number)),
        (opts.seed ?? 0) + 1
      );
      if (swaps > 0) notes.notes.push(`Polish: ${swaps} swap${swaps === 1 ? '' : 's'} improved the goldfish race.`);
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
