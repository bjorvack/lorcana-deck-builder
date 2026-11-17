import type { Card, DeckState } from '../data/types';
import type { Fingerprint } from '../stats/fingerprint';

/**
 * Client-side meta inference. The model artifact is produced offline by the
 * training pipeline (scripts/training/) and shipped as a static same-origin
 * file — the running app never calls an external service. A missing artifact
 * means "meta unavailable"; the deterministic fingerprint works regardless.
 */

export interface MetaArchetype {
  id: number;
  name: string;
  /** observed win rate of the archetype in the training window, 0-1 */
  observedWinRate: number;
  /** number of tournament decks behind the win rate */
  sampleSize: number;
  /** mean normalized card-count vector (card id → share of the 60) */
  centroid: Record<string, number>;
}

export interface MetaModel {
  version: string;
  /** YYYY-MM-DD — newest tournament data included in training */
  dataThroughDate: string;
  cardSchemaVersion?: number;
  archetypes: MetaArchetype[];
  /** per-card meta weight from the regularized regression (reserved for the calibrator) */
  cardWeights: Record<string, number>;
  backtest?: { metric: string; value: number; baseline: number };
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

export async function loadMetaModel(base = `${import.meta.env.BASE_URL ?? '/'}`): Promise<MetaModel | null> {
  try {
    const res = await fetch(`${base}data/model.json`);
    if (!res.ok) return null;
    const model = (await res.json()) as MetaModel;
    if (!model || !Array.isArray(model.archetypes) || typeof model.dataThroughDate !== 'string') return null;
    return model;
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

/** normalized deck vector (card id → share of the deck) for similarity math */
const deckVector = (deck: DeckState, byId: Map<number, Card>): Map<string, number> => {
  const total = Object.values(deck.cards).reduce((s, c) => s + c, 0) || 1;
  const vec = new Map<string, number>();
  for (const [id, count] of Object.entries(deck.cards)) {
    if (!byId.has(Number(id))) continue;
    vec.set(id, (vec.get(id) ?? 0) + count / total);
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

export function identifyArchetype(deck: DeckState, byId: Map<number, Card>, model: MetaModel): ArchetypeMatch | null {
  if (model.archetypes.length === 0) return null;
  const vec = deckVector(deck, byId);
  let best: ArchetypeMatch | null = null;
  for (const archetype of model.archetypes) {
    const similarity = cosine(vec, archetype.centroid);
    if (!best || similarity > best.similarity) best = { archetype, similarity };
  }
  return best;
}

/**
 * Viability score with a visible decomposition: the deterministic fingerprint
 * score, adjusted by how closely the deck matches an archetype with a known
 * observed win rate. The trained calibrator (phase 4.3) will replace the
 * archetype-anchored adjustment; the decomposition stays.
 */
export function metaAdjustedViability(
  fingerprint: Fingerprint,
  deck: DeckState,
  byId: Map<number, Card>,
  model: MetaModel
): MetaViability {
  const { Tempo, Consistency, Resilience, Interaction, Reach } = fingerprint.axes;
  const simStrength = Math.round(
    (0.3 * Tempo + 0.25 * Consistency + 0.2 * Resilience + 0.15 * Interaction + 0.1 * Reach) * 10
  ) / 10;
  const match = identifyArchetype(deck, byId, model);
  const metaAlignment = match
    ? Math.round((match.archetype.observedWinRate - 0.5) * 2 * match.similarity * 50 * 10) / 10
    : 0;
  const total = Math.max(0, Math.min(100, simStrength + metaAlignment));
  return { simStrength, metaAlignment, total, match };
}
