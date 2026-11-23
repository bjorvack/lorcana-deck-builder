import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Corpus } from './corpus';
import { dequantizeModel, type SeedCard, scoreCandidates } from './model';
import {
  type Catalog,
  type GeneratorModelArtifact,
  loadCatalog,
  loadCorpusArtifact,
  MAX_ARTIFACT_BYTES,
  renderArtifact,
  trainFromCorpus,
} from './train';

/** fixture corpus over real committed cards, loaded from the live catalog */
function fixtureCorpus(catalog: Catalog): Corpus {
  const ids = [...catalog.byId.keys()].slice(0, 24);
  const deck = (base: number): Record<string, number> =>
    Object.fromEntries(ids.slice(base, base + 9).map((id) => [String(id), 3]));
  const full = (base: number): Record<string, number> => {
    const entries = Object.entries(deck(base));
    return Object.fromEntries(entries.slice(0, 3)); // the masked region
  };
  const minus = (base: number): Record<string, number> => {
    const entries = Object.entries(deck(base));
    return Object.fromEntries(entries.slice(3)); // deck minus region
  };
  return {
    format: 'core',
    featureSchemaVersion: 1,
    pairs: [
      {
        stratum: 'masked-elites',
        deckId: 'archive:1:cell-a',
        cellKey: 'cell-a',
        seed: minus(0),
        target: full(0),
      },
      {
        stratum: 'masked-elites',
        deckId: 'archive:1:cell-a',
        cellKey: 'cell-a',
        seed: minus(0),
        target: full(9),
      },
      {
        stratum: 'masked-elites',
        deckId: 'archive:1:cell-b',
        cellKey: 'cell-b',
        seed: minus(9),
        target: full(9),
      },
      {
        stratum: 'substitution-delta',
        deckId: 'archive:1:cell-a',
        cellKey: 'cell-a',
        context: minus(0),
        cardOut: String(ids[3]),
        cardIn: String(ids[2]), // a core-legal fixture card
        delta: 0.04,
      },
    ],
    holdoutCellKeys: ['cell-b'],
  };
}

const catalog = loadCatalog();
const corpus = fixtureCorpus(catalog);
const artifact = trainFromCorpus(corpus, catalog, 'corpus-fixture.json', {
  seed: 20261123,
  maxEpochs: 6,
  evalEvery: 2,
  patience: 2,
  negativesPerPair: 4,
});

describe('artifact contract (task 3.2)', () => {
  it('carries format, schema, arch, gate and provenance', () => {
    expect(artifact.format).toBe('generator-model');
    expect(artifact.featureSchemaVersion).toBe(1);
    expect(artifact.arch).toMatchObject({
      inputDim: 24,
      encoderHidden: 32,
      poolDim: 16,
      scorerInputDim: 40,
      scorerHidden: 16,
      params: 2001,
    });
    // the gate is PENDING until task 5.2's A/B verdict flips it
    expect(artifact.gate).toEqual({
      passed: false,
      verdict: 'PENDING',
      ciLow: null,
    });
    expect(artifact.trainedOn).toEqual({
      corpus: 'corpus-fixture.json',
      format: 'core',
    });
    expect(artifact.seed).toBe(20261123);
    expect(artifact.weights.quantization).toBe('int16-le');
    expect(Object.keys(artifact.weights.tensors)).toHaveLength(8);
  });

  it('records training evidence that reconciles with the corpus', () => {
    const { evidence } = artifact;
    expect(evidence.pairs).toBe(corpus.pairs.length);
    // deck-exact split: cell-b is the holdout cell; the delta pair trains too
    expect(evidence.pairsTrained).toBe(3);
    expect(evidence.pairsHoldout).toBe(1);
    expect(evidence.strata['masked-elites']).toEqual({
      pairs: 3,
      trained: 2,
      holdout: 1,
      skipped: 0,
    });
    // substitution deltas train under D2a advantage weighting
    expect(evidence.strata['substitution-delta']).toEqual({
      pairs: 1,
      trained: 1,
      holdout: 0,
      skipped: 0,
    });
    expect(evidence.epochs).toBeGreaterThan(0);
    expect(evidence.bestEpoch).toBeLessThanOrEqual(evidence.epochs);
    expect(evidence.hyper).toMatchObject({
      lr: 0.5,
      l2: 1e-4,
      maxEpochs: 6,
      negativesPerPair: 4,
      seed: 20261123,
    });
    for (const loss of [evidence.trainLoss, evidence.holdoutLoss]) {
      expect(Number.isFinite(loss)).toBe(true);
    }
  });

  it('fits the raw size budget', () => {
    const bytes = Buffer.byteLength(renderArtifact(artifact));
    expect(bytes).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
    expect(bytes).toBeLessThan(60 * 1024); // the budget is not actually tight
  });

  it('dequantizes into a runnable model', () => {
    const model = dequantizeModel(artifact.weights);
    const ids = [...catalog.byId.keys()].slice(0, 24);
    const seed: SeedCard[] = ids.slice(3, 12).map((id) => ({
      features: catalog.featuresById.get(id)!,
      count: 2,
    }));
    const candidates = ids
      .slice(12, 20)
      .map((id) => catalog.featuresById.get(id)!);
    const scores = scoreCandidates(model, seed, candidates);
    expect(scores).toHaveLength(candidates.length);
    for (const score of scores) expect(Number.isFinite(score)).toBe(true);
  });
});

