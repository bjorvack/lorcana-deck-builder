import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../src/data/types';
import { calibrate } from './calibrate';
import { buildCanonicalRegistry } from './canonical';
import { encoderCapability } from './encoder-capability';
import type {
  Archetype,
  CalibrationGateMetrics,
  CalibrationOutput,
  EncoderGateMetrics,
  EncoderOutput,
  EncoderPayload,
  InteractionGateMetrics,
  InteractionPartners,
  InteractionsOutput,
  RelationEmbeddings,
  RelationGateMetrics,
  RelationsOutput,
  TrainRow,
} from './model-types';
import { synergyCapability } from './synergy-capability';

export { encoderCapability } from './encoder-capability';
export { synergyCapability } from './synergy-capability';

import {
  COHERENCE_THRESHOLD,
  quantizeEmbeddings,
  relationsCapability,
} from './relations-capability';

// implementation moved to focused modules; the public surface stays here
export { calibrate } from './calibrate';
export {
  kmeans,
  logisticRegression,
  nameArchetype,
  sqDist,
} from './learning';
export type {
  Archetype,
  CalibrationGateMetrics,
  CalibrationOutput,
  RelationEmbeddings,
  RelationGateMetrics,
  RelationsOutput,
  TrainRow,
} from './model-types';
export { mulberry32 } from './prng';
export {
  COHERENCE_THRESHOLD,
  coherenceCheck,
  quantizeEmbeddings,
  type RelationDeck,
  relationsCapability,
  type SgnsOptions,
  trainRelations,
} from './relations-capability';

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

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
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

export interface TrainedModel {
  version: '3';
  dataThroughDate: string;
  cardSchemaVersion: number;
  capabilities: {
    relations: boolean;
    calibration: boolean;
    interactions: boolean;
    encoder: boolean;
  };
  gates: {
    relations: RelationGateMetrics;
    calibration: CalibrationGateMetrics;
    interactions: InteractionGateMetrics;
    encoder: EncoderGateMetrics;
  };
  /** calibration capability — omitted when its gate fails */
  archetypes?: Archetype[];
  cardWeights?: Record<string, number>;
  /** relations capability — omitted when its gate fails */
  relations?: RelationEmbeddings;
  /** interactions capability — omitted when its gate fails */
  interactions?: InteractionPartners;
  /** encoder capability — omitted when its gate fails; depends on relations */
  encoder?: EncoderPayload;
  /** version '3' — share of training decks containing the card, byte-quantized 0–255 (canonical card id keys) */
  playrate?: Record<string, number>;
  /** version '3' — typical copy count when played, 1–4 (canonical card id keys) */
  typicalCopies?: Record<string, number>;
  sources: Record<string, number>;
}

const MIN_MAPPED_CARDS = 55;
/** calibration archetype count — the corpus grew 10×; finer clusters, variance-controlled by shrinkage */
/** James-Stein-style shrinkage of cluster win-rate means toward the window mean */
/** rolling calibration window (days) — win-rate anchoring decays with meta drift */
/** below this many in-window lists the window is too thin — fall back to the full split */
const HOLDOUT_EVENT_SHARE = 0.25;
/** holdout era cap — events older than this always train, so a deep-history
 *  source can never push the holdout (and the calibration anchor) into stale metas */
export const HOLDOUT_MAX_AGE_DAYS = 365;

/** SGNS hyperparameters (design D3); lr follows word2vec practice for small corpora */
/** relation coherence gate: own-card similarity must reach 1.1× random-pair similarity */

/** load every dataset and flatten to training rows, dropping poorly-mapped lists.
 *  With `imputeWinRate` (default in train()), recordless-but-placed lists
 *  inherit the corpus's place-percentile mean win rate (deterministic; keeps
 *  the placement signal a flat average would erase) instead of being dropped —
 *  the values never reach calibration (90-day window) but let every mapped
 *  list train relations. */
const winRateCurve = (rows: TrainRow[]): Map<number, number> => {
  const buckets = new Map<number, number[]>();
  for (const r of rows) {
    if (r.standing === null) continue;
    const pct = Math.min(
      0.999,
      Math.max(0, (r.standing - 0.5) / Math.max(1, r.playerCount)),
    );
    const b = Math.floor(pct * 10);
    const list = buckets.get(b) ?? [];
    list.push(r.winRate);
    buckets.set(b, list);
  }
  const curve = new Map<number, number>();
  for (const [b, list] of buckets)
    curve.set(b, list.reduce((s, x) => s + x, 0) / list.length);
  return curve;
};

