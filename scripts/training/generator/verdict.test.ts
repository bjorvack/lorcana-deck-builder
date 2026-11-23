import { describe, expect, it } from 'vitest';
import type { Corpus } from './corpus';
import type { GeneratorModelArtifact } from './train';
import {
  applyGate,
  corpusComposition,
  type LearnedAbReport,
  parseVerdictArgs,
} from './verdict';

function fixtureCorpus(): Corpus {
  return {
    format: 'core',
    featureSchemaVersion: 1,
    pairs: [
      {
        stratum: 'masked-elites',
        deckId: 'a',
        cellKey: 'a',
        seed: { 100: 3 },
        target: { 102: 3 },
      },
      {
        stratum: 'pool-slice',
        deckId: 'pool-slice:0:a',
        cellKey: 'pool-slice:0:a',
        condition: 'pool-slice:0',
        seed: { 100: 3 },
        target: { 103: 3 },
      },
      {
        stratum: 'substitution-delta',
        deckId: 'a',
        cellKey: 'a',
        context: { 100: 2 },
        cardOut: '100',
        cardIn: '104',
        delta: 0.05,
      },
    ],
    holdoutCellKeys: ['pool-slice:0:a'],
  };
}

/** a representative artifact shape (weights need not be trained for this) */
function fixtureArtifact(): GeneratorModelArtifact {
  return {
    format: 'generator-model',
    featureSchemaVersion: 1,
    arch: {
      description: 'fixture',
      inputDim: 24,
      encoderHidden: 32,
      poolDim: 16,
      scorerInputDim: 40,
      scorerHidden: 16,
      params: 2001,
    },
    weights: {
      quantization: 'int16-le',
      tensors: {
        encW1: {
          shape: [32, 24],
          b64: Buffer.alloc(32 * 24 * 2).toString('base64'),
          scale: 0.001,
        },
        encB1: {
          shape: [32],
          b64: Buffer.alloc(32 * 2).toString('base64'),
          scale: 0.001,
        },
        encW2: {
          shape: [16, 32],
          b64: Buffer.alloc(16 * 32 * 2).toString('base64'),
          scale: 0.001,
        },
        encB2: {
          shape: [16],
          b64: Buffer.alloc(16 * 2).toString('base64'),
          scale: 0.001,
        },
        scorerW1: {
          shape: [16, 40],
          b64: Buffer.alloc(16 * 40 * 2).toString('base64'),
          scale: 0.001,
        },
        scorerB1: {
          shape: [16],
          b64: Buffer.alloc(16 * 2).toString('base64'),
          scale: 0.001,
        },
        scorerW2: {
          shape: [16],
          b64: Buffer.alloc(16 * 2).toString('base64'),
          scale: 0.001,
        },
        scorerB2: {
          shape: [1],
          b64: Buffer.alloc(1 * 2).toString('base64'),
          scale: 0.001,
        },
      },
    },
    evidence: {
      pairs: 3,
      pairsTrained: 2,
      pairsHoldout: 1,
      strata: {
        'masked-elites': { pairs: 1, trained: 1, holdout: 0, skipped: 0 },
        'substitution-delta': { pairs: 1, trained: 1, holdout: 0, skipped: 0 },
        restricted: { pairs: 0, trained: 0, holdout: 0, skipped: 0 },
        'pool-slice': { pairs: 1, trained: 0, holdout: 1, skipped: 0 },
        coverage: { pairs: 0, trained: 0, holdout: 0, skipped: 0 },
      },
      epochs: 10,
      bestEpoch: 10,
      trainLoss: 2.9,
      trainAccuracy: 0.5,
      holdoutLoss: 2.9,
      holdoutAccuracy: 0.5,
      hyper: {
        lr: 0.5,
        l2: 1e-4,
        maxEpochs: 10,
        evalEvery: 1,
        patience: 8,
        negativesPerPair: 16,
        seed: 20261123,
      },
    },
    gate: { passed: false, verdict: 'PENDING', ciLow: null },
    trainedOn: { corpus: 'corpus-fixture.json', format: 'core' },
    seed: 20261123,
  };
}

describe('corpus composition (task 5.2 report inputs)', () => {
  it('counts pairs per stratum and holdout pairs', () => {
    const composition = corpusComposition(fixtureCorpus());
    expect(composition.pairs).toBe(3);
    expect(composition.strata['masked-elites']).toBe(1);
    expect(composition.strata['pool-slice']).toBe(1);
    expect(composition.strata['substitution-delta']).toBe(1);
    expect(composition.strata.restricted).toBe(0);
    expect(composition.strata.coverage).toBe(0);
    expect(composition.holdoutPairs).toBe(1);
  });
});

describe('verdict application (only the gate block may change)', () => {
  it('flips PASS into a SHIPPED gate and keeps everything else identical', () => {
    const artifact = fixtureArtifact();
    const pass: LearnedAbReport['verdict'] = {
      passed: true,
      verdict: 'SHIPPED',
      ciLow: 0.013,
      reason: 'test',
    };
    const after = applyGate(artifact, pass);
    expect(after).toContain('"passed": true');
    expect(after).toContain('"verdict": "SHIPPED"');
    expect(after).toContain('"ciLow": 0.013');
    // weights + evidence untouched
    expect(after).toContain('"quantization": "int16-le"');
    const reparsed = JSON.parse(after);
    expect(reparsed.weights).toEqual(artifact.weights);
    expect(reparsed.evidence).toEqual(artifact.evidence);
  });

  it('records NOT_SHIPPED with the CI on fail', () => {
    const artifact = fixtureArtifact();
    const fail: LearnedAbReport['verdict'] = {
      passed: false,
      verdict: 'NOT_SHIPPED',
      ciLow: -0.004,
      reason: 'test',
    };
    const after = applyGate(artifact, fail);
    expect(after).toContain('"passed": false');
    expect(after).toContain('"verdict": "NOT_SHIPPED"');
    expect(after).toContain('"ciLow": -0.004');
  });

  it('keeps non-gate content through the gate application', () => {
    const artifact = fixtureArtifact();
    const fail: LearnedAbReport['verdict'] = {
      passed: false,
      verdict: 'NOT_SHIPPED',
      ciLow: 0,
      reason: 'test',
    };
    expect(() => applyGate(artifact, fail)).not.toThrow();
    const reparsed = JSON.parse(applyGate(artifact, fail));
    expect(reparsed.evidence.epochs).toBe(10);
    expect(reparsed.trainedOn).toEqual(artifact.trainedOn);
  });
});

describe('verdict CLI args', () => {
  it('defaults to the committed artifact and report paths', () => {
    const args = parseVerdictArgs([]);
    expect(args.artifactPath).toMatch(/generator-model\.json$/);
    expect(args.reportOutPath).toMatch(/generator\.report\.json$/);
    expect(args.abPath).toMatch(/learned-ab-6de59de1\.json$/);
    expect(args.corpusPath).toMatch(/corpus-6de59de1-20261123\.json$/);
  });
});
