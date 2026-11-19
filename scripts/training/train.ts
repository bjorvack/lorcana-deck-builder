import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCanonicalRegistry } from './canonical';
import { extractNameReferences, referenceDecks } from '../../src/text/refs';
import type { Card } from '../../src/data/types';

/**
 * Offline meta-model training. Source-agnostic: consumes every
 * scripts/training/data/*.json dataset (the normalized adapter schema shared
 * by the TopDeck and Lorcanahunter fetchers), trains on the merged corpus and
 * writes scripts/training/output/meta-model.json for the pipeline to emit —
 * gated per capability (design D6):
 *
 * - calibration (archetype centroids + card weights): k-means (k=32, seeded)
 *   over normalized deck vectors from a rolling 90-day window (the meta
 *   drifts — old events don't anchor current win rates; falls back to the
 *   full training split while the window holds fewer than 100 lists); each
 *   archetype's win rate is a shrinkage estimate (cluster mean pulled toward
 *   the window mean by sample size, K=25 — finer clusters need variance
 *   control). Gate: holdout win-rate MAE must beat the global-mean baseline
 *   by 2%.
 * - relations (SGNS relation embeddings, D3): skip-gram with negative
 *   sampling over canonicalized decks (deck = document, card = token, dim 32,
 *   seeded → deterministic) over the FULL accumulated corpus — co-occurrence
 *   accumulates, win rates decay. Gate: on holdout events, a deck's own cards
 *   must average higher embedding similarity than random card pairs (≥ 1.1×).
 *
 * Version '3' additionally carries per-card popularity maps over the training
 * split (playrate, typical copies when played) for the generator's novelty
 * weighting and copy policy.
 *
 * Publication happens when either gate passes; failing parts are omitted from
 * the artifact. Both capabilities fail → nothing is published — the app stays
 * deterministic-only.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = path.join(ROOT, 'scripts', 'training', 'data');
const OUT_DIR = path.join(ROOT, 'scripts', 'training', 'output');

export interface DatasetEntry {
  player: string | null;
  standing: number | null;
  winRate: number | null;
  cards: { cardId: number; count: number }[];
  unmatched: string[];
}

export interface Dataset {
  source: string;
  fetchedOn: string;
  tournaments: {
    eventId: string;
    name: string;
    date: string;
    playerCount: number;
    topCut: number;
    entries: DatasetEntry[];
  }[];
}

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

export interface TrainedModel {
  version: '3';
  dataThroughDate: string;
  cardSchemaVersion: number;
  capabilities: { relations: boolean; calibration: boolean };
  gates: {
    relations: RelationGateMetrics;
    calibration: CalibrationGateMetrics;
  };
  /** calibration capability — omitted when its gate fails */
  archetypes?: Archetype[];
  cardWeights?: Record<string, number>;
  /** relations capability — omitted when its gate fails */
  relations?: RelationEmbeddings;
  /** version '3' — share of training decks containing the card, byte-quantized 0–255 (canonical card id keys) */
  playrate?: Record<string, number>;
  /** version '3' — typical copy count when played, 1–4 (canonical card id keys) */
  typicalCopies?: Record<string, number>;
  sources: Record<string, number>;
}

const MIN_MAPPED_CARDS = 55;
/** calibration archetype count — the corpus grew 10×; finer clusters, variance-controlled by shrinkage */
const K = 32;
/** James-Stein-style shrinkage of cluster win-rate means toward the window mean */
const SHRINKAGE_K = 25;
/** rolling calibration window (days) — win-rate anchoring decays with meta drift */
const CALIBRATION_WINDOW_DAYS = 90;
/** below this many in-window lists the window is too thin — fall back to the full split */
const MIN_CALIBRATION_ROWS = 100;
const KMEANS_ITERS = 30;
const HOLDOUT_EVENT_SHARE = 0.25;
/** holdout era cap — events older than this always train, so a deep-history
 *  source can never push the holdout (and the calibration anchor) into stale metas */
export const HOLDOUT_MAX_AGE_DAYS = 365;
const LOGISTIC_ITERS = 400;
const LOGISTIC_LR = 0.2;
const LOGISTIC_L2 = 4;

