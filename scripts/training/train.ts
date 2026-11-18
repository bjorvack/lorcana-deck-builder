import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Offline meta-model training (task 4.3). Source-agnostic: consumes every
 * scripts/training/data/*.json dataset (the normalized adapter schema shared
 * by the TopDeck and Lorcanahunter fetchers), trains on the merged corpus and
 * — only when it beats the global-prior baseline on a recent-events holdout —
 * writes scripts/training/output/model.json for the pipeline to emit.
 *
 * Models:
 * - archetype centroids: k-means (k=12, seeded) over normalized deck vectors;
 *   a holdout deck's predicted win rate is its nearest centroid's mean win rate
 * - card weights: L2-regularized logistic regression predicting top-cut
 *   membership from card counts
 *
 * Gate: model mean-absolute-error on holdout win rates must beat the baseline
 * (predicting the global mean win rate for every deck). Otherwise nothing is
 * published — the app stays deterministic-only.
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
  /** match win rate 0-1 */
  winRate: number;
  /** made the top cut */
  topCut: boolean;
  playerCount: number;
}

export interface Archetype {
  id: number;
  name: string;
  observedWinRate: number;
  sampleSize: number;
  centroid: Record<string, number>;
}

export interface TrainedModel {
  version: string;
  dataThroughDate: string;
  cardSchemaVersion: number;
  archetypes: Archetype[];
  cardWeights: Record<string, number>;
  backtest: { metric: string; value: number; baseline: number; passed: boolean; holdoutDecks: number };
  sources: Record<string, number>;
}

const MIN_MAPPED_CARDS = 55;
const K = 12;
const KMEANS_ITERS = 30;
const HOLDOUT_EVENT_SHARE = 0.25;
const LOGISTIC_ITERS = 400;
const LOGISTIC_LR = 0.2;
const LOGISTIC_L2 = 4;

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

/** load every dataset and flatten to training rows, dropping poorly-mapped or win-rate-less lists */
export function buildRows(datasets: Dataset[]): { rows: TrainRow[]; dropped: number } {
  const rows: TrainRow[] = [];
  let dropped = 0;
  for (const ds of datasets) {
    for (const t of ds.tournaments) {
      const seenPlayers = new Set<string>();
      for (const e of t.entries) {
        const mapped = e.cards.reduce((s, c) => s + c.count, 0);
        if (mapped < MIN_MAPPED_CARDS || mapped > 62 || e.winRate === null || e.winRate < 0 || e.winRate > 1) {
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
        for (const c of e.cards) vec.set(c.cardId, c.count / total);
        rows.push({
          source: ds.source,
          eventId: t.eventId,
          date: t.date,
          vec,
          winRate: e.winRate,
          topCut: e.standing !== null && t.topCut > 0 && e.standing <= t.topCut,
          playerCount: t.playerCount,
        });
      }
    }
  }
  return { rows, dropped };
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
  cardInks: Map<number, string[]>
): string {
  const inkCount = new Map<string, number>();
  for (const [id, share] of centroid) {
    for (const ink of cardInks.get(id) ?? []) inkCount.set(ink, (inkCount.get(ink) ?? 0) + share);
  }
  const inks = [...inkCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([i]) => i);
  const globalShare = new Map<number, number>();
  for (const [, v] of centroid) globalShare.set(v, (globalShare.get(v) ?? 0) + v);
  const top = [...centroid.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id]) => cardNames.get(id) ?? `card ${id}`);
  return `${inks.join('/') || '?'} ${top.join(' + ')}`;
}

export interface TrainOptions {
  dataDir?: string;
  outDir?: string;
  k?: number;
  seed?: number;
}

