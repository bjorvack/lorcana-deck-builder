import { mulberry32 } from './prng';

const KMEANS_ITERS = 30;
const LOGISTIC_ITERS = 400;
const LOGISTIC_LR = 0.2;
const LOGISTIC_L2 = 4;

export function kmeans(
  vectors: Map<number, number>[],
  k: number,
  seed = 42,
): number[] {
  const rng = mulberry32(seed);
  // k-means++ style init: first center at random, then farthest-point sampling
  const centers: Map<number, number>[] = [
    vectors[Math.floor(rng() * vectors.length)]!,
  ];
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
      for (const m of members)
        for (const [d, v] of m)
          mean.set(d, (mean.get(d) ?? 0) + v / members.length);
      centers[ci] = mean;
    }
  }
  return assign;
}

export const sqDist = (
  a: Map<number, number>,
  b: Map<number, number>,
): number => {
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
  l2 = LOGISTIC_L2,
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
      for (const [d, v] of vec)
        grad.set(d, (grad.get(d) ?? 0) + (err * v) / rows.length);
      gb += err / rows.length;
    }
    b -= lr * gb;
    for (const [d, g] of grad) {
      const reg = (l2 * (w.get(d) ?? 0)) / rows.length;
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
  corpusShare: Map<number, number> = new Map(),
): string {
  const inkCount = new Map<string, number>();
  for (const [id, share] of centroid) {
    for (const ink of cardInks.get(id) ?? [])
      inkCount.set(ink, (inkCount.get(ink) ?? 0) + share);
  }
  const inks = [...inkCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([i]) => i);
  // name by lift — share within the cluster relative to the corpus mean — so the
  // archetype's *characteristic* cards surface instead of cheap ubiquitous
  // enablers that merely hold large absolute shares
  const top = [...centroid.entries()]
    .filter(([, share]) => share >= 0.02)
    .map(([id, share]) => ({
      id,
      lift: share / Math.max(corpusShare.get(id) ?? 0, 1e-6),
    }))
    .sort((a, b) => b.lift - a.lift || a.id - b.id)
    .slice(0, 2)
    .map(({ id }) => cardNames.get(id) ?? `card ${id}`);
  return `${inks.join('/') || '?'} ${top.join(' + ')}`;
}

// ---------------------------------------------------------------------------
// Relation embeddings: SGNS over canonicalized decks (design D3)
// ---------------------------------------------------------------------------
