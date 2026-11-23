/**
 * Trainer + artifact emitter for the learned deck generator
 * (learned-deck-generator, task 3.2; design D2/D3; spec
 * learned-deck-completion "Quantized model artifact").
 *
 * Loads the committed corpus artifact (no corpus rebuild — the corpus CLI
 * owns that file), trains the DeepSets model with holdout early stopping,
 * and emits the int16-quantized `public/data/generator-model.json` with the
 * gate flag left `PENDING/false`: task 5.2's A/B verdict is the only writer
 * of `PASS`/`FAIL`.
 *
 * The final all-strata run (task 5.x) trains every stratum: imitation pairs
 * (masked-elites, restricted, pool-slice) at weight 1, coverage pairs at
 * COVERAGE_TRAIN_WEIGHT (0.3), and substitution-delta pairs under D2a
 * advantage weighting (Δ > 0 → cardIn positive at weight Δ; Δ < 0 → cardIn
 * negative at weight |Δ|; |Δ| < 0.02 below the noise floor → skipped).
 *
 * Resume contract (AGENTS.md): this CLI needs no checkpoint — a full
 * deterministic retrain from the committed corpus artifact is seconds-cheap
 * and byte-identical (asserted by test), so re-invoking with the same flags
 * continues by simply re-running; the artifact itself is the checkpoint.
 *
 * Budget: ≤ 100 KB raw (D3). The weights dominate and are fixed-size, so the
 * budget is corpus-independent; the CLI refuses to emit an over-budget file.
 *
 * Usage:
 *   npx tsx scripts/training/generator/train.ts \
 *     --corpus scripts/training/data/generator/corpus-<commit>-<seed>.json \
 *     [--out public/data/generator-model.json] [--seed 20261123]
 *     [--lr 0.5] [--l2 1e-4] [--epochs 400] [--eval-every 5] [--patience 8]
 *     [--negatives 16]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, Format } from '../../../src/data/types';
import {
  type Corpus,
  type CorpusPair,
  type CorpusStratum,
  STRATUM_ORDER,
  stableStringify,
} from './corpus';
import { cardFeatures, FEATURE_DIM, FEATURE_SCHEMA_VERSION } from './features';
import {
  DEFAULT_NEGATIVES_PER_PAIR,
  DEFAULT_TRAIN_SEED,
  ENCODER_HIDDEN,
  type ExampleContext,
  examplesFromCorpus,
  PARAM_COUNT,
  POOL_DIM,
  type QuantizedWeights,
  quantizeModel,
  SCORER_HIDDEN,
  SCORER_INPUT_DIM,
  type TrainOptions,
  trainModel,
} from './model';

export const GENERATOR_MODEL_FORMAT = 'generator-model';
/** raw (uncompressed) artifact budget, D3 */
export const MAX_ARTIFACT_BYTES = 100 * 1024;
export const DEFAULT_MODEL_OUT_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'public',
  'data',
  'generator-model.json',
);

export interface GeneratorArch {
  description: string;
  inputDim: number;
  encoderHidden: number;
  poolDim: number;
  scorerInputDim: number;
  scorerHidden: number;
  params: number;
}

export interface StratumEvidence {
  pairs: number;
  trained: number;
  holdout: number;
  skipped: number;
}

export interface TrainingEvidence {
  /** total corpus pairs */
  pairs: number;
  /** pairs the trainer fit on (imitation pairs outside the holdout) */
  pairsTrained: number;
  /** holdout pairs driving early stopping (never fit on) */
  pairsHoldout: number;
  strata: Record<CorpusStratum, StratumEvidence>;
  epochs: number;
  bestEpoch: number;
  trainLoss: number;
  trainAccuracy: number;
  holdoutLoss: number;
  holdoutAccuracy: number;
  hyper: {
    lr: number;
    l2: number;
    maxEpochs: number;
    evalEvery: number;
    patience: number;
    negativesPerPair: number;
    seed: number;
  };
}

/**
 * The A/B verdict (task 5.2) is the only writer of SHIPPED/NOT_SHIPPED; the
 * trainer always ships `PENDING/false` so the runtime stays on the shipped
 * path until the gate evidence exists.
 */
export interface GeneratorGate {
  passed: boolean;
  verdict: 'PENDING' | 'SHIPPED' | 'NOT_SHIPPED';
  ciLow: number | null;
}

export interface GeneratorModelArtifact {
  format: typeof GENERATOR_MODEL_FORMAT;
  featureSchemaVersion: number;
  arch: GeneratorArch;
  weights: QuantizedWeights;
  evidence: TrainingEvidence;
  gate: GeneratorGate;
  trainedOn: { corpus: string; format: Format };
  seed: number;
}

