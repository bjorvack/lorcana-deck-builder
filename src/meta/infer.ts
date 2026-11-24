import type { Card, DeckState } from '../data/types';
import {
  buildScoringContext,
  candidateComponents,
  canonicalAliasFor,
  deckVectors,
  FUSION_WEIGHTS,
  groupCountsOf,
  legalCandidate,
  type RelationEmbeddings,
  type ScoringContext,
} from './score';

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

export { type RelationEmbeddings, relationVectors } from './score';

export interface MetaModel {
  version: string;
  /** YYYY-MM-DD — newest tournament data included in training */
  dataThroughDate: string;
  cardSchemaVersion?: number;
  capabilities: {
    relations: boolean;
    calibration: boolean;
    /** undefined in pre-interactions artifacts; consumers treat it as false */
    interactions?: boolean;
  };
  gates?: {
    relations?: {
      metric: string;
      value: number;
      threshold: number;
      passed: boolean;
    };
    calibration?: {
      metric: string;
      value: number;
      baseline: number;
      passed: boolean;
    };
  };
  /** calibration capability — present only when its gate passed */
  archetypes?: MetaArchetype[];
  cardWeights?: Record<string, number>;
  /** relations capability — present only when its gate passed */
  relations?: RelationEmbeddings;
  /** interactions capability — per-card synergy partners, present only when its gate passed */
  interactions?: InteractionPartners;
  /** version '3' — share of training decks containing the card, byte-quantized; absent in '2' */
  playrate?: Record<string, number>;
  /** version '3' — typical copy count when played, 1–4; absent in '2' */
  typicalCopies?: Record<string, number>;
  /** training lists per dataset source (topdeck, lorcanahunter, dotgg, …) */
  sources?: Record<string, number>;
}

export interface ArchetypeMatch {
  archetype: MetaArchetype;
  /** cosine similarity between the deck vector and the centroid, 0-1 */
  similarity: number;
}

/**
 * Validate + parse a fetched artifact; null means "meta unavailable".
 * Versions '2' and '3' are accepted (D6): a '2' artifact simply lacks the
 * playrate/typical-copies maps, and every consumer degrades to neutral
 * weighting — no migration step.
 */
export function parseMetaModel(json: unknown): MetaModel | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Record<string, unknown>;
  if (typeof m.version !== 'string' || m.version.length === 0) return null;
  if (
    typeof m.dataThroughDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(m.dataThroughDate)
  )
    return null;
  const caps = m.capabilities as Record<string, unknown> | undefined;
  if (
    !caps ||
    typeof caps.relations !== 'boolean' ||
    typeof caps.calibration !== 'boolean'
  )
    return null;
  if (!caps.relations && !caps.calibration && caps.interactions !== true)
    return null;
  const model: MetaModel = {
    version: m.version,
    dataThroughDate: m.dataThroughDate,
    capabilities: {
      relations: caps.relations,
      calibration: caps.calibration,
      interactions: caps.interactions === true,
    },
  };
  if (typeof m.cardSchemaVersion === 'number')
    model.cardSchemaVersion = m.cardSchemaVersion;
  if (caps.relations) {
    const rel = m.relations as RelationEmbeddings | undefined;
    if (
      rel &&
      typeof rel.dim === 'number' &&
      rel.dim > 0 &&
      rel.vectors &&
      typeof rel.vectors === 'object' &&
      Object.keys(rel.vectors).length > 0
    ) {
      model.relations = rel;
    } else {
      // a corrupt relations payload must not sink a valid calibration capability
      model.capabilities.relations = false;
    }
  }
  if (caps.calibration) {
    const archetypes = m.archetypes as MetaArchetype[] | undefined;
    if (
      Array.isArray(archetypes) &&
      archetypes.length > 0 &&
      m.cardWeights &&
      typeof m.cardWeights === 'object'
    ) {
      model.archetypes = archetypes;
      model.cardWeights = m.cardWeights as Record<string, number>;
    } else {
      model.capabilities.calibration = false;
    }
  }
  if (m.playrate !== undefined) {
    if (typeof m.playrate !== 'object' || m.playrate === null) return null;
    model.playrate = m.playrate as Record<string, number>;
  }
  if (m.typicalCopies !== undefined) {
    if (typeof m.typicalCopies !== 'object' || m.typicalCopies === null)
      return null;
    model.typicalCopies = m.typicalCopies as Record<string, number>;
  }
  if (m.sources && typeof m.sources === 'object')
    model.sources = m.sources as Record<string, number>;
  if (caps.interactions === true) {
    const parsed = parseInteractionPartners(m.interactions);
    if (parsed) model.interactions = parsed;
    else model.capabilities.interactions = false;
  }
  // only a fully unusable artifact is rejected: a corrupt capability payload
  // degrades just that capability, it never sinks the other one
  if (
    !model.capabilities.relations &&
    !model.capabilities.calibration &&
    !model.capabilities.interactions
  )
    return null;
  return model;
}

