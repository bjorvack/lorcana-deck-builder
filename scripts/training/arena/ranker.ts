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
import { mulberry32 } from '../prng';
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
  myBoardStrength?: number;
  oppBoardStrength?: number;
  myBoardLore?: number;
  oppBoardLore?: number;
  myInk?: number;
  myHand?: number;
  myPlay?: number;
  oppPlay?: number;
  ranked: Array<{ f: string; e?: string; a?: string; d?: string }>;
  chosen: number;
}

interface TraceRecord {
  seed?: string;
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
  opts: {
    iterations?: number;
    lr?: number;
    l2?: number;
    /** AWR temperature: advantage = final lore margin / beta */
    beta?: number;
  } = {},
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
        myInk: move.myInk ?? 0,
        myHand: move.myHand ?? 0,
        myPlay: move.myPlay ?? 0,
        oppPlay: move.oppPlay ?? 0,
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

export interface MlpTrainingResult {
  kind: 'mlp';
  hidden: number;
  featureNames: readonly string[];
  /** flat W1: hidden x FEATURE_DIM, row-major */
  W1: number[];
  b1: number[];
  /** hidden-unit output weights */
  W2: number[];
  b2: number;
  decisions: number;
  games: number;
  /** best validation loss seen before early stopping */
  valLoss: number;
  iterationsRun: number;
  examples: number;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** labeled examples with game tags for the game-level validation split */
interface Example {
  f: Float64Array;
  y: number;
  wgt: number;
  game: number;
}

/**
 * Build labeled examples from traced decisions. The executed candidate is the
 * positive example, considered alternatives are negatives; when the acting
 * player's deck LOST, labels invert (the model learns what losers should have
 * avoided). Each example carries its game id for the validation split.
 */
export function buildExamples(
  records: TraceRecord[],
  resolveCard: (engineRef: string | undefined) => EngineCardShape | undefined,
): { rows: Example[]; decisions: number; games: number } {
  const rows: Example[] = [];
  let decisions = 0;
  let games = 0;
  for (const record of records) {
    if (!record.moves || record.moves.length === 0) continue;
    if (record.winner == null) continue;
    games += 1;
    const gameId =
      Number((record.seed ?? '').split('-').slice(0, 2).join('')) || games;
    for (const move of record.moves) {
      if (move.chosen < 0 || move.chosen >= move.ranked.length) continue;
      const won = record.winner === move.actor;
      const context = {
        turn: move.turn,
        myLore: move.myLore ?? 0,
        oppLore: move.oppLore ?? 0,
        myInk: move.myInk ?? 0,
        myHand: move.myHand ?? 0,
        myPlay: move.myPlay ?? 0,
        oppPlay: move.oppPlay ?? 0,
        myBoardStrength: move.myBoardStrength ?? 0,
        oppBoardStrength: move.oppBoardStrength ?? 0,
        myBoardLore: move.myBoardLore ?? 0,
        oppBoardLore: move.oppBoardLore ?? 0,
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
          wgt: 1,
          game: gameId,
        });
      });
      decisions += 1;
    }
  }
  return { rows, decisions, games };
}

/**
 * One-hidden-layer MLP (tanh -> sigmoid), full-batch gradient descent with
 * L2 and early stopping on a game-level validation split. Deterministic:
 * seeded init, fixed iteration order.
 */
