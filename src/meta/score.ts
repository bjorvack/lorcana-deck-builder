import { buildCanonicalRegistry } from '../../scripts/training/canonical';
import type { Card, DeckState, Ink } from '../data/types';
import { INKS } from '../data/types';
import { inkLegal } from '../generate/generator';
import type { MetaModel } from './infer';

/**
 * Shared candidate-scoring primitives (D1): the suggestion panel and the
 * generator both score candidates with the fused relation+text similarity
 * over the same canonicalized identity, the same legality filters and the
 * same per-card popularity data — one implementation, identical components.
 *
 * The relation space comes from the artifact (tournament co-occurrence); the
 * text space is derived client-side from card content, so brand-new cards
 * score immediately. Candidates missing from one space are ranked by the
 * other alone.
 */

// ---------------------------------------------------------------------------
// Canonical identity — shared implementation with the trainer (D1)
// ---------------------------------------------------------------------------

const aliasCache = new WeakMap<object, Map<number, number>>();

/** print id → canonical id, memoized per card list (one identity per card) */
export function canonicalAliasFor(cards: Card[]): Map<number, number> {
  let alias = aliasCache.get(cards);
  if (!alias) {
    alias = buildCanonicalRegistry(cards).alias;
    aliasCache.set(cards, alias);
  }
  return alias;
}

const byIdCache = new WeakMap<Card[], Map<number, Card>>();

export function byIdFor(cards: Card[]): Map<number, Card> {
  let byId = byIdCache.get(cards);
  if (!byId) {
    byId = new Map(cards.map((c) => [c.id, c]));
    byIdCache.set(cards, byId);
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Relation space (artifact-borne)
// ---------------------------------------------------------------------------

export interface RelationEmbeddings {
  dim: number;
  quantization: string;
  vectors: Record<string, { b64: string; scale: number }>;
}

const decodeCache = new WeakMap<
  RelationEmbeddings,
  Map<number, Float64Array>
>();

/** decoded relation vectors (canonical card id → vector), memoized per artifact */
export function relationVectors(model: MetaModel): Map<number, Float64Array> {
  const decoded = new Map<number, Float64Array>();
  if (!model.relations || !model.capabilities.relations) return decoded;
  const cache = decodeCache.get(model.relations);
  if (cache) return cache;
  const { dim, vectors } = model.relations;
  for (const [id, { b64, scale }] of Object.entries(vectors)) {
    const bin = atob(b64);
    if (bin.length < dim * 2) continue;
    const v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) {
      // sign-extended little-endian Int16 × scale
      v[d] =
        (((bin.charCodeAt(2 * d) | (bin.charCodeAt(2 * d + 1) << 8)) << 16) >>
          16) *
        scale;
    }
    decoded.set(Number(id), v);
  }
  decodeCache.set(model.relations, decoded);
  return decoded;
}

export const cosineVec = (a: Float64Array, b: Float64Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < Math.min(a.length, b.length); d++) {
    dot += a[d]! * b[d]!;
    na += a[d]! * a[d]!;
    nb += b[d]! * b[d]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

/** count-weighted, L2-normalized mean of the deck cards' vectors; null when no member has one */
function deckVectorFrom(
  deck: DeckState,
  byId: Map<number, Card>,
  perCard: (card: Card) => Float64Array | null,
): Float64Array | null {
  let acc: Float64Array | null = null;
  let total = 0;
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card) continue;
    const v = perCard(card);
    if (!v) continue;
    if (!acc) acc = new Float64Array(v.length);
    total += count;
    for (let d = 0; d < acc.length; d++) acc[d]! += count * v[d]!;
  }
  if (!acc || total === 0) return null;
  let norm = 0;
  for (let d = 0; d < acc.length; d++) norm += acc[d]! * acc[d]!;
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let d = 0; d < acc.length; d++) acc[d] = acc[d]! * inv;
  return acc;
}

// ---------------------------------------------------------------------------
// Text-feature space (pure function of card content, D4)
// ---------------------------------------------------------------------------

/**
 * Feature blocks, ALL derived from the live snapshot — newer sets bring new
 * keywords, classifications and franchises, so nothing here is a frozen list:
 * game keywords (one-hot — the shift family collapses to one dimension),
 * gameplay tags (one-hot, from the snapshot's tag rules), classifications
 * (one-hot, card subtypes), franchise (one-hot), card type (one-hot), cost
 * band (one-hot, ≤2 / 3–4 / 5–6 / 7+), ink (one-hot, 6 — dual-ink lights
 * both), scaled stats (strength/willpower/lore ÷ 10). L2-normalized.
 * Text vectors never ship: they are computed client-side and memoized per
 * snapshot, so unchanged cards derive identical vectors and new sets are
 * covered immediately (cold start).
 */
export interface TextFeatureVocab {
  keywords: string[];
  tags: string[];
  classifications: string[];
  franchises: string[];
  types: string[];
  dim: number;
  /** per-vocab vector cache — a rebuilt vocab invalidates old vectors */
  vectors: WeakMap<Card, Float64Array>;
}

