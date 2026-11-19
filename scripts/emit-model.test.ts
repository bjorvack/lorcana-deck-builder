import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitModel, validateModelJson } from './emit-model';

const fixtureModel = JSON.stringify({
  version: '2-fixture',
  dataThroughDate: '2026-11-10',
  cardSchemaVersion: 1,
  capabilities: { relations: true, calibration: true },
  gates: {
    relations: {
      metric: 'holdout_coherence_ratio',
      value: 1.4,
      random: 0.1,
      threshold: 1.1,
      passed: true,
      holdoutDecks: 30,
      vocab: 200,
      pairs: 40,
    },
    calibration: {
      metric: 'holdout_winrate_mae',
      value: 0.09,
      baseline: 0.2,
      passed: true,
      holdoutDecks: 30,
    },
  },
  archetypes: [
    {
      id: 1,
      name: 'Steel Song',
      observedWinRate: 0.54,
      sampleSize: 120,
      centroid: { '12': 0.06, '30': 0.07 },
    },
  ],
  cardWeights: { '12': 0.4, '30': -0.1 },
  relations: {
    dim: 2,
    quantization: 'int16-le',
    vectors: { 12: { b64: 'AACAPwAAAAAAAAA=', scale: 0.01 } },
  },
});

const calibrationOnly = (json: string): string => {
  const m = JSON.parse(json);
  m.capabilities = { relations: false, calibration: true };
  delete m.relations;
  return JSON.stringify(m);
};

describe('meta model emit', () => {
  it('validates shape and size', () => {
    expect(validateModelJson(fixtureModel).ok).toBe(true);
    expect(validateModelJson(calibrationOnly(fixtureModel)).ok).toBe(true);
    expect(validateModelJson('not json').ok).toBe(false);
    expect(validateModelJson('{"version":"2"}').ok).toBe(false);
    const noCaps = JSON.stringify({
      ...JSON.parse(fixtureModel),
      capabilities: { relations: false, calibration: false },
    });
    expect(validateModelJson(noCaps).ok).toBe(false);
    // relations flag without payload is rejected
    const broken = JSON.parse(fixtureModel) as Record<string, unknown>;
    delete broken.relations;
    expect(validateModelJson(JSON.stringify(broken)).ok).toBe(false);
    // calibration flag without payload is rejected
    const calBroken = JSON.parse(calibrationOnly(fixtureModel)) as Record<
      string,
      unknown
    >;
    delete calBroken.archetypes;
    expect(validateModelJson(JSON.stringify(calBroken)).ok).toBe(false);
    // oversized, incompressible artifact is rejected
    const random = Array.from({ length: 400 * 1024 }, () =>
      String.fromCharCode(33 + Math.floor(Math.random() * 90)),
    ).join('');
    const big = JSON.stringify({ ...JSON.parse(fixtureModel), pad: random });
    const r = validateModelJson(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('too large');
  });

  it('emits only when a trained model exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emit-'));
    try {
      const missing = await emitModel(root);
      expect(missing.emitted).toBe(false);
      await mkdir(path.join(root, 'scripts', 'training', 'output'), {
        recursive: true,
      });
      await writeFile(
        path.join(root, 'scripts', 'training', 'output', 'meta-model.json'),
        fixtureModel,
      );
      const ok = await emitModel(root);
      expect(ok.emitted).toBe(true);
      const out = await readFile(
        path.join(root, 'public', 'data', 'meta-model.json'),
        'utf8',
      );
      const parsed = JSON.parse(out);
      expect(parsed.archetypes).toHaveLength(1);
      expect(parsed.capabilities).toEqual({
        relations: true,
        calibration: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
