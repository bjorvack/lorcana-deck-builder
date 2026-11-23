/**
 * A/B verdict application + run report (learned-deck-generator, task 5.2;
 * design D6; spec learned-deck-completion "A/B gate before shipping").
 *
 * Reads the matched A/B report (learned-ab.ts), flips the gate flag in the
 * trained artifact (the ONLY field that changes — the weights are untouched),
 * and writes `public/data/generator.report.json`. On PASS the gate becomes
 * `{passed: true, verdict: 'SHIPPED', ciLow}` so smart mode may enable the
 * learned path; on FAIL it becomes `{passed: false, verdict: 'NOT_SHIPPED',
 * ciLow}` and the shipped suggest-fill path stays the default (honest
 * degradation, no silent enable).
 *
 * Determinism: the artifact is re-rendered through the trainer's
 * canonical serializer, so the verdict application is byte-stable and the
 * non-gate content is asserted identical to the trained artifact.
 *
 * Usage:
 *   npx tsx scripts/training/generator/verdict.ts \
 *     [--ab <learned-ab.json>] [--corpus <corpus.json>] \
 *     [--artifact public/data/generator-model.json] \
 *     [--report-out public/data/generator.report.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Corpus, CorpusStratum } from './corpus';
import { STRATUM_ORDER } from './corpus';
import {
  DEFAULT_MODEL_OUT_PATH,
  type GeneratorModelArtifact,
  loadCorpusArtifact,
  MAX_ARTIFACT_BYTES,
  renderArtifact,
} from './train';

export const DEFAULT_AB_REPORT_PATH = resolve(
  import.meta.dirname,
  '..',
  'data',
  'generator',
  'learned-ab-6de59de1.json',
);
export const DEFAULT_CORPUS_PATH = resolve(
  import.meta.dirname,
  '..',
  'data',
  'generator',
  'corpus-6de59de1-20261123.json',
);
export const DEFAULT_REPORT_OUT = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'public',
  'data',
  'generator.report.json',
);
/** the interim (masked-elites-only) holdout accuracy this run is compared to */
export const INTERIM_HOLDOUT_ACCURACY = 0.5536;

export interface LearnedAbReport {
  gate: string;
  engineCommit: string;
  referee: string;
  gamesPerMember: number;
  pairCount: number;
  seeds: Record<string, unknown>;
  pairs: Array<{
    pairIndex: number;
    regime: string;
    learnedWins: number;
    learnedGames: number;
    shippedWins: number;
    shippedGames: number;
    identical: boolean;
    illegalReasons: string[];
  }>;
  perRegime: Array<{
    regime: string;
    pairs: number;
    learned: { wins: number; games: number };
    shipped: { wins: number; games: number };
    uplift: number;
    ciLow: number;
    ciHigh: number;
  }>;
  aggregate: { uplift: number; ciLow: number; ciHigh: number };
  illegalDecks: number;
  verdict: { passed: boolean; verdict: string; ciLow: number; reason: string };
}

export interface VerdictArgs {
  abPath: string;
  corpusPath: string;
  artifactPath: string;
  reportOutPath: string;
}

export function parseVerdictArgs(argv: string[]): VerdictArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    abPath: get('--ab') ? resolve(get('--ab')!) : DEFAULT_AB_REPORT_PATH,
    corpusPath: get('--corpus')
      ? resolve(get('--corpus')!)
      : DEFAULT_CORPUS_PATH,
    artifactPath: get('--artifact')
      ? resolve(get('--artifact')!)
      : DEFAULT_MODEL_OUT_PATH,
    reportOutPath: get('--report-out')
      ? resolve(get('--report-out')!)
      : DEFAULT_REPORT_OUT,
  };
}

/** per-stratum pair counts straight from the corpus artifact */
export function corpusComposition(corpus: Corpus): {
  pairs: number;
  strata: Record<CorpusStratum, number>;
  holdoutPairs: number;
} {
  const strata = Object.fromEntries(
    STRATUM_ORDER.map((stratum) => [stratum, 0]),
  ) as Record<CorpusStratum, number>;
  const holdoutKeys = new Set(corpus.holdoutCellKeys);
  let holdoutPairs = 0;
  for (const pair of corpus.pairs) {
    strata[pair.stratum]++;
    if (holdoutKeys.has(pair.cellKey)) holdoutPairs++;
  }
  return { pairs: corpus.pairs.length, strata, holdoutPairs };
}

/**
 * Apply the A/B verdict to the trained artifact: only the gate block may
 * change. Returns the re-rendered artifact JSON plus an otherness assertion
 * result (throws on any non-gate drift).
 */
export function applyGate(
  artifact: GeneratorModelArtifact,
  verdict: LearnedAbReport['verdict'],
): string {
  const before = renderArtifact(artifact);
  const gated: GeneratorModelArtifact = {
    ...artifact,
    gate: {
      passed: verdict.passed,
      verdict: verdict.passed ? 'SHIPPED' : 'NOT_SHIPPED',
      ciLow: verdict.ciLow,
    },
  };
  const after = renderArtifact(gated);
  // non-gate content must be byte-identical: strip the gate blocks and compare
  const strip = (json: string): string =>
    json.replace(/"gate":\s*\{[^{}]*\}/, '"gate":"<gate>"');
  if (strip(before) !== strip(after)) {
    throw new Error(
      'verdict application changed non-gate artifact content — refusing to write',
    );
  }
  return after;
}