export function buildTextFeatureVocab(cards: Card[]): TextFeatureVocab {
  const keywords = new Set<string>();
  const tags = new Set<string>();
  const classifications = new Set<string>();
  const franchises = new Set<string>();
  const types = new Set<string>();
  for (const card of cards) {
    for (const keyword of card.keywords) {
      const feature = keywordFeature(keyword);
      if (feature) keywords.add(feature);
    }
    for (const { tag } of card.tags) tags.add(tag);
    for (const subtype of card.subtypes) classifications.add(subtype);
    if (card.franchise) franchises.add(card.franchise);
    types.add(card.type);
  }
  const kw = [...keywords].sort();
  const tg = [...tags].sort();
  const cl = [...classifications].sort();
  const fr = [...franchises].sort();
  const ty = [...types].sort();
  return {
    keywords: kw,
    tags: tg,
    classifications: cl,
    franchises: fr,
    types: ty,
    dim:
      kw.length +
      tg.length +
      cl.length +
      fr.length +
      ty.length +
      4 +
      INKS.length +
      3,
    vectors: new WeakMap(),
  };
}

/** single-slot memo — suggest paths re-derive from the same card list each call */
let vocabCards: Card[] | null = null;
let vocabMemo: TextFeatureVocab | null = null;

export function textFeatureVocab(cards: Card[]): TextFeatureVocab {
  if (cards === vocabCards && vocabMemo) return vocabMemo;
  const vocab = buildTextFeatureVocab(cards);
  vocabCards = cards;
  vocabMemo = vocab;
  return vocab;
}

const costBand = (cost: number): number =>
  cost <= 2 ? 0 : cost <= 4 ? 1 : cost <= 6 ? 2 : 3;

/** all *Shift variants (Floodborn, Madrigal, Temporary, …) share one dimension */
const keywordFeature = (keyword: string): string =>
  keyword === 'Shift' || keyword.endsWith(' Shift') ? 'Shift' : keyword;

export function cardTextVector(
  card: Card,
  vocab: TextFeatureVocab,
): Float64Array {
  const cached = vocab.vectors.get(card);
  if (cached) return cached;
  const v = new Float64Array(vocab.dim);
  const tagOffset = vocab.keywords.length;
  const classificationOffset = tagOffset + vocab.tags.length;
  const franchiseOffset = classificationOffset + vocab.classifications.length;
  const typeOffset = franchiseOffset + vocab.franchises.length;
  const costBandOffset = typeOffset + vocab.types.length;
  const inkOffset = costBandOffset + 4;
  const statsOffset = inkOffset + INKS.length;
  for (const keyword of card.keywords) {
    const feature = keywordFeature(keyword);
    const idx = vocab.keywords.indexOf(feature);
    if (idx >= 0) v[idx] = 1;
  }
  for (const { tag } of card.tags) {
    const idx = vocab.tags.indexOf(tag);
    if (idx >= 0) v[tagOffset + idx] = 1;
  }
  for (const classification of card.subtypes) {
    const idx = vocab.classifications.indexOf(classification);
    if (idx >= 0) v[classificationOffset + idx] = 1;
  }
  if (card.franchise) {
    const idx = vocab.franchises.indexOf(card.franchise);
    if (idx >= 0) v[franchiseOffset + idx] = 1;
  }
  const typeIdx = vocab.types.indexOf(card.type);
  if (typeIdx >= 0) v[typeOffset + typeIdx] = 1;
  v[costBandOffset + costBand(card.cost)] = 1;
  for (const ink of card.inks) {
    const idx = INKS.indexOf(ink as Ink);
    if (idx >= 0) v[inkOffset + idx] = 1;
  }
  v[statsOffset] = (card.strength ?? 0) / 10;
  v[statsOffset + 1] = (card.willpower ?? 0) / 10;
  v[statsOffset + 2] = (card.lore ?? 0) / 10;
  let norm = 0;
  for (let d = 0; d < v.length; d++) norm += v[d]! * v[d]!;
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let d = 0; d < v.length; d++) v[d] = v[d]! * inv;
  }
  vocab.vectors.set(card, v);
  return v;
}

// ---------------------------------------------------------------------------
// Deck vectors over both spaces
// ---------------------------------------------------------------------------

/** count-weighted, L2-normalized text-feature vector of the deck */
export function deckTextVector(
  deck: DeckState,
  byId: Map<number, Card>,
  canonical: (card: Card) => Card = (c) => c,
  vocab: TextFeatureVocab = textFeatureVocab([...byId.values()]),
): Float64Array | null {
  return deckVectorFrom(deck, byId, (card) =>
    cardTextVector(canonical(card), vocab),
  );
}

/**
 * count-weighted, L2-normalized relation vector of the deck; canonical-id
 * resolved (embeddings key on the newest print of a group), null when no
 * member has one
 */
export function deckRelationVector(
  deck: DeckState,
  byId: Map<number, Card>,
  vectors: Map<number, Float64Array>,
  alias: Map<number, number>,
): Float64Array | null {
  if (vectors.size === 0) return null;
  return deckVectorFrom(
    deck,
    byId,
    (card) => vectors.get(alias.get(card.id) ?? card.id) ?? null,
  );
}