// ---- corpus artifact loading ----

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (count) => typeof count === 'number' && Number.isInteger(count),
  );
}

function assertPairShape(pair: CorpusPair, index: number): void {
  const where = `pair[${index}] (${String(pair.stratum)})`;
  if (!STRATUM_ORDER.includes(pair.stratum)) {
    throw new Error(`${where}: unknown stratum`);
  }
  if (typeof pair.deckId !== 'string' || typeof pair.cellKey !== 'string') {
    throw new Error(`${where}: missing deckId/cellKey`);
  }
  if (pair.stratum === 'substitution-delta') {
    if (
      !isRecordOfNumbers(pair.context) ||
      typeof pair.cardOut !== 'string' ||
      typeof pair.cardIn !== 'string' ||
      !Number.isFinite(pair.delta)
    ) {
      throw new Error(`${where}: malformed substitution-delta pair`);
    }
    return;
  }
  if (
    (pair.stratum === 'restricted' || pair.stratum === 'pool-slice') &&
    typeof (pair as { condition?: unknown }).condition !== 'string'
  ) {
    throw new Error(`${where}: conditioned pairs need a condition label`);
  }
  if (!isRecordOfNumbers(pair.seed) || !isRecordOfNumbers(pair.target)) {
    throw new Error(`${where}: imitation pairs need seed/target records`);
  }
}

/** load + validate the committed corpus artifact the trainer consumes */
export function loadCorpusArtifact(
  filePath: string,
): Corpus & { format: Format } {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Corpus;
  if (
    typeof raw.format !== 'string' ||
    (raw.format !== 'core' && raw.format !== 'infinity') ||
    !Array.isArray(raw.pairs) ||
    !Array.isArray(raw.holdoutCellKeys)
  ) {
    throw new Error(`${filePath} is not a valid corpus artifact`);
  }
  if (raw.featureSchemaVersion !== FEATURE_SCHEMA_VERSION) {
    throw new Error(
      `${filePath}: feature schema ${raw.featureSchemaVersion} ≠ trainer schema ${FEATURE_SCHEMA_VERSION} — rebuild the corpus first`,
    );
  }
  for (const [index, pair] of raw.pairs.entries()) {
    assertPairShape(pair, index);
  }
  return { ...raw, format: raw.format };
}

// ---- card catalog (local loader — the root-tsconfig rule forbids importing
// scripts/training/arena, so this mirrors arena/cards.ts structurally) ----

export interface Catalog {
  byId: Map<number, Card>;
  featuresById: Map<number, Float64Array>;
  /** every committed card id, sorted — the negative-sampling universe */
  poolIds: number[];
}

export function loadCatalog(cardsPath?: string): Catalog {
  const path =
    cardsPath ??
    resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'public',
      'data',
      'cards.min.json',
    );
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as
    | { cards?: Card[] }
    | Card[];
  const cards = Array.isArray(snapshot) ? snapshot : (snapshot.cards ?? []);
  if (cards.length === 0) {
    throw new Error(`${path} is empty; run npm run data:build`);
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  const featuresById = new Map(
    cards.map((card) => [card.id, cardFeatures(card)]),
  );
  return {
    byId,
    featuresById,
    poolIds: [...byId.keys()].sort((a, b) => a - b),
  };
}

// ---- training + artifact assembly ----

export interface TrainFromCorpusOptions extends TrainOptions {
  negativesPerPair?: number;
}

/**
 * Train on a loaded corpus and assemble the artifact (pure — no filesystem
 * access). Deterministic end to end: equal inputs render byte-identical
 * artifacts.
 */