export async function runVerdictCli(args: VerdictArgs): Promise<void> {
  const ab = JSON.parse(readFileSync(args.abPath, 'utf8')) as LearnedAbReport;
  const corpus = loadCorpusArtifact(args.corpusPath);
  const artifact = JSON.parse(
    readFileSync(args.artifactPath, 'utf8'),
  ) as GeneratorModelArtifact;
  if (artifact.gate.verdict !== 'PENDING') {
    throw new Error(
      `artifact gate is ${artifact.gate.verdict}, expected PENDING — retrain before applying a verdict`,
    );
  }
  const composition = corpusComposition(corpus);
  const slicePairs = composition.strata['pool-slice'];
  const sliceShare = slicePairs / composition.pairs;
  const gatedJson = applyGate(artifact, ab.verdict);
  writeFileSync(args.artifactPath, gatedJson);
  const bytes = Buffer.byteLength(gatedJson);

  const report = {
    report: 'learned-deck-completion (learned-deck-generator, tasks 5.1/5.2)',
    date: new Date().toISOString().slice(0, 10),
    engineCommit: ab.engineCommit,
    corpus: {
      path: args.corpusPath,
      pairs: composition.pairs,
      strata: composition.strata,
      holdoutPairs: composition.holdoutPairs,
      holdoutDeckExact: true,
      poolSlice: {
        pairs: slicePairs,
        share: Math.round(sliceShare * 1e6) / 1e6,
        cap: 0.25,
        withinCap: sliceShare <= 0.25,
        capRule:
          'recomputed against the FINAL corpus; over-cap drops lowest-fitness slice decks first (slices-6de59de1.json capResult: 3 decks × 42 pairs dropped)',
      },
      poolCoverage: {
        shareSeen: 1,
        source:
          'coverage-6de59de1.json (task 1.6 sweep; unchanged by the slice integration)',
      },
    },
    training: {
      artifactPath: args.artifactPath,
      bytes,
      budget: MAX_ARTIFACT_BYTES,
      withinBudget: bytes <= MAX_ARTIFACT_BYTES,
      featureSchemaVersion: artifact.featureSchemaVersion,
      seed: artifact.seed,
      hyper: artifact.evidence.hyper,
      epochs: artifact.evidence.epochs,
      bestEpoch: artifact.evidence.bestEpoch,
      trainLoss: artifact.evidence.trainLoss,
      trainAccuracy: artifact.evidence.trainAccuracy,
      holdoutLoss: artifact.evidence.holdoutLoss,
      holdoutAccuracy: artifact.evidence.holdoutAccuracy,
      strata: artifact.evidence.strata,
      d2aWeighting:
        'substitution pairs weight the loss by the measured |Δ| (Δ>0 → cardIn positive at weight Δ; Δ<0 → cardOut positive and cardIn negative at weight |Δ|); |Δ| < 0.02 (M3 noise floor) skipped',
      skippedBelowNoiseFloor:
        artifact.evidence.strata['substitution-delta'].skipped,
      coverageTrainWeight: 0.3,
      determinism: 'byte-identical re-run asserted (same corpus + seed)',
      interimComparison: {
        interimHoldoutAccuracy: INTERIM_HOLDOUT_ACCURACY,
        finalHoldoutAccuracy: artifact.evidence.holdoutAccuracy,
        note: 'interim artifact trained masked-elites-only; the final run trains all five strata under the D2a scheme',
      },
    },
    ab: {
      reportPath: args.abPath,
      referee: ab.referee,
      gamesPerMember: ab.gamesPerMember,
      pairCount: ab.pairCount,
      perRegime: ab.perRegime,
      aggregate: ab.aggregate,
      illegalDecks: ab.illegalDecks,
      identicalDeckPairs: ab.pairs.filter((pair) => pair.identical).length,
      seeds: ab.seeds,
      passRule:
        'aggregate uplift win-rate 95% bootstrap CI low > 0 with zero illegal decks (cluster bootstrap over deck-pairs)',
    },
    verdict: ab.verdict,
    caveat:
      'Simulator validity only: the gate measures learned-vs-shipped fill under the heuristic referee against the self-play league. It is not evidence about the real tournament meta (engine meta ≠ real meta). A SHIPPED verdict under the heuristic referee is bound by the same referee caveat recorded for acceptance.',
  };
  writeFileSync(args.reportOutPath, `${JSON.stringify(report, null, 1)}\n`);
  console.log(
    JSON.stringify(
      {
        artifact: args.artifactPath,
        gate: ab.verdict,
        report: args.reportOutPath,
        bytes,
      },
      null,
      1,
    ),
  );
}

async function main(): Promise<void> {
  await runVerdictCli(parseVerdictArgs(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
