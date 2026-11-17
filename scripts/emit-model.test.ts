import { describe, expect, it } from 'vitest';
import { validateModelJson, emitModel } from './emit-model';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixtureModel = JSON.stringify({
  version: '1-fixture',
  dataThroughDate: '2026-11-10',
  cardSchemaVersion: 1,
  archetypes: [
    { id: 1, name: 'Steel Song', observedWinRate: 0.54, sampleSize: 120, centroid: { '12': 0.06, '30': 0.07 } },
  ],
  cardWeights: { '12': 0.4, '30': -0.1 },
});

describe('meta model emit', () => {
  it('validates shape and size', () => {
    expect(validateModelJson(fixtureModel).ok).toBe(true);
    expect(validateModelJson('not json').ok).toBe(false);
    expect(validateModelJson('{"version":"1"}').ok).toBe(false);
    // oversized, incompressible artifact is rejected
    const random = Array.from({ length: 400 * 1024 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('');
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
      await mkdir(path.join(root, 'scripts', 'training', 'output'), { recursive: true });
      await writeFile(path.join(root, 'scripts', 'training', 'output', 'model.json'), fixtureModel);
      const ok = await emitModel(root);
      expect(ok.emitted).toBe(true);
      const out = await readFile(path.join(root, 'public', 'data', 'model.json'), 'utf8');
      expect(JSON.parse(out).archetypes).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
