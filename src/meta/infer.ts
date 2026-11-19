import type { Card, DeckState, Ink } from '../data/types';
import { INKS } from '../data/types';
import type { Fingerprint } from '../stats/fingerprint';
import { inkLegal } from '../generate/generator';
import { buildCanonicalRegistry } from '../../scripts/training/canonical';

/**
 * Client-side meta inference. The model artifact is produced offline by the
 * training pipeline (scripts/training/) and shipped as a static same-origin
 * file — the running app never calls an external service. A missing artifact
 * means "meta unavailable"; the deterministic fingerprint works regardless.
 *
 * The artifact is capability-gated (relations / calibration pass or fail
 * independently): whichever capability passed ships its fields, the other is
 * omitted. Suggestions need the relations capability; archetype matching needs
 * the calibration capability.
 */

export interface MetaArchetype {
  id: number;
  name: string;
  /** observed win rate of the archetype in the training window, 0-1 */
  observedWinRate: number;
  /** number of tournament decks behind the win rate */
  sampleSize: number;
  /** mean normalized card-count vector (canonical card id → share of the 60) */
  centroid: Record<string, number>;
}

/** relation embeddings as shipped: Int16 + per-vector scale, base64, little-endian */
export interface RelationEmbeddings {
  dim: number;
  quantization: string;
  vectors: Record<string, { b64: string; scale: number }>;
}

export interface MetaModel {
  version: string;
  /** YYYY-MM-DD — newest tournament data included in training */
  dataThroughDate: string;
  cardSchemaVersion?: number;
  capabilities: { relations: boolean; calibration: boolean };
  gates?: {
    relations?: { metric: string; value: number; threshold: number; passed: boolean };
    calibration?: { metric: string; value: number; baseline: number; passed: boolean };
  };
  /** calibration capability — present only when its gate passed */
  archetypes?: MetaArchetype[];
  cardWeights?: Record<string, number>;
  /** relations capability — present only when its gate passed */
  relations?: RelationEmbeddings;
}

export interface ArchetypeMatch {
  archetype: MetaArchetype;
  /** cosine similarity between the deck vector and the centroid, 0-1 */
  similarity: number;
}

export interface MetaViability {
  /** deterministic fingerprint score (documented axis weights) */
  simStrength: number;
  /** archetype-anchored adjustment: (observed win rate − 50%) × 2 × similarity × 50 */
  metaAlignment: number;
  /** simStrength + metaAlignment, clamped to 0-100 */
  total: number;
  match: ArchetypeMatch | null;
}

export const SIM_STRENGTH_FORMULA =
  '30% Tempo + 25% Consistency + 20% Resilience + 15% Interaction + 10% Reach';

/** validate + parse a fetched artifact; null means "meta unavailable" */
export function parseMetaModel(json: unknown): MetaModel | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Record<string, unknown>;
  if (typeof m.version !== 'string' || m.version.length === 0) return null;
  if (typeof m.dataThroughDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.dataThroughDate)) return null;
  const caps = m.capabilities as Record<string, unknown> | undefined;
  if (!caps || typeof caps.relations !== 'boolean' || typeof caps.calibration !== 'boolean') return null;
  if (!caps.relations && !caps.calibration) return null;
  const model: MetaModel = {
    version: m.version,
    dataThroughDate: m.dataThroughDate,
    capabilities: { relations: caps.relations, calibration: caps.calibration },
  };
  if (typeof m.cardSchemaVersion === 'number') model.cardSchemaVersion = m.cardSchemaVersion;
  if (caps.relations) {
    const rel = m.relations as RelationEmbeddings | undefined;
    if (
      !rel ||
      typeof rel.dim !== 'number' ||
      rel.dim <= 0 ||
      !rel.vectors ||
      typeof rel.vectors !== 'object' ||
      Object.keys(rel.vectors).length === 0
    ) {
      return null;
    }
    model.relations = rel;
  }
  if (caps.calibration) {
    const archetypes = m.archetypes as MetaArchetype[] | undefined;
    if (!Array.isArray(archetypes) || archetypes.length === 0) return null;
    if (!m.cardWeights || typeof m.cardWeights !== 'object') return null;
    model.archetypes = archetypes;
    model.cardWeights = m.cardWeights as Record<string, number>;
  }
  return model;
}