/** full pipeline: rows → split → train → backtest → write (only when the gate passes) */
export async function train(opts: TrainOptions = {}): Promise<{ model: TrainedModel | null; report: string }> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const outDir = opts.outDir ?? OUT_DIR;
  const files = (await readdir(dataDir)).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no datasets in ${dataDir} — run a source fetcher first`);
  const datasets: Dataset[] = [];
  for (const f of files) datasets.push(JSON.parse(await readFile(path.join(dataDir, f), 'utf8')) as Dataset);

  // card snapshot for archetype naming (id → name, inks)
  const snap = JSON.parse(await readFile(path.join(ROOT, 'public', 'data', 'cards.min.json'), 'utf8')) as {
    cards: { id: number; fullName: string; inks: string[] }[];
  };
  const cardNames = new Map(snap.cards.map((c) => [c.id, c.fullName]));
  const cardInks = new Map(snap.cards.map((c) => [c.id, c.inks]));

  const { rows, dropped } = buildRows(datasets);
  if (rows.length < 100) throw new Error(`corpus too small: ${rows.length} usable lists (need ≥ 100)`);

  // newest events are the holdout
  const events = [...new Set(rows.map((r) => r.eventId))];
  const eventDate = new Map(events.map((e) => [e, rows.find((r) => r.eventId === e)!.date]));
  const sortedEvents = [...events].sort((a, b) => (eventDate.get(a) ?? '').localeCompare(eventDate.get(b) ?? ''));
  const holdoutCount = Math.max(1, Math.floor(sortedEvents.length * HOLDOUT_EVENT_SHARE));
  const holdoutEvents = new Set(sortedEvents.slice(-holdoutCount));
  const train = rows.filter((r) => !holdoutEvents.has(r.eventId));
  const holdout = rows.filter((r) => holdoutEvents.has(r.eventId));

  // archetype centroids on the training set
  const trainVecs = train.map((r) => r.vec);
  const assign = kmeans(trainVecs, opts.k ?? K, opts.seed ?? 42);

  const clusters = new Map<number, { rows: TrainRow[] }>();
  train.forEach((r, i) => {
    const ci = assign[i]!;
    (clusters.get(ci) ?? clusters.set(ci, { rows: [] }).get(ci)!).rows.push(r);
  });

  const archetypeList = [...clusters.entries()].map(([ci, { rows: members }]) => {
    const observedWinRate = members.reduce((s, r) => s + r.winRate, 0) / members.length;
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

  // card weights: L2 logistic on top-cut membership (training set only)
  const weights = logisticRegression(train.map((r) => ({ vec: r.vec, y: r.topCut ? 1 : 0 })));

  // backtest on the holdout: model (nearest-centroid prior) vs global-mean baseline
  const globalMean = train.reduce((s, r) => s + r.winRate, 0) / train.length;
  let modelErr = 0;
  let baseErr = 0;
  for (const r of holdout) {
    modelErr += Math.abs(predictWinRate(r.vec) - r.winRate);
    baseErr += Math.abs(globalMean - r.winRate);
  }
  const maeModel = modelErr / holdout.length;
  const maeBaseline = baseErr / holdout.length;
  // must beat the global-mean prior by at least 2% — noise-level "wins" refuse publication
  const passed = maeModel < maeBaseline * 0.98;

  const dataThroughDate = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const sources: Record<string, number> = {};
  for (const r of rows) sources[r.source] = (sources[r.source] ?? 0) + 1;

  const archetypes: Archetype[] = archetypeList
    .sort((a, b) => b.sampleSize - a.sampleSize)
    .map((a, i) => ({
      id: i + 1,
      name: nameArchetype(a.centroid, cardNames, cardInks),
      observedWinRate: Math.round(a.observedWinRate * 1000) / 1000,
      sampleSize: a.sampleSize,
      centroid: Object.fromEntries([...a.centroid].map(([d, v]) => [String(d), Math.round(v * 1000) / 1000])),
    }));

  const model: TrainedModel = {
    version: '1',
    dataThroughDate,
    cardSchemaVersion: 1,
    archetypes,
    cardWeights: Object.fromEntries([...weights].map(([d, w]) => [String(d), Math.round(w * 1000) / 1000])),
    backtest: {
      metric: 'holdout_winrate_mae',
      value: Math.round(maeModel * 1000) / 1000,
      baseline: Math.round(maeBaseline * 1000) / 1000,
      passed,
      holdoutDecks: holdout.length,
    },
    sources,
  };

  const report =
    `training: ${rows.length} lists (${dropped} dropped) from ${events.length} events · ` +
    `train ${train.length} / holdout ${holdout.length} · ` +
    `MAE model ${maeModel.toFixed(4)} vs baseline ${maeBaseline.toFixed(4)} → ${passed ? 'PASSED' : 'REJECTED'}`;

  if (passed) {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'model.json'), JSON.stringify(model, null, 1));
  } else {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'rejected.json'), JSON.stringify({ report, model }, null, 1));
  }
  return { model: passed ? model : null, report };
}

// CLI entry: npx tsx scripts/training/train.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { model, report } = await train();
  console.log(report);
  console.log(model ? `model written (${model.archetypes.length} archetypes)` : 'publication refused — no model emitted');
}