const meanWinRate = (rows: TrainRow[]): number =>
  rows.length > 0 ? rows.reduce((s, r) => s + r.winRate, 0) / rows.length : 0;

export function buildRows(
  datasets: Dataset[],
  opts: { imputeWinRate?: boolean } = {},
): { rows: TrainRow[]; dropped: number; imputed: number } {
  const rows: TrainRow[] = [];
  const recordless: { row: TrainRow; standing: number }[] = [];
  let dropped = 0;
  for (const ds of datasets) {
    for (const t of ds.tournaments) {
      const seenPlayers = new Set<string>();
      for (const [entryIndex, e] of t.entries.entries()) {
        const mapped = e.cards.reduce((s, c) => s + c.count, 0);
        if (
          mapped < MIN_MAPPED_CARDS ||
          mapped > 62 ||
          (e.winRate !== null && (e.winRate < 0 || e.winRate > 1))
        ) {
          dropped++;
          continue;
        }
        // anonymous players dedupe by entry index: a shared rows.length key
        // made recordless anonymous entries collide (silently dropped) and
        // depended on unrelated row ordering
        const playerKey = `${t.eventId}:${e.player ?? `anon-${entryIndex}`}`;
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
        else if (opts.imputeWinRate && e.standing !== null)
          recordless.push({ row, standing: e.standing });
        else dropped++;
      }
    }
  }
  let imputed = 0;
  if (recordless.length > 0 && rows.length > 0) {
    const curve = winRateCurve(rows);
    const fallback = meanWinRate(rows);
    for (const { row, standing } of recordless) {
      const pct = Math.min(
        0.999,
        Math.max(0, (standing - 0.5) / Math.max(1, row.playerCount)),
      );
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
export function canonicalizeRows(
  rows: TrainRow[],
  alias: Map<number, number>,
): { rows: TrainRow[]; dropped: number } {
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
  for (const [id, { decks: n, copies }] of [...stats.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    playrate[String(id)] = Math.round((n / decks) * 255);
    typicalCopies[String(id)] = Math.min(
      4,
      Math.max(1, Math.round(copies / n)),
    );
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
  interactions?: InteractionsOutput;
  encoder?: EncoderOutput;
  popularity?: PopularityMaps;
}): TrainedModel | null {
  const { calibration, relations, interactions, encoder } = parts;
  // the encoder encodes the relation space: it can only ship alongside it
  const encoderPassed = (encoder?.passed ?? false) && relations.passed;
  const interactionsPassed = interactions?.passed ?? false;
  const capabilities = {
    relations: relations.passed,
    calibration: calibration.passed,
    interactions: interactionsPassed,
    encoder: encoderPassed,
  };
  if (
    !capabilities.relations &&
    !capabilities.calibration &&
    !capabilities.interactions &&
    !capabilities.encoder
  )
    return null;
  const model: TrainedModel = {
    version: '3',
    dataThroughDate: parts.dataThroughDate,
    cardSchemaVersion: parts.cardSchemaVersion,
    capabilities,
    gates: {
      relations: relations.metrics,
      calibration: calibration.metrics,
      interactions: interactions?.metrics ?? {
        metric: 'holdout_lift_ratio',
        value: 1,
        random: 1,
        threshold: 1.1,
        passed: false,
        holdoutDecks: 0,
        pairs: 0,
        cards: 0,
      },
      encoder: encoder?.metrics ?? {
        metric: 'holdout_cosine_ratio',
        value: 0,
        random: 0,
        threshold: 1.1,
        passed: false,
        trainCards: 0,
        evalCards: 0,
        textDim: 0,
        dim: 0,
      },
    },
    sources: parts.sources,
  };
  if (capabilities.calibration) {
    model.archetypes = calibration.archetypes;
    model.cardWeights = calibration.cardWeights;
  }
  if (capabilities.relations) {
    const first = relations.vectors.values().next();
    model.relations = quantizeEmbeddings(
      first.done ? 0 : first.value.length,
      relations.vectors,
    );
  }
  if (capabilities.interactions && interactions) {
    model.interactions = interactions.partners;
  }
  if (capabilities.encoder && encoder) {
    model.encoder = encoder.payload;
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
export function selectHoldoutEvents(
  events: { id: string; date: string }[],
): Set<string> {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const maxDate = sorted[sorted.length - 1]!.date;
  const floor = new Date(
    Date.parse(maxDate) - HOLDOUT_MAX_AGE_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const recent = sorted.filter((e) => e.date >= floor);
  const count = Math.max(1, Math.floor(recent.length * HOLDOUT_EVENT_SHARE));
  return new Set(recent.slice(-count).map((e) => e.id));
}

/** full pipeline: rows → canonicalize → split → train both capabilities → gate → assemble → write */
export async function train(
  opts: TrainOptions = {},
): Promise<{ model: TrainedModel | null; report: string }> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const outDir = opts.outDir ?? OUT_DIR;
  const files = (await readdir(dataDir))
    .filter((f) => f.endsWith('.json'))
    // deterministic corpus order across platforms (k-means init, dedupe keys)
    .sort();
  if (files.length === 0)
    throw new Error(`no datasets in ${dataDir} — run a source fetcher first`);
  const datasets: Dataset[] = [];
  for (const f of files)
    datasets.push(
      JSON.parse(await readFile(path.join(dataDir, f), 'utf8')) as Dataset,
    );

  // card snapshot: identity registry (D1) + archetype naming
  const snap = JSON.parse(
    await readFile(path.join(ROOT, 'public', 'data', 'cards.min.json'), 'utf8'),
  ) as {
    cards: Card[];
  };
  const cardNames = new Map(snap.cards.map((c) => [c.id, c.fullName]));
  const cardInks = new Map(snap.cards.map((c) => [c.id, c.inks]));
  const alias = buildCanonicalRegistry(snap.cards).alias;

  const built = buildRows(datasets, {
    imputeWinRate: opts.imputeWinRate ?? true,
  });
  if (built.rows.length < 100)
    throw new Error(
      `corpus too small: ${built.rows.length} usable lists (need ≥ 100)`,
    );
  const { rows: canonicalRows, dropped: canonicalDropped } = canonicalizeRows(
    built.rows,
    alias,
  );
  // dateless events cannot be windowed or holdout-split (a NaN date crashes
  // toISOString), so drop them before anything else consumes the rows
  const rows = canonicalRows.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.date));
  if (rows.length < 100)
    throw new Error(
      `corpus no longer maps: ${rows.length} of ${built.rows.length} lists survive canonicalization with a valid date (need ≥ 100)`,
    );

  // newest events are the holdout (recency-capped — see selectHoldoutEvents)
  const events = [...new Set(rows.map((r) => r.eventId))];
  const eventDate = new Map(
    events.map((e) => [e, rows.find((r) => r.eventId === e)!.date]),
  );
  const holdoutEvents = selectHoldoutEvents(
    events.map((id) => ({ id, date: eventDate.get(id)! })),
  );
  const trainRows = rows.filter((r) => !holdoutEvents.has(r.eventId));
  const holdout = rows.filter((r) => holdoutEvents.has(r.eventId));

  // ---- calibration capability (rolling window, shrunk cluster means) ----
  const { calibration, maeModel, maeBaseline } = calibrate({
    trainRows,
    holdout,
    cardNames,
    cardInks,
    k: opts.k,
    seed: opts.seed,
    calibrationWindowDays: opts.calibrationWindowDays,
  });

  // ---- relations capability (SGNS + coherence gate) ----
  const { relations, textRefDecks } = relationsCapability({
    rows,
    holdout,
    cards: snap.cards,
    seed: opts.seed,
    recencyHalfLifeDays: opts.recencyHalfLifeDays,
  });

  // ---- interactions capability (pair-lift mining + temporal gate) ----
  const { interactions } = synergyCapability({
    rows,
    holdout,
    cards: snap.cards,
    seed: opts.seed,
  });

  // ---- encoder capability (content -> relation projection; needs relations) ----
  const { encoder } = encoderCapability({
    rows,
    cards: snap.cards,
    vectors: relations.vectors,
    // cards debuting after the holdout era are the eval set
    cutoffDate: holdout.reduce(
      (m, r) => (r.date < m ? r.date : m),
      '9999-12-31',
    ),
  });

  const dataThroughDate = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const sources: Record<string, number> = {};
  for (const r of rows) sources[r.source] = (sources[r.source] ?? 0) + 1;

  const model = assembleMetaModel({
    dataThroughDate,
    cardSchemaVersion: 1,
    sources,
    calibration,
    relations,
    interactions,
    encoder,
    // version '3': per-card popularity over the training split (holdout stays eval-only)
    popularity: cardPopularityMaps(trainRows),
  });

  const relationMetrics = relations.metrics;
  const calibrationPassed = calibration.passed;
  const interactionMetrics = interactions.metrics;
  const relationMargin =
    relationMetrics.random > 1e-9
      ? relationMetrics.value / relationMetrics.random
      : Infinity;
  const interactionMargin =
    interactionMetrics.random > 1e-9
      ? interactionMetrics.value / interactionMetrics.random
      : Infinity;
  const imputedNote =
    built.imputed > 0 ? ` · ${built.imputed} curve-imputed win rates` : '';
  const report =
    `training: ${rows.length} lists (${built.dropped} unmapped-filtered, ${canonicalDropped} canonicalization-dropped) ` +
    `from ${events.length} events · relations on all ${rows.length} + ${textRefDecks} text-ref decks, holdout ${holdout.length} (eval-only) · ` +
    `calibration MAE ${maeModel.toFixed(4)} vs baseline ${maeBaseline.toFixed(4)} → ` +
    `${calibrationPassed ? 'PASSED' : 'REJECTED'} · ` +
    `relations coherence ${relationMetrics.value.toFixed(4)} vs random ${relationMetrics.random.toFixed(4)} ` +
    `(margin ${Number.isFinite(relationMargin) ? relationMargin.toFixed(2) : '∞'}, threshold ${COHERENCE_THRESHOLD}) → ` +
    `${relationMetrics.passed ? 'PASSED' : 'REJECTED'} · ` +
    `interactions lift ${interactionMetrics.value.toFixed(4)} vs random ${interactionMetrics.random.toFixed(4)} ` +
    `(margin ${Number.isFinite(interactionMargin) ? interactionMargin.toFixed(2) : '∞'}, threshold ${interactionMetrics.threshold}, ${interactionMetrics.pairs} pairs) → ` +
    `${interactionMetrics.passed ? 'PASSED' : 'REJECTED'} · ` +
    `encoder cosine ${encoder.metrics.value.toFixed(4)} vs baseline ${encoder.metrics.random.toFixed(4)} ` +
    `(margin ${encoder.metrics.random > 1e-9 ? (encoder.metrics.value / encoder.metrics.random).toFixed(2) : '∞'}, threshold ${encoder.metrics.threshold}, ${encoder.metrics.evalCards} eval cards) → ` +
    `${encoder.metrics.passed && relations.passed ? 'PASSED' : 'REJECTED'}${imputedNote}`;

  await mkdir(outDir, { recursive: true });
  if (model) {
    await writeFile(
      path.join(outDir, 'meta-model.json'),
      JSON.stringify(model, null, 1),
    );
  } else {
    // a rejected run must not ship the previous artifact: emitModel reads
    // this exact file and would otherwise publish a stale model
    await rm(path.join(outDir, 'meta-model.json'), { force: true });
    await writeFile(
      path.join(outDir, 'rejected.json'),
      JSON.stringify(
        {
          report,
          gates: {
            calibration: calibration.metrics,
            relations: relations.metrics,
            interactions: interactions.metrics,
            encoder: encoder.metrics,
          },
        },
        null,
        1,
      ),
    );
  }
  return { model, report };
}

// CLI entry: npx tsx scripts/training/train.ts
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { model, report } = await train();
  console.log(report);
  if (model) {
    const caps = model.capabilities;
    console.log(
      `artifact written (relations ${caps.relations ? '✓' : '✗'}, calibration ${caps.calibration ? '✓' : '✗'}, interactions ${caps.interactions ? '✓' : '✗'}, encoder ${caps.encoder ? '✓' : '✗'}` +
        `${model.relations ? `, ${Object.keys(model.relations.vectors).length} card vectors` : ''}` +
        `${model.interactions ? `, ${Object.keys(model.interactions.partners).length} partner lists` : ''}` +
        `${model.encoder ? ', encoder weights' : ''})`,
    );
  } else {
    console.log('publication refused — no artifact emitted');
  }
}