describe('deterministic training (D3)', () => {
  it('renders byte-identical artifacts for identical inputs', () => {
    const again = trainFromCorpus(corpus, catalog, 'corpus-fixture.json', {
      seed: 20261123,
      maxEpochs: 6,
      evalEvery: 2,
      patience: 2,
      negativesPerPair: 4,
    });
    expect(renderArtifact(again)).toBe(renderArtifact(artifact));
  });

  it('diverges with the training seed', () => {
    const other = trainFromCorpus(corpus, catalog, 'corpus-fixture.json', {
      seed: 424242,
      maxEpochs: 6,
      evalEvery: 2,
      patience: 2,
      negativesPerPair: 4,
    });
    expect(renderArtifact(other)).not.toBe(renderArtifact(artifact));
  });
});

describe('corpus artifact loader', () => {
  it('rejects stale feature schemas with a rebuild hint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generator-train-'));
    try {
      const stale = { ...corpus, featureSchemaVersion: 0 };
      const path = join(dir, 'stale.json');
      writeFileSync(path, JSON.stringify(stale));
      expect(() => loadCorpusArtifact(path)).toThrow(/rebuild the corpus/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'generator-train-'));
    try {
      const path = join(dir, 'bad.json');
      writeFileSync(path, JSON.stringify({ format: 'core', pairs: 'nope' }));
      expect(() => loadCorpusArtifact(path)).toThrow(/not a valid corpus/);
      const badPair = {
        ...corpus,
        pairs: [{ stratum: 'masked-elites', deckId: 'd', cellKey: 'c' }],
      };
      const path2 = join(dir, 'bad-pair.json');
      writeFileSync(path2, JSON.stringify(badPair));
      expect(() => loadCorpusArtifact(path2)).toThrow(/seed\/target/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('train CLI (resume contract)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generator-cli-'));
  const corpusPath = join(dir, 'corpus-fixture.json');
  const outA = join(dir, 'model-a.json');
  const outB = join(dir, 'model-b.json');
  const script = resolve(import.meta.dirname, 'train.ts');

  it('re-running with identical flags rewrites a byte-identical artifact', () => {
    writeFileSync(corpusPath, JSON.stringify(corpus));
    const run = (out: string): string => {
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          script,
          '--corpus',
          corpusPath,
          '--out',
          out,
          '--epochs',
          '3',
          '--eval-every',
          '2',
          '--patience',
          '1',
          '--negatives',
          '4',
        ],
        { timeout: 120_000 },
      );
      return readFileSync(out, 'utf8');
    };
    const first = run(outA);
    const second = run(outB);
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as GeneratorModelArtifact;
    expect(parsed.format).toBe('generator-model');
    expect(parsed.gate.verdict).toBe('PENDING');
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
  }, 180_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
