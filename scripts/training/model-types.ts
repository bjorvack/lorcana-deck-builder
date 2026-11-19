/**
 * Shared training data shapes (rows, gate outputs, artifact-facing types).
 */
export interface TrainRow {
  source: string;
  eventId: string;
  date: string;
  /** normalized card counts (sums to ~1) */
  vec: Map<number, number>;
  /** raw copy counts per card, for relation-training token expansion */
  counts: Map<number, number>;
  /** match win rate 0-1 */
  winRate: number;
  /** made the top cut */
  topCut: boolean;
  playerCount: number;
  /** final standing in the event (1-based); null when unknown */
  standing: number | null;
}

export interface Archetype {
  id: number;
  name: string;
  observedWinRate: number;
  sampleSize: number;
  centroid: Record<string, number>;
}

/** relation embeddings as shipped in the artifact (Int16 + per-vector scale, base64, little-endian) */
export interface RelationEmbeddings {
  dim: number;
  quantization: 'int16-le';
  /** canonical card id → quantized vector */
  vectors: Record<string, { b64: string; scale: number }>;
}

export interface RelationGateMetrics {
  metric: 'holdout_coherence_ratio';
  /** mean pairwise cosine among a holdout deck's own cards */
  value: number;
  /** mean pairwise cosine among random card pairs */
  random: number;
  threshold: number;
  passed: boolean;
  holdoutDecks: number;
  /** cards with relation vectors */
  vocab: number;
  pairs: number;
}

export interface CalibrationGateMetrics {
  metric: 'holdout_winrate_mae';
  value: number;
  baseline: number;
  passed: boolean;
  holdoutDecks: number;
}

export const round4 = (x: number): number => Math.round(x * 10000) / 10000;

export interface CalibrationOutput {
  passed: boolean;
  archetypes: Archetype[];
  cardWeights: Record<string, number>;
  metrics: CalibrationGateMetrics;
}

export interface RelationsOutput {
  passed: boolean;
  vectors: Map<number, Float64Array>;
  metrics: RelationGateMetrics;
}

/** per-card popularity over the training corpus (version '3') */