// ---------------------------------------------------------------------------
// Generator-facing scoring context (suggest-fill consumes this per-iteration)
// ---------------------------------------------------------------------------

/** fused score = 0.6 × relation similarity + 0.4 × text similarity (D5) */
export const FUSION_WEIGHTS = { relation: 0.6, text: 0.4 } as const;

export interface ScoringContext {
  cards: Card[];
  byId: Map<number, Card>;
  /** one identity per card (the newest print per full name) */
  canonicalByGroup: Map<string, Card>;
  canonicalOf: (card: Card) => Card;
  alias: Map<number, number>;
  vocab: TextFeatureVocab;
  /** decoded relation vectors (may be empty when the capability failed) */
  relations: Map<number, Float64Array>;
  /** share of training decks containing the card, 0–1; null when unknown */
  playrate: (card: Card) => number | null;
  /** typical copy count when played, 1–4; null when unknown */
  typicalCopies: (card: Card) => number | null;
}

/**
 * Everything fused candidate scoring needs, built once per (cards, model).
 * Playrate/typical-copies lookups resolve through the canonical alias and
 * return null when the artifact predates the maps (version '2') or the card.
 * Playrate is normalized by the artifact's maximum share — raw shares top out
 * around 0.3 (no card is in 30%+ of decks), which would mute both slider
 * endpoints; relative popularity is what the weighting consumes.
 */
export function buildScoringContext(
  cards: Card[],
  model: MetaModel,
): ScoringContext {
  const registry = buildCanonicalRegistry(cards);
  const { alias, canonicalByGroup } = registry;
  const canonicalOf = (card: Card): Card =>
    registry.canonicalByGroup.get(card.groupKey) ?? card;
  const byId = byIdFor(cards);
  const relations = relationVectors(model);
  const playrateMap = model.playrate;
  const copiesMap = model.typicalCopies;
  const maxPlayrate = playrateMap
    ? Math.max(1, ...Object.values(playrateMap))
    : 1;
  return {
    cards,
    byId,
    canonicalByGroup,
    canonicalOf,
    alias,
    vocab: textFeatureVocab(cards),
    relations,
    playrate: (card) => {
      if (!playrateMap) return null;
      const raw = playrateMap[String(alias.get(card.id) ?? card.id)];
      return raw === undefined ? null : Math.min(1, raw / maxPlayrate);
    },
    typicalCopies: (card) => {
      if (!copiesMap) return null;
      const raw = copiesMap[String(alias.get(card.id) ?? card.id)];
      return raw === undefined ? null : raw;
    },
  };
}

export interface DeckVectors {
  text: Float64Array | null;
  relation: Float64Array | null;
}

/** deck vectors over both spaces, recomputed as the deck evolves */
export function deckVectors(deck: DeckState, ctx: ScoringContext): DeckVectors {
  return {
    text: deckTextVector(deck, ctx.byId, ctx.canonicalOf, ctx.vocab),
    relation: deckRelationVector(deck, ctx.byId, ctx.relations, ctx.alias),
  };
}

export interface CandidateComponents {
  /** relation-embedding similarity; null when the relation space does not cover the candidate */
  relationSim: number | null;
  textSim: number;
  /** fused score with the documented weights; text-only when the relation space is unavailable */
  score: number;
}

/** similarity components of one candidate against the deck's vectors */
export function candidateComponents(
  candidate: Card,
  ctx: ScoringContext,
  vectors: DeckVectors,
): CandidateComponents {
  if (!vectors.text) return { relationSim: null, textSim: 0, score: 0 };
  const textSim = cosineVec(cardTextVector(candidate, ctx.vocab), vectors.text);
  let relationSim: number | null = null;
  if (vectors.relation) {
    const candidateRelation = ctx.relations.get(candidate.id);
    if (candidateRelation)
      relationSim = cosineVec(candidateRelation, vectors.relation);
  }
  const score =
    relationSim !== null
      ? FUSION_WEIGHTS.relation * relationSim + FUSION_WEIGHTS.text * textSim
      : textSim;
  return { relationSim, textSim, score };
}

/**
 * Legality filter shared by the panel and the generator: format, declared
 * inks and the group copy limit — by group identity, so a different print of
 * the same name counts as owned.
 */
export function legalCandidate(
  deck: DeckState,
  groupCounts: Map<string, number>,
  candidate: Card,
): boolean {
  if (groupCounts.has(candidate.groupKey)) return false; // owned (any print of the name)
  if (candidate.formats[deck.format] !== true) return false;
  if (!inkLegal(candidate, deck.inks)) return false;
  const maxCopies = candidate.maxCopies;
  if (
    maxCopies !== 'unlimited' &&
    (groupCounts.get(candidate.groupKey) ?? 0) >= maxCopies
  )
    return false;
  return true;
}

/** group copy counts across prints, for legalCandidate */
export function groupCountsOf(
  deck: DeckState,
  byId: Map<number, Card>,
): Map<string, number> {
  const groupCounts = new Map<string, number>();
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (card)
      groupCounts.set(
        card.groupKey,
        (groupCounts.get(card.groupKey) ?? 0) + count,
      );
  }
  return groupCounts;
}