/** SGNS hyperparameters (design D3); lr follows word2vec practice for small corpora */
const SGNS_DIM = 32;
const SGNS_EPOCHS = 10;
const SGNS_NEGATIVES = 5;
const SGNS_LR = 0.05;
const SGNS_SEED = 42;
/** relation coherence gate: own-card similarity must reach 1.1× random-pair similarity */
const COHERENCE_THRESHOLD = 1.1;
const COHERENCE_RANDOM_PAIRS = 20000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** percentile-bucket mean win rates of the recorded rows — the imputation curve */
const winRateCurve = (rows: TrainRow[]): Map<number, number> => {
  const buckets = new Map<number, number[]>();
  for (const r of rows) {
    if (r.standing === null) continue;
    const pct = Math.min(0.999, Math.max(0, (r.standing - 0.5) / Math.max(1, r.playerCount)));
    const b = Math.floor(pct * 10);
    const list = buckets.get(b) ?? [];
    list.push(r.winRate);
    buckets.set(b, list);
  }
  const curve = new Map<number, number>();
  for (const [b, list] of buckets) curve.set(b, list.reduce((s, x) => s + x, 0) / list.length);
  return curve;
};

const meanWinRate = (rows: TrainRow[]): number =>
  rows.length > 0 ? rows.reduce((s, r) => s + r.winRate, 0) / rows.length : 0;

/** load every dataset and flatten to training rows, dropping poorly-mapped lists.
 *  With `imputeWinRate` (default in train()), recordless-but-placed lists
 *  inherit the corpus's place-percentile mean win rate (deterministic; keeps
 *  the placement signal a flat average would erase) instead of being dropped —
 *  the values never reach calibration (90-day window) but let every mapped
 *  list train relations. */
export function buildRows(
  datasets: Dataset[],
  opts: { imputeWinRate?: boolean } = {}
): { rows: TrainRow[]; dropped: number; imputed: number } {
  const rows: TrainRow[] = [];
  const recordless: { row: TrainRow; standing: number }[] = [];
  let dropped = 0;
  for (const ds of datasets) {
    for (const t of ds.tournaments) {
      const seenPlayers = new Set<string>();
      for (const e of t.entries) {
        const mapped = e.cards.reduce((s, c) => s + c.count, 0);
        if (mapped < MIN_MAPPED_CARDS || mapped > 62 || (e.winRate !== null && (e.winRate < 0 || e.winRate > 1))) {
          dropped++;
          continue;
        }
        const playerKey = `${t.eventId}:${e.player ?? rows.length}`;
        if (seenPlayers.has(playerKey)) {
          dropped++;
          continue;
        }
        seenPlayers.add(playerKey);
        const total = e.cards.reduce((s, c) => s + c.count, 0);
        const vec = new Map<number, number>();
        const counts = new Map<number, number>();
        for (const c of e.cards) {
          vec.set(c.cardId, (vec.get(c.cardId) ?? 0) + c.count / total);
          counts.set(c.cardId, (counts.get(c.cardId) ?? 0) + c.count);
        }
        const row: TrainRow = {
          source: ds.source,
          eventId: t.eventId,
          date: t.date,
          vec,
          counts,
          winRate: e.winRate ?? 0,
          topCut: e.standing !== null && t.topCut > 0 && e.standing <= t.topCut,
          playerCount: t.playerCount,
          standing: e.standing,
        };
        if (e.winRate !== null) rows.push(row);
        else if (opts.imputeWinRate && e.standing !== null) recordless.push({ row, standing: e.standing });
        else dropped++;
      }
    }
  }
  let imputed = 0;
  if (recordless.length > 0 && rows.length > 0) {
    const curve = winRateCurve(rows);
    const fallback = meanWinRate(rows);
    for (const { row, standing } of recordless) {
      const pct = Math.min(0.999, Math.max(0, (standing - 0.5) / Math.max(1, row.playerCount)));
      const wr = curve.get(Math.floor(pct * 10)) ?? fallback;
      rows.push({ ...row, winRate: Math.round(wr * 1000) / 1000 });
      imputed++;
    }
  }
  return { rows, dropped, imputed };
}

/**
 * Canonicalize rows through the registry (D1): dataset card ids are print ids
 * from fetch-time snapshots; every print aliases to its group's newest print.
 * Unknown prints (missing from the current snapshot) are dropped; rows that
 * fall below the mapping floor are dropped entirely.
 */
export function canonicalizeRows(rows: TrainRow[], alias: Map<number, number>): { rows: TrainRow[]; dropped: number } {
  const out: TrainRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    const counts = new Map<number, number>();
    let total = 0;
    for (const [printId, count] of row.counts) {
      const canonical = alias.get(printId);
      if (canonical === undefined) continue;
      counts.set(canonical, (counts.get(canonical) ?? 0) + count);
      total += count;
    }
    if (total < MIN_MAPPED_CARDS) {
      dropped++;
      continue;
    }
    const vec = new Map<number, number>();
    for (const [id, count] of counts) vec.set(id, count / total);
    out.push({ ...row, vec, counts });
  }
  return { rows: out, dropped };
}

