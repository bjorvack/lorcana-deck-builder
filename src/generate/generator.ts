import type {
  Card,
  DeckState,
  Format,
  GeneratorNote,
  Ink,
} from '../data/types';
import { INKS } from '../data/types';
import type { MetaModel } from '../meta/infer';
import { MIN_DECK_SIZE } from '../rules/engine';
import {
  createLearnedFillSource,
  type GeneratorModelArtifact,
  type LearnedFillSource,
} from './learned-fill';
import { suggestFill } from './suggest-fill';

/** every ink — the auto-mode pool passes the ink filter for all of them */
const ALL_GENERATOR_INKS: Ink[] = [...INKS];

/** the inks a filled deck actually needs (≤ 2 by construction of the loop) */
function derivedInks(
  deck: Record<number, number>,
  byId: Map<number, Card>,
): Ink[] {
  const inks = new Set<Ink>();
  for (const [id] of Object.entries(deck)) {
    for (const ink of byId.get(Number(id))?.inks ?? []) inks.add(ink);
  }
  return [...inks].slice(0, 2);
}

export interface GenerateOptions {
  cards: Card[];
  /** 0 inks (or omitted) = ink-emergent mode: inks derive from the picked cards */
  inks?: Ink[];
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
  /** trained-synergy blend share (interactions capability); default 0.25 */
  synergyWeight?: number;
  /**
   * Parsed generator-model artifact (loadGeneratorModel, design D5). Absent
   * (undefined) = the learned-completion feature is not in use: no source
   * note, shipped behavior byte-identical. Null or un-gated → the shipped
   * suggest-fill path with a fallback note in the debug output.
   */
  learnedModel?: GeneratorModelArtifact | null;
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

/**
 * Number of distinct full-name cards per franchise that are legal for the
 * given format and inks, counting off-ink cards when an ink-exemption source
 * (e.g. Christopher Robin - Hunny Sage) is itself legal. Dual-ink cards still
 * require both of their inks to be selected; empty inks means "all inks".
 */
export function franchiseUniqueCounts(
  cards: Card[],
  format: Format,
  inks: Ink[],
): Map<string, number> {
  const poolInks = inks.length > 0 ? inks : [...INKS];
  const byFranchise = new Map<string, Card[]>();
  for (const card of cards) {
    if (!formatLegal(card, format)) continue;
    const list = byFranchise.get(card.franchise) ?? [];
    list.push(card);
    byFranchise.set(card.franchise, list);
  }

  const counts = new Map<string, number>();
  for (const [franchise, candidates] of byFranchise) {
    if (!franchise) continue;
    const effective = new Set<Card>();
    const queue: Card[] = [];
    for (const card of candidates) {
      if (inkLegal(card, poolInks)) {
        effective.add(card);
        queue.push(card);
      }
    }
    while (queue.length > 0) {
      const source = queue.shift()!;
      for (const effect of source.deckRuleEffects) {
        if (effect.kind !== 'inkExemption') continue;
        for (const card of candidates) {
          if (effective.has(card)) continue;
          if (effect.exceptSelf && card.id === effect.sourceCardId) continue;
          if (!effect.targetTypes.includes(card.type)) continue;
          if (!card.subtypes.some((s) => effect.targetSubtypes.includes(s)))
            continue;
          // ink exemptions never bypass the dual-ink both-inks requirement
          if (card.isDualInk && !card.inks.every((i) => poolInks.includes(i)))
            continue;
          if (card.inks.length === 0) continue;
          // if the card is already ink-legal it would already be in effective
          if (inkLegal(card, poolInks)) continue;
          effective.add(card);
          queue.push(card);
        }
      }
    }
    counts.set(franchise, new Set([...effective].map((c) => c.fullName)).size);
  }
  return counts;
}

/** ink + format legal pool, optionally restricted to sets/franchises */
export function buildPool(
  cards: Card[],
  opts: Pick<
    GenerateOptions,
    'inks' | 'format' | 'sets' | 'franchises' | 'partial'
  >,
): {
  pool: Card[];
  exemptionActive: boolean;
} {
  const poolInks = opts.inks && opts.inks.length > 0 ? opts.inks : [...INKS];
  const partial = opts.partial ?? {};
  const partialCards = Object.entries(partial)
    .map(([id, count]) => ({
      card: cards.find((c) => c.id === Number(id)),
      count,
    }))
    .filter(
      (e): e is { card: Card; count: number } =>
        e.card !== undefined && e.count > 0,
    );

  // an ink exemption present in the partial deck widens the pool for its targets
  const exemptions = partialCards.flatMap(({ card }) =>
    card.deckRuleEffects.filter(
      (
        e,
      ): e is Extract<
        (typeof card)['deckRuleEffects'][number],
        { kind: 'inkExemption' }
      > => e.kind === 'inkExemption',
    ),
  );
  const exempt = (card: Card): boolean =>
    card.inks.length > 0 &&
    // ink exemptions never bypass the dual-ink both-inks requirement
    (!card.isDualInk || card.inks.every((i) => poolInks.includes(i))) &&
    exemptions.some(
      (e) =>
        e.targetTypes.includes(card.type) &&
        e.targetSubtypes.some((s) => card.subtypes.includes(s)) &&
        !(e.exceptSelf && card.id === e.sourceCardId),
    );

  const pool = cards.filter((card) => {
    if (!formatLegal(card, opts.format)) return false;
    if (!inkLegal(card, poolInks) && !exempt(card)) return false;
    if (opts.sets && opts.sets.length > 0 && !opts.sets.includes(card.setCode))
      return false;
    if (
      opts.franchises &&
      opts.franchises.length > 0 &&
      !opts.franchises.includes(card.franchise)
    )
      return false;
    return true;
  });
  return { pool, exemptionActive: exemptions.length > 0 };
}

function sumCards(deck: Record<number, number>): number {
  return Object.values(deck).reduce((s, c) => s + c, 0);
}

function buildGroupCounts(
  deck: Record<number, number>,
  byId: Map<number, Card>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, count] of Object.entries(deck)) {
    const card = byId.get(Number(id));
    if (card)
      counts.set(card.groupKey, (counts.get(card.groupKey) ?? 0) + count);
  }
  return counts;
}

