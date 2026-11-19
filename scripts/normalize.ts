import { readFileSync } from 'node:fs';
import type {
  Card,
  CardType,
  CopyLimit,
  DeckRuleEffect,
  Ink,
  Payoff,
  SetInfo,
} from '../src/data/types';
import {
  buildPayoffVocabulary,
  compilePayoffRules,
  extractPayoffs,
  isUnparseableShiftText,
  type PayoffRule,
} from '../src/text/refs';
import overridesJson from './deck-rule-overrides.json';
import type { FetchResult } from './fetch';

const INK_NAMES = new Set([
  'Amber',
  'Amethyst',
  'Emerald',
  'Ruby',
  'Sapphire',
  'Steel',
]);

/** raw lorcanajson card — only the fields we consume are typed */
export interface RawCard {
  id: number;
  name: string;
  version?: string;
  color?: string;
  colors?: string[];
  cost: number;
  inkwell?: boolean;
  type: string;
  subtypes?: string[];
  rarity: string;
  setCode?: string;
  number: number | null;
  fullText?: string;
  keywordAbilities?: string[];
  story?: string;
  strength?: number;
  willpower?: number;
  lore?: number;
  moveCost?: number;
  maxCopiesInDeck?: number | null;
  images?: { thumbnail?: string; full?: string };
  collectorNumber?: string;
  fullIdentifier?: string;
  setNumber?: number;
  allowedInFormats?: Record<
    string,
    { allowed?: boolean; bannedSinceDate?: string } | undefined
  >;
  releaseDate?: string;
  reprintOfId?: number;
}

export interface RawAllCards {
  metadata?: { generatedOn?: string; formatVersion?: string };
  sets?: Record<string, RawSet>;
  cards: RawCard[];
}

export interface RawSet {
  code?: string;
  name?: string;
  number?: number;
  type?: string;
  releaseDate?: string;
  prereleaseDate?: string | null;
  cardCounts?: {
    base?: number;
    nonBase?: number;
    promo?: number;
    total?: number;
  };
}

export interface LorcastCard {
  name?: string;
  version?: string | null;
  collector_number?: string;
  prices?: { usd?: string | null; usd_foil?: string | null };
  image_uris?: { digital?: { normal?: string; large?: string } };
}

export interface Derivation {
  cardId: number;
  field: string;
}

export interface OverrideEntry {
  fullName: string;
  effect: Omit<DeckRuleEffect, 'sourceCardId'>;
}

const OVERRIDES = (
  overridesJson as { version: number; overrides: OverrideEntry[] }
).overrides;
const DECK_RULE_PHRASES = (overridesJson as { deckRulePhrases: string[] })
  .deckRulePhrases;
/** payoff overrides replace pattern-extracted payoffs for their card (task: rulings-accurate special cases) */
export interface PayoffOverrideEntry {
  fullName: string;
  payoffs: Payoff[];
  citation?: string;
}
const PAYOFF_OVERRIDES =
  (overridesJson as { payoffOverrides?: PayoffOverrideEntry[] })
    .payoffOverrides ?? [];

export function groupKey(fullName: string): string {
  return fullName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function buildFullName(raw: RawCard): string {
  return raw.version ? `${raw.name} - ${raw.version}` : raw.name;
}

function normalizeInks(raw: RawCard): Ink[] {
  const colors = raw.colors ?? (raw.color ? raw.color.split('-') : []);
  return colors.filter((c): c is Ink => INK_NAMES.has(c));
}

function normalizeType(type: string): CardType {
  if (type === 'Character' || type === 'Item' || type === 'Location')
    return type;
  return 'Action';
}

function normalizeMaxCopies(raw: RawCard): CopyLimit {
  if (!('maxCopiesInDeck' in raw) || raw.maxCopiesInDeck === undefined)
    return 4;
  if (raw.maxCopiesInDeck === null) return 'unlimited';
  return raw.maxCopiesInDeck;
}

function buildEffects(raw: RawCard): DeckRuleEffect[] {
  const fullName = buildFullName(raw);
  return OVERRIDES.filter((o) => o.fullName === fullName).map((o) => ({
    kind: o.effect.kind,
    sourceCardId: raw.id,
    targetTypes: o.effect.targetTypes,
    targetSubtypes: o.effect.targetSubtypes,
    exceptSelf: o.effect.exceptSelf,
    note: o.effect.note,
  }));
}

/** deck-rule phrasing in text that neither has an override nor a data-driven copy limit */
export function unknownDeckRuleText(raw: RawCard): boolean {
  const text = raw.fullText ?? '';
  if (!text) return false;
  if (!DECK_RULE_PHRASES.some((p) => new RegExp(p, 'i').test(text)))
    return false;
  if ('maxCopiesInDeck' in raw) return false; // explained by the data field
  return buildEffects(raw).length === 0;
}

export function normalizeCard(
  raw: RawCard,
  ctx: { setInfo: SetInfo | undefined; derivations: Derivation[] },
): Card {
  const inks = normalizeInks(raw);
  const type = normalizeType(raw.type);
  const fullName = buildFullName(raw);
  let inkwell = raw.inkwell;
  if (inkwell === undefined || inkwell === null) {
    inkwell = type === 'Character' || type === 'Item';
    ctx.derivations.push({ cardId: raw.id, field: 'inkwell' });
  }
  const allowed = raw.allowedInFormats ?? {};
  const core = allowed.Core?.allowed === true;
  const banned = Object.values(allowed).some((f) => f?.bannedSinceDate);
  const infinity = allowed.Infinity?.allowed !== false && !banned;

  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    fullName,
    groupKey: groupKey(fullName),
    inks,
    isDualInk: inks.length === 2,
    cost: raw.cost,
    inkwell: Boolean(inkwell),
    type,
    subtypes: raw.subtypes ?? [],
    isSong: (raw.subtypes ?? []).includes('Song'),
    franchise: raw.story ?? '',
    setCode: raw.setCode ?? '',
    setName: ctx.setInfo?.name ?? '',
    setNumber: raw.setNumber ?? 0,
    setType: ctx.setInfo?.type ?? 'expansion',
    rarity: raw.rarity,
    maxCopies: normalizeMaxCopies(raw),
    strength: raw.strength,
    willpower: raw.willpower,
    lore: raw.lore,
    moveCost: raw.moveCost,
    text: raw.fullText ?? '',
    keywords: raw.keywordAbilities ?? [],
    tags: [],
    deckRuleEffects: buildEffects(raw),
    // payoffs are extracted corpus-wide in normalizeAll (the vocabulary needs
    // every card's names, classifications and keywords)
    payoffs: [],
    images: {
      thumb: raw.images?.thumbnail,
      full: raw.images?.full,
    },
    collectorNumber:
      raw.number != null ? String(raw.number) : raw.fullIdentifier,
    releasedAt: ctx.setInfo?.releaseDate ?? raw.releaseDate,
    formats: { core, infinity },
  };
}

