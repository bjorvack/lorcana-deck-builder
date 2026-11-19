import type { Card } from '../../src/data/types';
import { extractNameReferences, referenceDecks } from '../../src/text/refs';
import type {
  RelationEmbeddings,
  RelationGateMetrics,
  RelationsOutput,
  TrainRow,
} from './model-types';
import { mulberry32 } from './prng';

const SGNS_DIM = 32;
const SGNS_EPOCHS = 10;
const SGNS_NEGATIVES = 5;
const SGNS_LR = 0.05;
const SGNS_SEED = 42;

export const COHERENCE_THRESHOLD = 1.1;
const COHERENCE_RANDOM_PAIRS = 20000;

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
export function trainRelations(
  decks: RelationDeck[],
  opts: Partial<SgnsOptions> = {},
): Map<number, Float64Array> {
  const { dim, epochs, negatives, lr, seed } = {
    dim: SGNS_DIM,
    epochs: SGNS_EPOCHS,
    negatives: SGNS_NEGATIVES,
    lr: SGNS_LR,
    seed: SGNS_SEED,
    ...opts,
  };
  const rng = mulberry32(seed);

  const vocab = [...new Set(decks.flatMap((d) => d.tokens))].sort(
    (a, b) => a - b,
  );
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
  for (const d of expanded)
    for (const t of d) freq.set(t, (freq.get(t) ?? 0) + 1);
  const cumulative: number[] = [];
  let acc = 0;
  for (const id of vocab) {
    acc += (freq.get(id) ?? 0) ** 0.75;
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
    const ageDays = Math.max(
      0,
      (maxTime - Date.parse(decks[i]!.date)) / 86_400_000,
    );
    return 0.5 ** (ageDays / halfLife);
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
  opts: { seed?: number; randomPairs?: number; threshold?: number } = {},
): RelationGateMetrics {
  const seed = opts.seed ?? SGNS_SEED;
  const threshold = opts.threshold ?? COHERENCE_THRESHOLD;
  const randomPairs = opts.randomPairs ?? COHERENCE_RANDOM_PAIRS;
  const rng = mulberry32(seed ^ 0x9e3779b9);

  let ownSum = 0;
  let pairs = 0;
  let holdoutDecks = 0;
  for (const deck of holdout) {
    const ids = [...new Set(deck.tokens)]
      .filter((id) => vectors.has(id))
      .sort((a, b) => a - b);
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
  const holdoutIds = [...new Set(holdout.flatMap((d) => d.tokens))]
    .filter((id) => vectors.has(id))
    .sort((a, b) => a - b);
  const vocab =
    holdoutIds.length >= 2
      ? holdoutIds
      : [...vectors.keys()].sort((a, b) => a - b);
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
export function quantizeEmbeddings(
  dim: number,
  vectors: Map<number, Float64Array>,
): RelationEmbeddings {
  const out: Record<string, { b64: string; scale: number }> = {};
  for (const [id, v] of [...vectors.entries()].sort((a, b) => a[0] - b[0])) {
    let maxAbs = 0;
    for (let d = 0; d < dim; d++) maxAbs = Math.max(maxAbs, Math.abs(v[d]!));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = new ArrayBuffer(dim * 2);
    const view = new DataView(buf);
    for (let d = 0; d < dim; d++) {
      view.setInt16(
        d * 2,
        Math.max(-32768, Math.min(32767, Math.round(v[d]! / scale))),
        true,
      );
    }
    out[String(id)] = { b64: Buffer.from(buf).toString('base64'), scale };
  }
  return { dim, quantization: 'int16-le', vectors: out };
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// ---------------------------------------------------------------------------
// Capability-gated publication (D6)
// ---------------------------------------------------------------------------

export interface RelationsCapabilityInput {
  rows: TrainRow[];
  holdout: TrainRow[];
  cards: Card[];
  seed?: number;
  recencyHalfLifeDays?: number | null;
}

/**
 * Relations capability (SGNS + coherence gate). SGNS is unsupervised — every
 * co-occurrence is signal, so relations train on ALL rows (deep history
 * included); the holdout is evaluation-only. Synthetic text-reference
 * documents add *designed* synergies (Shift targets, "named X" effects)
 * that deck data alone may never observe.
 */
export function relationsCapability(input: RelationsCapabilityInput): {
  relations: RelationsOutput;
  textRefDecks: number;
} {
  const { rows, holdout, cards } = input;
  const toRelationDeck = (r: TrainRow): RelationDeck => ({
    tokens: [...r.counts.entries()].flatMap(([id, count]) =>
      Array.from({ length: count }, () => id),
    ),
    date: r.date,
  });
  const nameRefs = extractNameReferences(cards);
  const coldIds = new Set(rows.flatMap((r) => [...r.counts.keys()]));
  const textRefDecks = referenceDecks(nameRefs, cards, {
    realDecks: rows.length,
    coldIds,
  });
  const vectors = trainRelations(
    [...rows.map(toRelationDeck), ...textRefDecks],
    {
      seed: input.seed ?? SGNS_SEED,
      recencyHalfLifeDays: input.recencyHalfLifeDays ?? null,
    },
  );
  const metrics = coherenceCheck(holdout.map(toRelationDeck), vectors, {
    seed: input.seed ?? SGNS_SEED,
  });
  return {
    relations: { passed: metrics.passed, vectors, metrics },
    textRefDecks: textRefDecks.length,
  };
}
