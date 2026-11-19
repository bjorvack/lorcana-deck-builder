import type { Ink } from '../../src/data/types';
import { kmeans, logisticRegression, nameArchetype, sqDist } from './learning';
import type { Archetype, CalibrationOutput, TrainRow } from './model-types';
import { round4 } from './model-types';

const K = 32;
const SHRINKAGE_K = 25;
const CALIBRATION_WINDOW_DAYS = 90;
const MIN_CALIBRATION_ROWS = 100;

export interface CalibrateInput {
  trainRows: TrainRow[];
  holdout: TrainRow[];
  cardNames: Map<number, string>;
  cardInks: Map<number, Ink[]>;
  k?: number;
  seed?: number;
  calibrationWindowDays?: number;
}

/** calibration capability (rolling window, shrunk cluster means) */
export function calibrate(input: CalibrateInput): {
  calibration: CalibrationOutput;
  maeModel: number;
  maeBaseline: number;
} {
  const { trainRows, holdout, cardNames, cardInks } = input;
  const opts = {
    k: input.k,
    seed: input.seed,
    calibrationWindowDays: input.calibrationWindowDays,
  };
  // ---- calibration capability (rolling window, shrunk cluster means) ----
  const maxTrainDate = trainRows.reduce(
    (m, r) => (r.date > m ? r.date : m),
    '',
  );
  const windowDays = opts.calibrationWindowDays ?? CALIBRATION_WINDOW_DAYS;
  const windowCutoff = Date.parse(maxTrainDate) - windowDays * 86_400_000;
  const windowed =
    windowDays > 0
      ? trainRows.filter((r) => Date.parse(r.date) >= windowCutoff)
      : trainRows;
  // a too-thin window is worse than a stale one — fall back to the full split
  const calibrationRows =
    windowed.length >= MIN_CALIBRATION_ROWS ? windowed : trainRows;

  const trainVecs = calibrationRows.map((r) => r.vec);
  const assign = kmeans(trainVecs, opts.k ?? K, opts.seed ?? 42);

  // corpus-mean share per card over the clustered population — the lift
  // denominator for archetype naming
  const corpusShare = new Map<number, number>();
  for (const r of calibrationRows) {
    for (const [d, v] of r.vec)
      corpusShare.set(
        d,
        (corpusShare.get(d) ?? 0) + v / calibrationRows.length,
      );
  }

  const clusters = new Map<number, { rows: TrainRow[] }>();
  calibrationRows.forEach((r, i) => {
    const ci = assign[i]!;
    (clusters.get(ci) ?? clusters.set(ci, { rows: [] }).get(ci)!).rows.push(r);
  });

  const windowMean =
    calibrationRows.reduce((s, r) => s + r.winRate, 0) / calibrationRows.length;
  const archetypeList = [...clusters.entries()].map(
    ([ci, { rows: members }]) => {
      const rawMean =
        members.reduce((s, r) => s + r.winRate, 0) / members.length;
      // shrinkage: small clusters regress toward the window mean instead of
      // shipping noisy win-rate estimates
      const observedWinRate =
        (members.length * rawMean + SHRINKAGE_K * windowMean) /
        (members.length + SHRINKAGE_K);
      // centroid = mean vector
      const centroid = new Map<number, number>();
      for (const r of members)
        for (const [d, v] of r.vec)
          centroid.set(d, (centroid.get(d) ?? 0) + v / members.length);
      return { ci, observedWinRate, sampleSize: members.length, centroid };
    },
  );
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

  const weights = logisticRegression(
    calibrationRows.map((r) => ({ vec: r.vec, y: r.topCut ? 1 : 0 })),
  );

  const globalMean =
    trainRows.reduce((s, r) => s + r.winRate, 0) / trainRows.length;
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
      centroid: Object.fromEntries(
        [...a.centroid].map(([d, v]) => [
          String(d),
          Math.round(v * 1000) / 1000,
        ]),
      ),
    }));

  const calibration: CalibrationOutput = {
    passed: calibrationPassed,
    archetypes,
    cardWeights: Object.fromEntries(
      [...weights].map(([d, w]) => [String(d), Math.round(w * 1000) / 1000]),
    ),
    metrics: {
      metric: 'holdout_winrate_mae',
      value: round4(maeModel),
      baseline: round4(maeBaseline),
      passed: calibrationPassed,
      holdoutDecks: holdout.length,
    },
  };
  return { calibration, maeModel, maeBaseline };
}