export function trainFromCorpus(
  corpus: Corpus,
  catalog: Catalog,
  corpusPath: string,
  opts: TrainFromCorpusOptions = {},
): GeneratorModelArtifact {
  if (corpus.format !== 'core' && corpus.format !== 'infinity') {
    throw new Error(`unsupported corpus format: ${String(corpus.format)}`);
  }
  const format = corpus.format as Format;
  const negativesPerPair = opts.negativesPerPair ?? DEFAULT_NEGATIVES_PER_PAIR;
  const seed = opts.seed ?? DEFAULT_TRAIN_SEED;
  const ctx: ExampleContext = {
    byId: catalog.byId,
    featuresById: catalog.featuresById,
    poolIds: catalog.poolIds,
    format,
    negativesPerPair,
  };
  const split = examplesFromCorpus(corpus, ctx, seed);
  const { model, evidence } = trainModel(split.train, split.holdout, {
    lr: opts.lr,
    l2: opts.l2,
    maxEpochs: opts.maxEpochs,
    evalEvery: opts.evalEvery,
    patience: opts.patience,
    seed,
  });
  return {
    format: GENERATOR_MODEL_FORMAT,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    arch: {
      description:
        'DeepSets: per-card encoder MLP 24→32→16 (tanh), copy-count-weighted masked mean pool over the seed deck, scorer MLP over [candidate features ⊕ pooled context] →16 (tanh) →1',
      inputDim: FEATURE_DIM,
      encoderHidden: ENCODER_HIDDEN,
      poolDim: POOL_DIM,
      scorerInputDim: SCORER_INPUT_DIM,
      scorerHidden: SCORER_HIDDEN,
      params: PARAM_COUNT,
    },
    weights: quantizeModel(model),
    evidence: {
      pairs: split.totalPairs,
      pairsTrained: split.train.length,
      pairsHoldout: split.holdout.length,
      strata: split.strata,
      epochs: evidence.epochsRun,
      bestEpoch: evidence.bestEpoch,
      trainLoss: evidence.trainLoss,
      trainAccuracy: evidence.trainAccuracy,
      holdoutLoss: evidence.holdoutLoss,
      holdoutAccuracy: evidence.holdoutAccuracy,
      hyper: {
        lr: evidence.hyper.lr,
        l2: evidence.hyper.l2,
        maxEpochs: evidence.hyper.maxEpochs,
        evalEvery: evidence.hyper.evalEvery,
        patience: evidence.hyper.patience,
        negativesPerPair,
        seed,
      },
    },
    gate: { passed: false, verdict: 'PENDING', ciLow: null },
    trainedOn: { corpus: basename(corpusPath), format },
    seed,
  };
}

/** canonical artifact serialization: key-sorted JSON + trailing newline */
export function renderArtifact(artifact: GeneratorModelArtifact): string {
  return `${stableStringify(artifact)}\n`;
}

// ---- CLI ----

interface TrainArgs {
  corpusPath: string;
  outPath: string;
  seed: number;
  lr: number;
  l2: number;
  maxEpochs: number;
  evalEvery: number;
  patience: number;
  negatives: number;
}

function parseArgs(argv: string[]): TrainArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const corpusPath = get('--corpus') ? resolve(get('--corpus')!) : '';
  if (!corpusPath) throw new Error('--corpus <corpus.json> is required');
  return {
    corpusPath,
    outPath: get('--out') ? resolve(get('--out')!) : DEFAULT_MODEL_OUT_PATH,
    seed: Number(get('--seed') ?? DEFAULT_TRAIN_SEED),
    lr: Number(get('--lr') ?? 0.5),
    l2: Number(get('--l2') ?? 1e-4),
    maxEpochs: Number(get('--epochs') ?? 400),
    evalEvery: Number(get('--eval-every') ?? 5),
    patience: Number(get('--patience') ?? 8),
    negatives: Number(get('--negatives') ?? DEFAULT_NEGATIVES_PER_PAIR),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpusArtifact(args.corpusPath);
  const catalog = loadCatalog();
  const artifact = trainFromCorpus(corpus, catalog, args.corpusPath, {
    seed: args.seed,
    lr: args.lr,
    l2: args.l2,
    maxEpochs: args.maxEpochs,
    evalEvery: args.evalEvery,
    patience: args.patience,
    negativesPerPair: args.negatives,
  });
  const json = renderArtifact(artifact);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `artifact over budget: ${bytes} raw bytes (max ${MAX_ARTIFACT_BYTES})`,
    );
  }
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, json);
  console.log(
    JSON.stringify(
      {
        artifact: args.outPath,
        bytes,
        budget: MAX_ARTIFACT_BYTES,
        pairs: artifact.evidence.pairs,
        pairsTrained: artifact.evidence.pairsTrained,
        pairsHoldout: artifact.evidence.pairsHoldout,
        strata: artifact.evidence.strata,
        epochs: artifact.evidence.epochs,
        bestEpoch: artifact.evidence.bestEpoch,
        trainLoss: artifact.evidence.trainLoss,
        trainAccuracy: artifact.evidence.trainAccuracy,
        holdoutLoss: artifact.evidence.holdoutLoss,
        holdoutAccuracy: artifact.evidence.holdoutAccuracy,
        gate: artifact.gate,
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
  void main();
}
