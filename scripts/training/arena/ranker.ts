/**
 * M4 trainer: outcome-supervised logistic regression over traced decisions.
 *
 * Input: JSONL game records with `moves` traces (play.ts --trace). Each traced
 * decision contributes labeled candidates: the executed candidate is the
 * positive example and the considered alternatives are negatives. When the
 * acting player's deck LOST, the labels invert — the model learns "features
 * of cards winners pick, and features of cards losers should have picked".
 *
 * Full-batch gradient descent, deterministic — no randomness anywhere.
 *
 * Usage:
 *   npx tsx scripts/training/arena/ranker.ts --traces <file.jsonl[,more]> \
 *     [--iterations 400] [--lr 0.5] [--l2 0.0001] [--out <path>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from '../../../src/data/types';
import { buildCanonicalRegistry } from '../canonical';
import {
  candidateFeatures,
  FEATURE_DIM,
  FEATURE_NAMES,
} from './candidate-features';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';

interface TraceMove {
  turn: number;
  actor: string;
  myLore?: number;
  oppLore?: number;
  ranked: Array<{ f: string; e?: string; a?: string; d?: string }>;
  chosen: number;
}

interface TraceRecord {
  winner?: string | null;
  moves?: TraceMove[];
}

interface EngineCardShape {
  cost?: number;
  lore?: number;
  strength?: number;
  willpower?: number;
  inkable?: boolean;
  cardType?: string;
}

export interface TrainingResult {
  weights: number[];
  featureNames: readonly string[];
  /** traced decisions contributing examples */
  decisions: number;
  games: number;
  /** final mean logistic loss over the training set */
  loss: number;
  /** examples after label expansion (chosen + alternatives) */
  examples: number;
}

/** resolve a traced engine card ref (instance id) to our catalog fields */
export function buildResolver(
  engineById: Record<string, EngineCardShape>,
  cardMap: { byIdentity: Record<string, { engineId: string }> },
  cards: Card[],
): (engineRef: string | undefined) => EngineCardShape | undefined {
  const identityByEngine = new Map<string, number>();
  for (const [identity, entry] of Object.entries(cardMap.byIdentity))
    identityByEngine.set(entry.engineId, Number(identity));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const cache = new Map<string, EngineCardShape | undefined>();
  return (engineRef) => {
    if (!engineRef) return undefined;
    if (cache.has(engineRef)) return cache.get(engineRef);
    // instance ids are "<owner>-<idx>-<publicId>"; recover the public id
    const parts = engineRef.split('-');
    const publicId =
      parts.length >= 3 && (parts[0] === 'p1' || parts[0] === 'p2')
        ? parts.slice(2).join('-')
        : engineRef;
    const identity = identityByEngine.get(publicId);
    const card = identity !== undefined ? cardById.get(identity) : undefined;
    const resolved: EngineCardShape | undefined = card
      ? {
          cost: card.cost,
          lore: card.lore,
          strength: card.strength,
          willpower: card.willpower,
          inkable: card.inkwell,
          cardType: card.type,
        }
      : engineById[publicId];
    cache.set(engineRef, resolved);
    return resolved;
  };
}

export function trainRanker(
  records: TraceRecord[],
  resolveCard: (engineRef: string | undefined) => EngineCardShape | undefined,
  opts: { iterations?: number; lr?: number; l2?: number } = {},
): TrainingResult {
  const iterations = opts.iterations ?? 400;
  const lr = opts.lr ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;

  const rows: Array<{ f: Float64Array; y: number }> = [];
  let decisions = 0;
  let games = 0;
  for (const record of records) {
    if (!record.moves || record.moves.length === 0) continue;
    games += 1;
    const winner = record.winner;
    if (winner == null) continue;
    for (const move of record.moves) {
      if (move.chosen < 0 || move.chosen >= move.ranked.length) continue;
      // label inversion: choices from losing games become anti-examples
      const won = winner === move.actor;
      const context = {
        turn: move.turn,
        myLore: move.myLore ?? 0,
        oppLore: move.oppLore ?? 0,
      };
      move.ranked.forEach((entry, index) => {
        const engineRef = entry.e ?? entry.a;
        const resolved = resolveCard(engineRef);
        const features = candidateFeatures(
          {
            family: entry.f,
            cardId: resolved ? engineRef : undefined,
            attackerId: entry.a,
            defenderId: entry.d,
          },
          { ...context, resolveCard: () => resolved },
        );
        const positive = index === move.chosen;
        rows.push({
          f: features,
          y: won ? (positive ? 1 : 0) : positive ? 0 : 1,
        });
      });
      decisions += 1;
    }
  }
  if (rows.length === 0)
    return {
      weights: new Array<number>(FEATURE_DIM).fill(0),
      featureNames: FEATURE_NAMES,
      decisions: 0,
      games,
      loss: Number.NaN,
      examples: 0,
    };

  // ---- full-batch gradient descent, deterministic ----
  const weights = new Float64Array(FEATURE_DIM);
  let loss = Number.NaN;
  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Float64Array(FEATURE_DIM);
    let totalLoss = 0;
    for (const { f, y } of rows) {
      let z = 0;
      for (let i = 0; i < FEATURE_DIM; i++) z += weights[i]! * f[i]!;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y;
      totalLoss -=
        y * Math.log(Math.max(p, 1e-12)) +
        (1 - y) * Math.log(Math.max(1 - p, 1e-12));
      for (let i = 0; i < FEATURE_DIM; i++) grad[i] += err * f[i]!;
    }
    for (let i = 0; i < FEATURE_DIM; i++)
      weights[i] -= (lr / rows.length) * (grad[i]! + l2 * weights[i]!);
    loss = totalLoss / rows.length;
  }

  return {
    weights: [...weights],
    featureNames: FEATURE_NAMES,
    decisions,
    games,
    loss: Math.round(loss * 10000) / 10000,
    examples: rows.length,
  };
}

export function loadTraces(paths: string[]): TraceRecord[] {
  const records: TraceRecord[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`trace file missing: ${path}`);
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line) as TraceRecord);
    }
  }
  return records;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const traceArg = get('--traces');
  if (!traceArg) throw new Error('--traces <file.jsonl[,more]> is required');
  const cards = loadCards();
  const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
  const catalog = await loadEngineCatalog();
  const cardMap = buildCardMap({
    cards,
    alias,
    canonicalByGroup,
    engineById: catalog.byId,
    engineCommit: catalog.engineCommit,
  });
  const resolveCard = buildResolver(
    catalog.byId as unknown as Record<string, EngineCardShape>,
    cardMap,
    cards,
  );
  const records = loadTraces(traceArg.split(',').map((p) => resolve(p.trim())));
  const result = trainRanker(records, resolveCard, {
    iterations: Number(get('--iterations') ?? 400),
    lr: Number(get('--lr') ?? 0.5),
    l2: Number(get('--l2') ?? 1e-4),
  });
  const out =
    get('--out') ??
    resolve(import.meta.dirname, '..', 'data', 'arena', 'ranker.json');
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(
    JSON.stringify(
      {
        out,
        games: result.games,
        decisions: result.decisions,
        examples: result.examples,
        loss: result.loss,
        topWeights: result.weights
          .map((w, i) => ({
            feature: FEATURE_NAMES[i],
            w: Math.round(w * 1000) / 1000,
          }))
          .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
          .slice(0, 6),
      },
      null,
      1,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