export function trainMlp(
  rows: Example[],
  stats: { decisions: number; games: number },
  opts: {
    hidden?: number;
    iterations?: number;
    lr?: number;
    l2?: number;
    valEvery?: number;
    seed?: number;
  } = {},
): MlpTrainingResult {
  const hidden = opts.hidden ?? 32;
  const iterations = opts.iterations ?? 1200;
  const lr = opts.lr ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;
  const valEvery = opts.valEvery ?? 10;
  const rng = mulberry32(opts.seed ?? 20261121);

  // game-level validation split: games with even ids -> validation
  const gameIds = [...new Set(rows.map((r) => r.game))].sort((a, b) => a - b);
  const valGames = new Set(gameIds.filter((_, i) => i % 5 === 0));
  const train = rows.filter((r) => !valGames.has(r.game));
  const val = rows.filter((r) => valGames.has(r.game));

  const D = FEATURE_DIM;
  const W1 = new Float64Array(hidden * D);
  const b1 = new Float64Array(hidden);
  const W2 = new Float64Array(hidden);
  let b2 = 0;
  for (let h = 0; h < hidden; h++) {
    for (let i = 0; i < D; i++) W1[h * D + i] = (rng() * 2 - 1) * 0.3;
    W2[h] = (rng() * 2 - 1) * 0.3;
  }

  const forward = (f: Float64Array): { h: Float64Array; p: number } => {
    const h = new Float64Array(hidden);
    let z = b2;
    for (let u = 0; u < hidden; u++) {
      let a = b1[u]!;
      for (let i = 0; i < D; i++) a += W1[u * D + i]! * f[i]!;
      h[u] = Math.tanh(a);
      z += W2[u]! * h[u]!;
    }
    return { h, p: sigmoid(z) };
  };

  let best = {
    valLoss: Number.POSITIVE_INFINITY,
    W1: Float64Array.from(W1),
    b1: Float64Array.from(b1),
    W2: Float64Array.from(W2),
    b2,
  };
  let bestIter = 0;
  let iterationsRun = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const gW1 = new Float64Array(hidden * D);
    const gb1 = new Float64Array(hidden);
    const gW2 = new Float64Array(hidden);
    let gb2 = 0;
    for (const { f, y } of train) {
      const { h, p } = forward(f);
      const err = p - y;
      gb2 += err;
      for (let u = 0; u < hidden; u++) {
        gW2[u]! += err * h[u]!;
        const dh = err * W2[u]! * (1 - h[u]! * h[u]!);
        gb1[u]! += dh;
        for (let i = 0; i < D; i++) gW1[u * D + i]! += dh * f[i]!;
      }
    }
    for (let u = 0; u < hidden; u++) {
      for (let i = 0; i < D; i++)
        W1[u * D + i]! -=
          (lr / Math.max(1, train.length)) *
          (gW1[u * D + i]! + l2 * W1[u * D + i]!);
      b1[u]! -= (lr / Math.max(1, train.length)) * gb1[u]!;
      W2[u]! -= (lr / Math.max(1, train.length)) * (gW2[u]! + l2 * W2[u]!);
    }
    b2 -= (lr / Math.max(1, train.length)) * gb2;
    iterationsRun = iter + 1;
    if (iter % valEvery === valEvery - 1 || iter === iterations - 1) {
      let valLoss = 0;
      for (const { f, y } of val) {
        const { p } = forward(f);
        valLoss -=
          y * Math.log(Math.max(p, 1e-12)) +
          (1 - y) * Math.log(Math.max(1 - p, 1e-12));
      }
      const norm = valLoss / Math.max(1, val.length);
      if (norm < best.valLoss) {
        best = {
          valLoss: norm,
          W1: Float64Array.from(W1),
          b1: Float64Array.from(b1),
          W2: Float64Array.from(W2),
          b2,
        };
        bestIter = iter + 1;
      }
    }
    if (iter - bestIter >= 400) {
      iterationsRun = iter + 1;
      break;
    }
  }

  return {
    kind: 'mlp',
    hidden,
    featureNames: FEATURE_NAMES,
    W1: [...best.W1],
    b1: [...best.b1],
    W2: [...best.W2],
    b2: best.b2,
    decisions: stats.decisions,
    games: stats.games,
    valLoss: Math.round(best.valLoss * 10000) / 10000,
    iterationsRun,
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
  const model = get('--model') ?? 'linear';
  const out =
    get('--out') ??
    resolve(import.meta.dirname, '..', 'data', 'arena', 'ranker.json');

  if (model === 'mlp') {
    const { rows, decisions, games } = buildExamples(records, resolveCard);
    const mlp = trainMlp(
      rows,
      { decisions, games },
      {
        hidden: Number(get('--hidden') ?? 32),
        iterations: Number(get('--iterations') ?? 1200),
        lr: Number(get('--lr') ?? 0.5),
        l2: Number(get('--l2') ?? 1e-4),
        seed: Number(get('--seed') ?? 20261121),
      },
    );
    writeFileSync(
      out,
      `${JSON.stringify({ ...mlp, meta: { traces: traceArg } }, null, 1)}\n`,
    );
    console.log(
      JSON.stringify(
        {
          out,
          model,
          games: mlp.games,
          decisions: mlp.decisions,
          examples: mlp.examples,
          valLoss: mlp.valLoss,
          iterationsRun: mlp.iterationsRun,
        },
        null,
        1,
      ),
    );
    return;
  }

  const result = trainRanker(records, resolveCard, {
    iterations: Number(get('--iterations') ?? 400),
    lr: Number(get('--lr') ?? 0.5),
    l2: Number(get('--l2') ?? 1e-4),
    beta: Number(get('--beta') ?? 5),
  });
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(
    JSON.stringify(
      {
        out,
        model,
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
