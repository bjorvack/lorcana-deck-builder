import { buildCanonicalRegistry } from '../../scripts/training/canonical';
import type { Card, DeckState } from '../data/types';
import type { Fingerprint } from '../stats/fingerprint';
import {
  buildScoringContext,
  candidateComponents,
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
  capabilities: { relations: boolean; calibration: boolean };
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
  if (!caps.relations && !caps.calibration) return null;
  const model: MetaModel = {
    version: m.version,
    dataThroughDate: m.dataThroughDate,
    capabilities: { relations: caps.relations, calibration: caps.calibration },
  };
  if (typeof m.cardSchemaVersion === 'number')
    model.cardSchemaVersion = m.cardSchemaVersion;
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
  return model;
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

/** print id → canonical id, memoized per card list (one identity per card) */
const aliasCache = new WeakMap<object, Map<number, number>>();
function canonicalAliasFor(cards: Card[]): Map<number, number> {
  let alias = aliasCache.get(cards);
  if (!alias) {
    alias = buildCanonicalRegistry(cards).alias;
    aliasCache.set(cards, alias);
  }
  return alias;
}

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
  cards?: Card[],
): MetaViability {
  const { Tempo, Consistency, Resilience, Interaction, Reach } =
    fingerprint.axes;
  const simStrength =
    Math.round(
      (0.3 * Tempo +
        0.25 * Consistency +
        0.2 * Resilience +
        0.15 * Interaction +
        0.1 * Reach) *
        10,
    ) / 10;
  const match = identifyArchetype(deck, byId, model, cards);
  const metaAlignment = match
    ? Math.round(
        (match.archetype.observedWinRate - 0.5) *
          2 *
          match.similarity *
          50 *
          10,
      ) / 10
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