/** seeded k-means over the sparse deck vectors */
export function kmeans(vectors: Map<number, number>[], k: number, seed = 42): number[] {
  const rng = mulberry32(seed);
  // k-means++ style init: first center at random, then farthest-point sampling
  const centers: Map<number, number>[] = [vectors[Math.floor(rng() * vectors.length)]!];
  while (centers.length < k) {
    let bestVec = vectors[0]!;
    let bestDist = -1;
    for (const v of vectors) {
      const d = Math.min(...centers.map((c) => sqDist(v, c)));
      if (d > bestDist) {
        bestDist = d;
        bestVec = v;
      }
    }
    centers.push(bestVec);
  }
  let assign = new Array<number>(vectors.length).fill(0);
  for (let iter = 0; iter < KMEANS_ITERS; iter++) {
    assign = vectors.map((v) => {
      let best = 0;
      let bestDist = Infinity;
      for (let ci = 0; ci < centers.length; ci++) {
        const d = sqDist(v, centers[ci]!);
        if (d < bestDist) {
          bestDist = d;
          best = ci;
        }
      }
      return best;
    });
    for (let ci = 0; ci < centers.length; ci++) {
      const members = vectors.filter((_, i) => assign[i] === ci);
      if (members.length === 0) continue;
      const mean = new Map<number, number>();
      for (const m of members) for (const [d, v] of m) mean.set(d, (mean.get(d) ?? 0) + v / members.length);
      centers[ci] = mean;
    }
  }
  return assign;
}

export const sqDist = (a: Map<number, number>, b: Map<number, number>): number => {
  let d = 0;
  for (const [k, v] of a) d += (v - (b.get(k) ?? 0)) ** 2;
  for (const [k, v] of b) if (!a.has(k)) d += v * v;
  return d;
};

/** L2-regularized logistic regression on sparse card-count features */
export function logisticRegression(
  rows: { vec: Map<number, number>; y: number }[],
  iters = LOGISTIC_ITERS,
  lr = LOGISTIC_LR,
  l2 = LOGISTIC_L2
): Map<number, number> {
  const w = new Map<number, number>();
  let b = 0;
  for (let iter = 0; iter < iters; iter++) {
    const grad = new Map<number, number>();
    let gb = 0;
    for (const { vec, y } of rows) {
      let z = b;
      for (const [d, v] of vec) z += (w.get(d) ?? 0) * v;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y;
      for (const [d, v] of vec) grad.set(d, (grad.get(d) ?? 0) + (err * v) / rows.length);
      gb += err / rows.length;
    }
    b -= lr * gb;
    for (const [d, g] of grad) {
      const reg = l2 * (w.get(d) ?? 0) / rows.length;
      w.set(d, (w.get(d) ?? 0) - lr * (g + reg));
    }
  }
  return w;
}

/** name an archetype: dominant ink pair plus its two most distinguishing cards */
export function nameArchetype(
  centroid: Map<number, number>,
  cardNames: Map<number, string>,
  cardInks: Map<number, string[]>,
  corpusShare: Map<number, number> = new Map()
): string {
  const inkCount = new Map<string, number>();
  for (const [id, share] of centroid) {
    for (const ink of cardInks.get(id) ?? []) inkCount.set(ink, (inkCount.get(ink) ?? 0) + share);
  }
  const inks = [...inkCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([i]) => i);
  // name by lift — share within the cluster relative to the corpus mean — so the
  // archetype's *characteristic* cards surface instead of cheap ubiquitous
  // enablers that merely hold large absolute shares
  const top = [...centroid.entries()]
    .filter(([, share]) => share >= 0.02)
    .map(([id, share]) => ({ id, lift: share / Math.max(corpusShare.get(id) ?? 0, 1e-6) }))
    .sort((a, b) => b.lift - a.lift || a.id - b.id)
    .slice(0, 2)
    .map(({ id }) => cardNames.get(id) ?? `card ${id}`);
  return `${inks.join('/') || '?'} ${top.join(' + ')}`;
}

// ---------------------------------------------------------------------------
// Relation embeddings: SGNS over canonicalized decks (design D3)
// ---------------------------------------------------------------------------

export interface RelationDeck {
  /** expanded card tokens (one entry per copy), canonical ids */
  tokens: number[];
  /** event date YYYY-MM-DD, for recency weighting */
  date: string;
}