export async function loadMetaModel(base = `${import.meta.env.BASE_URL ?? '/'}`): Promise<MetaModel | null> {
  try {
    // revalidate against the ETag: Pages serves max-age=600, and a stale
    // artifact would otherwise survive deploys for up to 10 minutes
    const res = await fetch(`${base}data/meta-model.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    return parseMetaModel(await res.json());
  } catch {
    return null;
  }
}

/** YYYY-MM-DD of the card snapshot, for staleness comparison */
export const snapshotDate = (generatedOn: string): string => generatedOn.slice(0, 10);

/** the model is stale when its tournament data predates the card snapshot */
export function isStale(model: MetaModel, snapshotGeneratedOn: string): boolean {
  return model.dataThroughDate < snapshotDate(snapshotGeneratedOn);
}

// ---------------------------------------------------------------------------
// Canonical identity — shared implementation with the trainer (D1)
// ---------------------------------------------------------------------------

const aliasCache = new WeakMap<object, Map<number, number>>();

/** print id → canonical id, memoized per card list (one identity per card) */
function canonicalAliasFor(cards: Card[]): Map<number, number> {
  let alias = aliasCache.get(cards);
  if (!alias) {
    alias = buildCanonicalRegistry(cards).alias;
    aliasCache.set(cards, alias);
  }
  return alias;
}

const byIdCache = new WeakMap<Card[], Map<number, Card>>();

function byIdFor(cards: Card[]): Map<number, Card> {
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

const decodeCache = new WeakMap<RelationEmbeddings, Map<number, Float64Array>>();

/** decoded relation vectors (canonical card id → vector), memoized per artifact */
export function relationVectors(model: MetaModel): Map<number, Float64Array> {
  const decoded = new Map<number, Float64Array>();
  if (!model.relations || !model.capabilities.relations) return decoded;
  let cache = decodeCache.get(model.relations);
  if (cache) return cache;
  const { dim, vectors } = model.relations;
  for (const [id, { b64, scale }] of Object.entries(vectors)) {
    const bin = atob(b64);
    if (bin.length < dim * 2) continue;
    const v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) {
      // sign-extended little-endian Int16 × scale
      v[d] = (((bin.charCodeAt(2 * d) | (bin.charCodeAt(2 * d + 1) << 8)) << 16) >> 16) * scale;
    }
    decoded.set(Number(id), v);
  }
  decodeCache.set(model.relations, decoded);
  return decoded;
}

const cosineVec = (a: Float64Array, b: Float64Array): number => {
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
  perCard: (card: Card) => Float64Array | null
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
    dim: kw.length + tg.length + cl.length + fr.length + ty.length + 4 + INKS.length + 3,
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

const costBand = (cost: number): number => (cost <= 2 ? 0 : cost <= 4 ? 1 : cost <= 6 ? 2 : 3);

/** all *Shift variants (Floodborn, Madrigal, Temporary, …) share one dimension */
const keywordFeature = (keyword: string): string =>
  keyword === 'Shift' || keyword.endsWith(' Shift') ? 'Shift' : keyword;

export function cardTextVector(card: Card, vocab: TextFeatureVocab): Float64Array {
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
  vocab: TextFeatureVocab = textFeatureVocab([...byId.values()])
): Float64Array | null {
  return deckVectorFrom(deck, byId, (card) => cardTextVector(canonical(card), vocab));
}

/**
 * count-weighted, L2-normalized relation vector of the deck; canonical-id
 * resolved (embeddings key on the newest print of a group), null when no
 * member has one
 */
function deckRelationVector(
  deck: DeckState,
  byId: Map<number, Card>,
  vectors: Map<number, Float64Array>,
  alias: Map<number, number>
): Float64Array | null {
  if (vectors.size === 0) return null;
  return deckVectorFrom(deck, byId, (card) => vectors.get(alias.get(card.id) ?? card.id) ?? null);
}
// ---------------------------------------------------------------------------
// Archetype matching (calibration capability)
// ---------------------------------------------------------------------------

/** normalized deck vector (canonical card id → share of the deck) for similarity math */
const deckVector = (deck: DeckState, byId: Map<number, Card>, cards: Card[]): Map<string, number> => {
  const alias = canonicalAliasFor(cards);
  const total = Object.values(deck.cards).reduce((s, c) => s + c, 0) || 1;
  const vec = new Map<string, number>();
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card) continue;
    const canonical = alias.get(card.id) ?? card.id;
    const key = String(canonical);
    vec.set(key, (vec.get(key) ?? 0) + count / total);
  }
  return vec;
};

const cosine = (a: Map<string, number>, b: Record<string, number>): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b[k];
    if (w !== undefined) dot += v * w;
  }
  for (const w of Object.values(b)) nb += w * w;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

export function identifyArchetype(
  deck: DeckState,
  byId: Map<number, Card>,
  model: MetaModel,
  cards?: Card[]
): ArchetypeMatch | null {
  const archetypes = model.archetypes ?? [];
  if (archetypes.length === 0) return null;
  const vec = deckVector(deck, byId, cards ?? [...byId.values()]);
  let best: ArchetypeMatch | null = null;
  for (const archetype of archetypes) {
    const similarity = cosine(vec, archetype.centroid);
    if (!best || similarity > best.similarity) best = { archetype, similarity };
  }
  return best;
}

/**
 * Viability score with a visible decomposition: the deterministic fingerprint
 * score, adjusted by how closely the deck matches an archetype with a known
 * observed win rate (requires the calibration capability — zero when absent).
 */
export function metaAdjustedViability(
  fingerprint: Fingerprint,
  deck: DeckState,
  byId: Map<number, Card>,
  model: MetaModel,
  cards?: Card[]
): MetaViability {
  const { Tempo, Consistency, Resilience, Interaction, Reach } = fingerprint.axes;
  const simStrength = Math.round(
    (0.3 * Tempo + 0.25 * Consistency + 0.2 * Resilience + 0.15 * Interaction + 0.1 * Reach) * 10
  ) / 10;
  const match = identifyArchetype(deck, byId, model, cards);
  const metaAlignment = match
    ? Math.round((match.archetype.observedWinRate - 0.5) * 2 * match.similarity * 50 * 10) / 10
    : 0;
  const total = Math.max(0, Math.min(100, simStrength + metaAlignment));
  return { simStrength, metaAlignment, total, match };
}

// ---------------------------------------------------------------------------
// Suggestions (D5)
// ---------------------------------------------------------------------------

export const BASIS_RELATION = 'appears alongside in tournament decks';
export const BASIS_TEXT = 'plays similarly';
export const BASIS_FUSED = `${BASIS_RELATION} + ${BASIS_TEXT}`;
/** fused score = 0.6 × relation similarity + 0.4 × text similarity (D5) */
export const FUSION_WEIGHTS = { relation: 0.6, text: 0.4 } as const;
export const SUGGESTION_LIMIT = 8;

export interface CardSuggestion {
  card: Card;
  /** fused (or text-only) similarity, 0-1 */
  score: number;
  /** relation-embedding similarity; null when the relation space does not cover the candidate */
  relationSim: number | null;
  textSim: number;
  /** affinity basis label — what the similarity claim is based on */
  basis: string;
}

export interface SuggestOptions {
  limit?: number;
}

/**
 * "What should I add?" — ranked candidate cards for this deck.
 *
 * Scoring: fused similarity over the relation space (tournament co-occurrence,
 * artifact-borne) and the text space (card content, client-derived), weights
 * documented in FUSION_WEIGHTS. Candidates missing from one space are ranked
 * by the other alone; the basis label states which spaces produced the score.
 * No relation embeddings → text-only ranking.
 *
 * Filters (before ranking): format legality, declared inks, group copy limit,
 * and cards already in the deck — by group identity, so a different print of
 * the same name counts as owned. Candidates are canonicalized to one identity
 * per card (the newest print per full name).
 */
export function suggestCards(
  deck: DeckState,
  cards: Card[],
  model: MetaModel,
  opts: SuggestOptions = {}
): CardSuggestion[] {
  const limit = opts.limit ?? SUGGESTION_LIMIT;
  const byId = byIdFor(cards);
  const registry = buildCanonicalRegistry(cards);
  const { alias, canonicalByGroup } = registry;
  const canonicalOf = (card: Card): Card => canonicalByGroup.get(card.groupKey) ?? card;
  const vocab = textFeatureVocab(cards);
  const deckText = deckTextVector(deck, byId, canonicalOf, vocab);
  if (!deckText) return [];

  const relations = relationVectors(model);
  const deckRelation = deckRelationVector(deck, byId, relations, alias);

  // group copy counts in the deck (by group identity, across prints)
  const groupCounts = new Map<string, number>();
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (card) groupCounts.set(card.groupKey, (groupCounts.get(card.groupKey) ?? 0) + count);
  }

  const suggestions: CardSuggestion[] = [];
  for (const candidate of canonicalByGroup.values()) {
    if (groupCounts.has(candidate.groupKey)) continue; // owned (any print of the name)
    if (candidate.formats[deck.format] !== true) continue;
    if (!inkLegal(candidate, deck.inks)) continue;
    const maxCopies = candidate.maxCopies;
    if (maxCopies !== 'unlimited' && (groupCounts.get(candidate.groupKey) ?? 0) >= maxCopies) continue;

    const textSim = cosineVec(cardTextVector(candidate, vocab), deckText);
    let relationSim: number | null = null;
    if (deckRelation) {
      const candidateRelation = relations.get(candidate.id);
      if (candidateRelation) relationSim = cosineVec(candidateRelation, deckRelation);
    }
    const score =
      relationSim !== null ? FUSION_WEIGHTS.relation * relationSim + FUSION_WEIGHTS.text * textSim : textSim;
    suggestions.push({
      card: candidate,
      score: Math.round(score * 10000) / 10000,
      relationSim: relationSim !== null ? Math.round(relationSim * 10000) / 10000 : null,
      textSim: Math.round(textSim * 10000) / 10000,
      basis: relationSim !== null ? BASIS_FUSED : BASIS_TEXT,
    });
  }

  return suggestions
    .sort((a, b) => b.score - a.score || b.textSim - a.textSim || a.card.fullName.localeCompare(b.card.fullName) || a.card.id - b.card.id)
    .slice(0, limit);
}