export function buildSets(raw: RawAllCards): SetInfo[] {
  return Object.entries(raw.sets ?? {}).map(([code, s]) => ({
    code,
    number: s.number ?? 0,
    name: s.name ?? code,
    type: s.type === 'quest' ? 'quest' : 'expansion',
    releaseDate: s.releaseDate,
    prereleaseDate: s.prereleaseDate ?? null,
  }));
}

const lorcastPriceKey = (c: LorcastCard): string =>
  `${c.collector_number ?? ''}|${c.name ?? ''}`;

/** merge Lorcast prices + second image source into normalized cards (cosmetic only) */
export function mergeLorcast(
  cards: Card[],
  bySet: Record<string, unknown[]>,
): number {
  let merged = 0;
  for (const card of cards) {
    const raws = (bySet[card.setCode] ?? []) as LorcastCard[];
    const match = raws.find(
      (r) =>
        lorcastPriceKey(r) === `${card.collectorNumber ?? ''}|${card.name}`,
    );
    if (!match) continue;
    if (match.prices?.usd || match.prices?.usd_foil) {
      card.prices = {
        usd: match.prices.usd ?? undefined,
        usdFoil: match.prices.usd_foil ?? undefined,
      };
    }
    const alt = match.image_uris?.digital?.normal;
    if (alt) card.images.alt = alt;
    merged++;
  }
  return merged;
}

export interface NormalizeResult {
  cards: Card[];
  sets: SetInfo[];
  meta: { generatedOn?: string; formatVersion?: string };
  derivations: Derivation[];
  missingStory: number[];
  needsReview: { cardId: number; reason: string }[];
}

/** extract typed payoffs for every card, applying overrides; flags unparseable shift-like text */
export function attachPayoffs(
  cards: Card[],
  rules: PayoffRule[],
  needsReview: { cardId: number; reason: string }[],
): void {
  const vocab = buildPayoffVocabulary(cards);
  const compiled = compilePayoffRules({ payoffRules: rules });
  const overrides = new Map(PAYOFF_OVERRIDES.map((o) => [o.fullName, o]));
  for (const card of cards) {
    const override = overrides.get(card.fullName);
    card.payoffs = override
      ? structuredClone(override.payoffs)
      : extractPayoffs(card, compiled, vocab);
    if (isUnparseableShiftText(card)) {
      needsReview.push({
        cardId: card.id,
        reason: 'shift-like text without a parseable payoff',
      });
    }
  }
}

export function normalizeAll(data: FetchResult): NormalizeResult {
  const raw = data.allCards as RawAllCards;
  const sets = buildSets(raw);
  const setByCode = new Map(sets.map((s) => [s.code, s]));
  const derivations: Derivation[] = [];
  const missingStory: number[] = [];
  const needsReview: { cardId: number; reason: string }[] = [];

  const cards = (raw.cards ?? []).map((rawCard) => {
    if (!rawCard.story) missingStory.push(rawCard.id);
    if (unknownDeckRuleText(rawCard)) {
      needsReview.push({
        cardId: rawCard.id,
        reason: 'deck-rule phrasing without a known effect',
      });
    }
    return normalizeCard(rawCard, {
      setInfo: setByCode.get(rawCard.setCode ?? ''),
      derivations,
    });
  });

  mergeLorcast(cards, data.lorcastBySet);
  attachPayoffs(
    cards,
    loadPayoffRules(new URL('./tag-rules.json', import.meta.url).pathname),
    needsReview,
  );

  return {
    cards,
    sets,
    meta: raw.metadata ?? {},
    derivations,
    missingStory,
    needsReview,
  };
}

export function loadOverrides(): OverrideEntry[] {
  return OVERRIDES;
}

/** payoff pattern rules from tag-rules.json (payoffRules section) */
export function loadPayoffRules(file: string): PayoffRule[] {
  const rules = JSON.parse(readFileSync(file, 'utf8')) as {
    payoffRules?: PayoffRule[];
  };
  return rules.payoffRules ?? [];
}