export interface SgnsOptions {
  dim: number;
  epochs: number;
  negatives: number;
  lr: number;
  seed: number;
  /** decay half-life in days; null/undefined → recency weighting off (default while the corpus is thin) */
  recencyHalfLifeDays?: number | null;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const cosineSim = (a: Float64Array, b: Float64Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d++) {
    dot += a[d]! * b[d]!;
    na += a[d]! * a[d]!;
    nb += b[d]! * b[d]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
};

/**
 * Skip-gram with negative sampling. Determinism contract: seeded PRNG,
 * integer-only shuffle indices, sorted vocab, fixed per-deck token order, and
 * no Math.random — the same corpus and seed produce identical embeddings on
 * any engine. Each center token draws one positive context from the same deck
 * (item2vec-style whole-document window, sampled) plus `negatives` draws from
 * the unigram^0.75 distribution. Recency weighting (spec: parameter, default
 * off) scales a deck's learning rate by 0.5^(ageDays / halfLife).
 */
export function trainRelations(decks: RelationDeck[], opts: Partial<SgnsOptions> = {}): Map<number, Float64Array> {
  const { dim, epochs, negatives, lr, seed } = {
    dim: SGNS_DIM,
    epochs: SGNS_EPOCHS,
    negatives: SGNS_NEGATIVES,
    lr: SGNS_LR,
    seed: SGNS_SEED,
    ...opts,
  };
  const rng = mulberry32(seed);

  const vocab = [...new Set(decks.flatMap((d) => d.tokens))].sort((a, b) => a - b);
  const vectors = new Map<number, Float64Array>();
  if (vocab.length === 0 || decks.length === 0) return vectors;

  // deterministic per-deck token order: sorted distinct ids, expanded by count
  const expanded = decks.map((d) => {
    const counts = new Map<number, number>();
    for (const t of d.tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tokens: number[] = [];
    for (const id of [...counts.keys()].sort((a, b) => a - b)) {
      for (let i = 0; i < counts.get(id)!; i++) tokens.push(id);
    }
    return tokens;
  });

  const init = (): Float64Array => {
    const v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = (rng() - 0.5) / dim;
    return v;
  };
  const wIn = new Map<number, Float64Array>();
  const wOut = new Map<number, Float64Array>();
  for (const id of vocab) {
    wIn.set(id, init());
    wOut.set(id, init());
  }

  // unigram^0.75 negative-sampling distribution (cumulative, binary-searched)
  const freq = new Map<number, number>();
  for (const d of expanded) for (const t of d) freq.set(t, (freq.get(t) ?? 0) + 1);
  const cumulative: number[] = [];
  let acc = 0;
  for (const id of vocab) {
    acc += Math.pow(freq.get(id) ?? 0, 0.75);
    cumulative.push(acc);
  }
  const sampleVocab = (): number => {
    const r = rng() * acc;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    return vocab[lo]!;
  };

  // recency weights: 0.5^(ageDays / halfLife) against the newest event (default off)
  const halfLife = opts.recencyHalfLifeDays;
  const maxTime = Math.max(...decks.map((d) => Date.parse(d.date)));
  const deckWeight = (i: number): number => {
    if (!halfLife || halfLife <= 0) return 1;
    const ageDays = Math.max(0, (maxTime - Date.parse(decks[i]!.date)) / 86_400_000);
    return Math.pow(0.5, ageDays / halfLife);
  };

  const deckOrder = decks.map((_, i) => i);
  const totalUpdates = expanded.reduce((s, d) => s + d.length, 0) * epochs;
  let updates = 0;
  const neu = new Float64Array(dim);
  for (let epoch = 0; epoch < epochs; epoch++) {
    // integer-only Fisher-Yates over deck indices (deterministic order)
    for (let i = deckOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deckOrder[i], deckOrder[j]] = [deckOrder[j]!, deckOrder[i]!];
    }
    for (const di of deckOrder) {
      const tokens = expanded[di]!;
      if (tokens.length < 2) {
        updates += tokens.length;
        continue;
      }
      const weight = deckWeight(di);
      for (let i = 0; i < tokens.length; i++) {
        const progress = Math.min(1, updates / totalUpdates);
        const stepLr = Math.max(lr * 1e-4, lr * (1 - progress)) * weight;
        updates++;
        const center = tokens[i]!;
        const pos = tokens[Math.floor(rng() * tokens.length)]!;
        if (pos === center) continue;
        const cVec = wIn.get(center)!;
        neu.fill(0);
        // one positive + k negatives, exact sigmoid, plain SGD
        for (let n = -1; n < negatives; n++) {
          const word = n < 0 ? pos : sampleVocab();
          if (word === pos && n >= 0) continue;
          const label = n < 0 ? 1 : 0;
          const oVec = wOut.get(word)!;
          let dot = 0;
          for (let d = 0; d < dim; d++) dot += cVec[d]! * oVec[d]!;
          const g = (label - sigmoid(dot)) * stepLr;
          for (let d = 0; d < dim; d++) {
            neu[d]! += g * oVec[d]!;
            oVec[d] = oVec[d]! + g * cVec[d]!;
          }
        }
        for (let d = 0; d < dim; d++) cVec[d] = cVec[d]! + neu[d]!;
      }
    }
  }
  for (const [id, v] of wIn) vectors.set(id, v);
  return vectors;
}

/**
 * Relation coherence gate (D6): on holdout events, a deck's own cards must
 * average higher embedding similarity than random card pairs (margin ≥ 1.1×).
 * A self-coherence bar — not a performance claim.
 */
export function coherenceCheck(
  holdout: RelationDeck[],
  vectors: Map<number, Float64Array>,
  opts: { seed?: number; randomPairs?: number; threshold?: number } = {}
): RelationGateMetrics {
  const seed = opts.seed ?? SGNS_SEED;
  const threshold = opts.threshold ?? COHERENCE_THRESHOLD;
  const randomPairs = opts.randomPairs ?? COHERENCE_RANDOM_PAIRS;
  const rng = mulberry32(seed ^ 0x9e3779b9);

  let ownSum = 0;
  let pairs = 0;
  let holdoutDecks = 0;
  for (const deck of holdout) {
    const ids = [...new Set(deck.tokens)].filter((id) => vectors.has(id)).sort((a, b) => a - b);
    if (ids.length < 2) continue;
    holdoutDecks++;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        ownSum += cosineSim(vectors.get(ids[i]!)!, vectors.get(ids[j]!)!);
        pairs++;
      }
    }
  }
  const own = pairs > 0 ? ownSum / pairs : 0;

  // random control drawn from the holdout population, not the whole vocab —
  // synthetic-only vectors (text-reference cold starts) are undertrained and
  // would inflate a vocab-wide control into apples-to-oranges
  const holdoutIds = [...new Set(holdout.flatMap((d) => d.tokens))].filter((id) => vectors.has(id)).sort((a, b) => a - b);
  const vocab = holdoutIds.length >= 2 ? holdoutIds : [...vectors.keys()].sort((a, b) => a - b);
  let randomSum = 0;
  let sampled = 0;
  if (vocab.length >= 2) {
    for (let p = 0; p < randomPairs; p++) {
      const a = vocab[Math.floor(rng() * vocab.length)]!;
      const b = vocab[Math.floor(rng() * vocab.length)]!;
      if (a === b) continue;
      randomSum += cosineSim(vectors.get(a)!, vectors.get(b)!);
      sampled++;
    }
  }
  const random = sampled > 0 ? randomSum / sampled : 0;
  const margin = random > 1e-9 ? own / random : own > 0 ? Infinity : 0;
  return {
    metric: 'holdout_coherence_ratio',
    value: round4(own),
    random: round4(random),
    threshold,
    passed: pairs > 0 && sampled > 0 && margin >= threshold,
    holdoutDecks,
    vocab: vocab.length,
    pairs,
  };
}