export function generateDeck(opts: GenerateOptions): GenerateResult {
  const declared = opts.inks ?? [];
  if (declared.length > 2) {
    return {
      deck: null,
      notes: { relaxations: [], notes: [] },
      error: 'Pick 1 or 2 inks (or none for auto)',
    };
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
    notes.notes.push(
      `Kept ${partialTotal} cards from your partial deck unchanged.`,
    );
  }

  // learned completion source (D5): resolved once, reused by every attempt.
  // Only a valid artifact whose A/B gate passed enables the learned path;
  // anything else degrades to the shipped suggest-fill scoring.
  let learned: LearnedFillSource | null | undefined;
  if (opts.learnedModel !== undefined) {
    learned = opts.learnedModel
      ? createLearnedFillSource(opts.learnedModel, byId)
      : null;
    if (learned)
      notes.notes.push(
        'Fill source: learned generator model (A/B gate passed).',
      );
    else if (opts.learnedModel === null)
      notes.notes.push(
        'Fill source: suggest-fill (learned model artifact unavailable).',
      );
    else
      notes.notes.push(
        'Fill source: suggest-fill (learned model not gate-passed).',
      );
  }

  const attempt = (
    sets: string[] | undefined,
    franchises: string[] | undefined,
  ): Record<number, number> => {
    const deck = { ...partial };
    const need = targetSize - partialTotal;
    if (need > 0) {
      // auto mode pools every format-legal card (all inks pass the filter);
      // the viable-ink-pair constraint inside suggestFill narrows per pick
      const poolInks = declared.length > 0 ? declared : ALL_GENERATOR_INKS;
      const { pool } = buildPool(opts.cards, {
        ...opts,
        inks: poolInks,
        sets,
        franchises,
        partial,
      });
      const rngSeed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
      const inkableBaseline = Object.entries(deck).reduce(
        (s, [id, count]) => s + (byId.get(Number(id))?.inkwell ? count : 0),
        0,
      );
      const locked = new Set(Object.keys(partial).map(Number));
      const groupCounts = buildGroupCounts(deck, byId);
      const fill = suggestFill({
        pool,
        deck,
        need,
        novelty,
        seed: rngSeed,
        synergyWeight: opts.synergyWeight,
        model: opts.model ?? null,
        cards: opts.cards,
        inks: poolInks,
        declaredInks: declared,
        format: opts.format,
        targetSize,
        locked,
        groupCounts,
        inkableBaseline,
        byId,
        learned,
      });
      if (fill.pair) {
        notes.notes.push(
          `Inks derived as ${fill.pair.join('/')} (decided by ${fill.decidedBy?.fullName ?? 'your partial deck'}).`,
        );
      } else if (declared.length === 0) {
        notes.notes.push(
          'No ink pair emerged — the deck plays with the inks its cards need.',
        );
      }
    }
    return deck;
  };

  const franchiseSelected = (opts.franchises?.length ?? 0) > 0;
  let cards = attempt(opts.sets, opts.franchises);
  if (sumCards(cards) < targetSize && !franchiseSelected) {
    notes.relaxations.push(
      declared.length > 0
        ? 'Not enough cards in the filtered pool — expanded to the full pool of your inks.'
        : 'Not enough cards in the filtered pool — expanded to the full pool.',
    );
    cards = attempt(undefined, undefined);
  }
  if (sumCards(cards) < targetSize) {
    const filterLabel = franchiseSelected
      ? ` in the selected franchise`
      : declared.length > 0
        ? ` — the ${declared.join('/')} pool is too small`
        : '';
    return {
      deck: null,
      notes,
      error: `Only ${sumCards(cards)}/${targetSize} cards available${filterLabel}`,
    };
  }

  // inks emerge from the cards: declare what the deck actually needs
  const derived = declared.length > 0 ? declared : derivedInks(cards, byId);
  return {
    deck: {
      title: 'Generated Deck',
      inks: derived,
      format: opts.format,
      cards,
    },
    notes,
  };
}