/** decoded per-card synergy partner table (training: synergy-capability.ts) */
export interface InteractionPartners {
  version: '1';
  /** score = round((lift − 1) · scale) at emit time; synergy = score / scale + 1 */
  scale: number;
  /** canonical card id → top partners [partnerId, int8 score 0-255] */
  partners: Record<string, Array<[number, number]>>;
}

function parseInteractionPartners(json: unknown): InteractionPartners | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (j.version !== '1') return null;
  if (typeof j.scale !== 'number' || !Number.isFinite(j.scale) || j.scale <= 0)
    return null;
  if (!j.partners || typeof j.partners !== 'object') return null;
  const partners: Record<string, Array<[number, number]>> = {};
  for (const [id, list] of Object.entries(
    j.partners as Record<string, unknown>,
  )) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const decoded: Array<[number, number]> = [];
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [partner, score] = entry as unknown[];
      if (
        !Number.isInteger(partner) ||
        (partner as number) <= 0 ||
        !Number.isInteger(score) ||
        (score as number) < 0 ||
        (score as number) > 255
      )
        return null;
      decoded.push([partner as number, score as number]);
    }
    partners[id] = decoded;
  }
  return { version: '1', scale: j.scale, partners };
}

export async function loadMetaModel(
  base = `${import.meta.env.BASE_URL ?? '/'}`,
): Promise<MetaModel | null> {
  try {
    // revalidate against the ETag: Pages serves max-age=600, and a stale
    // artifact would otherwise survive deploys for up to 10 minutes
    const res = await fetch(`${base}data/meta-model.json`, {
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    return parseMetaModel(await res.json());
  } catch {
    return null;
  }
}

/** YYYY-MM-DD of the card snapshot, for staleness comparison */
export const snapshotDate = (generatedOn: string): string =>
  generatedOn.slice(0, 10);

/** the model is stale when its tournament data predates the card snapshot */
export function isStale(
  model: MetaModel,
  snapshotGeneratedOn: string,
): boolean {
  return model.dataThroughDate < snapshotDate(snapshotGeneratedOn);
}

// ---------------------------------------------------------------------------
// Archetype matching (calibration capability)
// ---------------------------------------------------------------------------

/** normalized deck vector (canonical card id → share of the deck) for similarity math */
const deckVector = (
  deck: DeckState,
  byId: Map<number, Card>,
  cards: Card[],
): Map<string, number> => {
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
  cards?: Card[],
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

// ---------------------------------------------------------------------------
// Suggestions (D5)
// ---------------------------------------------------------------------------

export const BASIS_RELATION = 'appears alongside in tournament decks';
export const BASIS_TEXT = 'plays similarly';
export const BASIS_FUSED = `${BASIS_RELATION} + ${BASIS_TEXT}`;
export { FUSION_WEIGHTS };
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
 * Scoring runs through the shared scoring module (src/meta/score.ts, D1): the
 * same fused similarity, canonicalization, legality filters and popularity
 * data the generator consumes per iteration. Candidates missing from one
 * space are ranked by the other alone; the basis label states which spaces
 * produced the score. No relation embeddings → text-only ranking.
 */
export function suggestCards(
  deck: DeckState,
  cards: Card[],
  model: MetaModel,
  opts: SuggestOptions = {},
): CardSuggestion[] {
  const limit = opts.limit ?? SUGGESTION_LIMIT;
  const ctx: ScoringContext = buildScoringContext(cards, model);
  const vectors = deckVectors(deck, ctx);
  if (!vectors.text) return [];

  const groupCounts = groupCountsOf(deck, ctx.byId);

  const suggestions: CardSuggestion[] = [];
  for (const candidate of ctx.canonicalByGroup.values()) {
    if (!legalCandidate(deck, groupCounts, candidate)) continue;
    const { relationSim, textSim, score } = candidateComponents(
      candidate,
      ctx,
      vectors,
    );
    suggestions.push({
      card: candidate,
      score: Math.round(score * 10000) / 10000,
      relationSim:
        relationSim !== null ? Math.round(relationSim * 10000) / 10000 : null,
      textSim: Math.round(textSim * 10000) / 10000,
      basis: relationSim !== null ? BASIS_FUSED : BASIS_TEXT,
    });
  }

  return suggestions
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.textSim - a.textSim ||
        a.card.fullName.localeCompare(b.card.fullName) ||
        a.card.id - b.card.id,
    )
    .slice(0, limit);
}

// text-space primitives stay exported for the tests and future consumers (D1)
export {
  buildTextFeatureVocab,
  cardTextVector,
  deckTextVector,
  type TextFeatureVocab,
  textFeatureVocab,
} from './score';