/** Int16 quantization with a per-vector scale factor, base64-encoded, little-endian (D3) */
export function quantizeEmbeddings(dim: number, vectors: Map<number, Float64Array>): RelationEmbeddings {
  const out: Record<string, { b64: string; scale: number }> = {};
  for (const [id, v] of [...vectors.entries()].sort((a, b) => a[0] - b[0])) {
    let maxAbs = 0;
    for (let d = 0; d < dim; d++) maxAbs = Math.max(maxAbs, Math.abs(v[d]!));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = new ArrayBuffer(dim * 2);
    const view = new DataView(buf);
    for (let d = 0; d < dim; d++) {
      view.setInt16(d * 2, Math.max(-32768, Math.min(32767, Math.round(v[d]! / scale))), true);
    }
    out[String(id)] = { b64: Buffer.from(buf).toString('base64'), scale };
  }
  return { dim, quantization: 'int16-le', vectors: out };
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// ---------------------------------------------------------------------------
// Capability-gated publication (D6)
// ---------------------------------------------------------------------------

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
export interface PopularityMaps {
  playrate: Record<string, number>;
  typicalCopies: Record<string, number>;
}

/**
 * Playrate and typical copies over the training rows (canonical ids):
 * playrate = share of training decks containing the card, byte-quantized
 * 0–255; typical copies = mean copy count when played, clamped to 1–4.
 */
export function cardPopularityMaps(rows: TrainRow[]): PopularityMaps {
  const decks = rows.length || 1;
  const stats = new Map<number, { decks: number; copies: number }>();
  for (const row of rows) {
    for (const [id, count] of row.counts) {
      const s = stats.get(id) ?? { decks: 0, copies: 0 };
      s.decks += 1;
      s.copies += count;
      stats.set(id, s);
    }
  }
  const playrate: Record<string, number> = {};
  const typicalCopies: Record<string, number> = {};
  for (const [id, { decks: n, copies }] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    playrate[String(id)] = Math.round((n / decks) * 255);
    typicalCopies[String(id)] = Math.min(4, Math.max(1, Math.round(copies / n)));
  }
  return { playrate, typicalCopies };
}

/**
 * Assemble the artifact from independently gated capabilities: publication
 * when either gate passes, failing parts omitted, per-gate metrics always
 * recorded. Neither passes → nothing to publish.
 */
export function assembleMetaModel(parts: {
  dataThroughDate: string;
  cardSchemaVersion: number;
  sources: Record<string, number>;
  calibration: CalibrationOutput;
  relations: RelationsOutput;
  popularity?: PopularityMaps;
}): TrainedModel | null {
  const { calibration, relations } = parts;
  const capabilities = { relations: relations.passed, calibration: calibration.passed };
  if (!capabilities.relations && !capabilities.calibration) return null;
  const model: TrainedModel = {
    version: '3',
    dataThroughDate: parts.dataThroughDate,
    cardSchemaVersion: parts.cardSchemaVersion,
    capabilities,
    gates: { relations: relations.metrics, calibration: calibration.metrics },
    sources: parts.sources,
  };
  if (capabilities.calibration) {
    model.archetypes = calibration.archetypes;
    model.cardWeights = calibration.cardWeights;
  }
  if (capabilities.relations) {
    const first = relations.vectors.values().next();
    model.relations = quantizeEmbeddings(first.done ? 0 : first.value.length, relations.vectors);
  }
  if (parts.popularity) {
    model.playrate = parts.popularity.playrate;
    model.typicalCopies = parts.popularity.typicalCopies;
  }
  return model;
}

export interface TrainOptions {
  dataDir?: string;
  outDir?: string;
  k?: number;
  seed?: number;
  /** relation recency weighting half-life in days; off by default (thin corpus) */
  recencyHalfLifeDays?: number;
  /** rolling calibration window in days (0 → full training split); default 90 */
  calibrationWindowDays?: number;
  /** impute recordless-but-placed lists from the place-percentile curve.
   *  Default on: the values only matter to calibration, whose 90-day window
   *  excludes the deep-history rows anyway — while relations gain every list. */
  imputeWinRate?: boolean;
}

/**
 * Holdout split: the newest 25% of events, but only within the recent era
 * (HOLDOUT_MAX_AGE_DAYS). Deep-history events always train — a share-based
 * holdout over a mixed-era corpus would consume the entire recent meta and
 * score calibration against data a year older than the model's window.
 */
export function selectHoldoutEvents(events: { id: string; date: string }[]): Set<string> {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const maxDate = sorted[sorted.length - 1]!.date;
  const floor = new Date(Date.parse(maxDate) - HOLDOUT_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const recent = sorted.filter((e) => e.date >= floor);
  const count = Math.max(1, Math.floor(recent.length * HOLDOUT_EVENT_SHARE));
  return new Set(recent.slice(-count).map((e) => e.id));
}

/** full pipeline: rows → canonicalize → split → train both capabilities → gate → assemble → write */
export async function train(opts: TrainOptions = {}): Promise<{ model: TrainedModel | null; report: string }> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const outDir = opts.outDir ?? OUT_DIR;
  const files = (await readdir(dataDir)).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no datasets in ${dataDir} — run a source fetcher first`);
  const datasets: Dataset[] = [];
  for (const f of files) datasets.push(JSON.parse(await readFile(path.join(dataDir, f), 'utf8')) as Dataset);

  // card snapshot: identity registry (D1) + archetype naming
  const snap = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'cards.min.json'), 'utf8')) as {
    cards: Card[];
  };
  const cardNames = new Map(snap.cards.map((c) => [c.id, c.fullName]));
  const cardInks = new Map(snap.cards.map((c) => [c.id, c.inks]));
  const alias = buildCanonicalRegistry(snap.cards).alias;

  const built = buildRows(datasets, { imputeWinRate: opts.imputeWinRate ?? true });
  if (built.rows.length < 100) throw new Error(`corpus too small: ${built.rows.length} usable lists (need ≥ 100)`);
  const { rows, dropped: canonicalDropped } = canonicalizeRows(built.rows, alias);

  // newest events are the holdout (recency-capped — see selectHoldoutEvents)
  const events = [...new Set(rows.map((r) => r.eventId))];
  const eventDate = new Map(events.map((e) => [e, rows.find((r) => r.eventId === e)!.date]));
  const holdoutEvents = selectHoldoutEvents(events.map((id) => ({ id, date: eventDate.get(id)! })));
  const trainRows = rows.filter((r) => !holdoutEvents.has(r.eventId));
  const holdout = rows.filter((r) => holdoutEvents.has(r.eventId));

  // ---- calibration capability (rolling window, shrunk cluster means) ----
  const maxTrainDate = trainRows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const windowDays = opts.calibrationWindowDays ?? CALIBRATION_WINDOW_DAYS;
  const windowCutoff = Date.parse(maxTrainDate) - windowDays * 86_400_000;
  const windowed =
    windowDays > 0 ? trainRows.filter((r) => Date.parse(r.date) >= windowCutoff) : trainRows;
  // a too-thin window is worse than a stale one — fall back to the full split
  const calibrationRows = windowed.length >= MIN_CALIBRATION_ROWS ? windowed : trainRows;

  const trainVecs = calibrationRows.map((r) => r.vec);
  const assign = kmeans(trainVecs, opts.k ?? K, opts.seed ?? 42);

  // corpus-mean share per card over the clustered population — the lift
  // denominator for archetype naming
  const corpusShare = new Map<number, number>();
  for (const r of calibrationRows) {
    for (const [d, v] of r.vec) corpusShare.set(d, (corpusShare.get(d) ?? 0) + v / calibrationRows.length);
  }

  const clusters = new Map<number, { rows: TrainRow[] }>();
  calibrationRows.forEach((r, i) => {
    const ci = assign[i]!;
    (clusters.get(ci) ?? clusters.set(ci, { rows: [] }).get(ci)!).rows.push(r);
  });

  const windowMean = calibrationRows.reduce((s, r) => s + r.winRate, 0) / calibrationRows.length;
  const archetypeList = [...clusters.entries()].map(([ci, { rows: members }]) => {
    const rawMean = members.reduce((s, r) => s + r.winRate, 0) / members.length;
    // shrinkage: small clusters regress toward the window mean instead of
    // shipping noisy win-rate estimates
    const observedWinRate = (members.length * rawMean + SHRINKAGE_K * windowMean) / (members.length + SHRINKAGE_K);
    // centroid = mean vector
    const centroid = new Map<number, number>();
    for (const r of members) for (const [d, v] of r.vec) centroid.set(d, (centroid.get(d) ?? 0) + v / members.length);
    return { ci, observedWinRate, sampleSize: members.length, centroid };
  });
  // predict via nearest training centroid
  const predictWinRate = (vec: Map<number, number>): number => {
    let best = archetypeList[0]!;
    let bestDist = Infinity;
    for (const a of archetypeList) {
      const d = sqDist(vec, a.centroid);
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best.observedWinRate;
  };

  const weights = logisticRegression(calibrationRows.map((r) => ({ vec: r.vec, y: r.topCut ? 1 : 0 })));

  const globalMean = trainRows.reduce((s, r) => s + r.winRate, 0) / trainRows.length;
  let modelErr = 0;
  let baseErr = 0;
  for (const r of holdout) {
    modelErr += Math.abs(predictWinRate(r.vec) - r.winRate);
    baseErr += Math.abs(globalMean - r.winRate);
  }
  const maeModel = modelErr / holdout.length;
  const maeBaseline = baseErr / holdout.length;
  // must beat the global-mean prior by at least 2% — noise-level "wins" refuse publication
  const calibrationPassed = maeModel < maeBaseline * 0.98;

  const archetypes: Archetype[] = archetypeList
    .sort((a, b) => b.sampleSize - a.sampleSize)
    .map((a, i) => ({
      id: i + 1,
      name: nameArchetype(a.centroid, cardNames, cardInks, corpusShare),
      observedWinRate: Math.round(a.observedWinRate * 1000) / 1000,
      sampleSize: a.sampleSize,
      centroid: Object.fromEntries([...a.centroid].map(([d, v]) => [String(d), Math.round(v * 1000) / 1000])),
    }));

  const calibration: CalibrationOutput = {
    passed: calibrationPassed,
    archetypes,
    cardWeights: Object.fromEntries([...weights].map(([d, w]) => [String(d), Math.round(w * 1000) / 1000])),
    metrics: {
      metric: 'holdout_winrate_mae',
      value: round4(maeModel),
      baseline: round4(maeBaseline),
      passed: calibrationPassed,
      holdoutDecks: holdout.length,
    },
  };

  // ---- relations capability (SGNS + coherence gate) ----
  // SGNS is unsupervised — every co-occurrence is signal, so relations train on
  // ALL rows (deep history included); the holdout is evaluation-only. Synthetic
  // text-reference documents add *designed* synergies (Shift targets, "named X"
  // effects) that deck data alone may never observe.
  const toRelationDeck = (r: TrainRow): RelationDeck => ({
    tokens: [...r.counts.entries()].flatMap(([id, count]) => Array.from({ length: count }, () => id)),
    date: r.date,
  });
  const nameRefs = extractNameReferences(snap.cards);
  const coldIds = new Set(rows.flatMap((r) => [...r.counts.keys()]));
  const textRefDecks = referenceDecks(nameRefs, snap.cards, { realDecks: rows.length, coldIds });
  const relationVectors = trainRelations([...rows.map(toRelationDeck), ...textRefDecks], {
    seed: opts.seed ?? SGNS_SEED,
    recencyHalfLifeDays: opts.recencyHalfLifeDays ?? null,
  });
  const relationMetrics = coherenceCheck(holdout.map(toRelationDeck), relationVectors, {
    seed: opts.seed ?? SGNS_SEED,
  });
  const relations: RelationsOutput = {
    passed: relationMetrics.passed,
    vectors: relationVectors,
    metrics: relationMetrics,
  };

  const dataThroughDate = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const sources: Record<string, number> = {};
  for (const r of rows) sources[r.source] = (sources[r.source] ?? 0) + 1;

  const model = assembleMetaModel({
    dataThroughDate,
    cardSchemaVersion: 1,
    sources,
    calibration,
    relations,
    // version '3': per-card popularity over the training split (holdout stays eval-only)
    popularity: cardPopularityMaps(trainRows),
  });

  const relationMargin = relationMetrics.random > 1e-9 ? relationMetrics.value / relationMetrics.random : Infinity;
  const imputedNote = built.imputed > 0 ? ` · ${built.imputed} curve-imputed win rates` : '';
  const report =
    `training: ${rows.length} lists (${built.dropped} unmapped-filtered, ${canonicalDropped} canonicalization-dropped) ` +
    `from ${events.length} events · relations on all ${rows.length} + ${textRefDecks.length} text-ref decks, holdout ${holdout.length} (eval-only) · ` +
    `calibration MAE ${maeModel.toFixed(4)} vs baseline ${maeBaseline.toFixed(4)} → ` +
    `${calibrationPassed ? 'PASSED' : 'REJECTED'} · ` +
    `relations coherence ${relationMetrics.value.toFixed(4)} vs random ${relationMetrics.random.toFixed(4)} ` +
    `(margin ${Number.isFinite(relationMargin) ? relationMargin.toFixed(2) : '∞'}, threshold ${COHERENCE_THRESHOLD}) → ` +
    `${relationMetrics.passed ? 'PASSED' : 'REJECTED'}${imputedNote}`;

  await mkdir(outDir, { recursive: true });
  if (model) {
    await writeFile(path.join(outDir, 'meta-model.json'), JSON.stringify(model, null, 1));
  } else {
    await writeFile(
      path.join(outDir, 'rejected.json'),
      JSON.stringify({ report, gates: { calibration: calibration.metrics, relations: relations.metrics } }, null, 1)
    );
  }
  return { model, report };
}

// CLI entry: npx tsx scripts/training/train.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { model, report } = await train();
  console.log(report);
  if (model) {
    const caps = model.capabilities;
    console.log(
      `artifact written (relations ${caps.relations ? '✓' : '✗'}, calibration ${caps.calibration ? '✓' : '✗'}` +
        `${model.relations ? `, ${Object.keys(model.relations.vectors).length} card vectors` : ''})`
    );
  } else {
    console.log('publication refused — no artifact emitted');
  }
}
