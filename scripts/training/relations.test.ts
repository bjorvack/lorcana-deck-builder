import { describe, expect, it } from 'vitest';
import {
  assembleMetaModel,
  type CalibrationOutput,
  coherenceCheck,
  mulberry32,
  quantizeEmbeddings,
  type RelationDeck,
  type RelationsOutput,
  trainRelations,
} from './train';

/** two disjoint deck families: ids 1–8 vs 101–108 */
function twoFamilyDecks(seed: number, decks: number): RelationDeck[] {
  const rng = mulberry32(seed);
  const pick = (base: number): number[] => {
    const ids = Array.from({ length: 8 }, (_, i) => base + i);
    const tokens: number[] = [];
    for (let i = 0; i < 5; i++) {
      const j = Math.floor(rng() * ids.length);
      tokens.push(ids.splice(j, 1)[0]!);
    }
    return tokens;
  };
  return Array.from({ length: decks }, (_, i) => ({
    tokens: i % 2 === 0 ? pick(1) : pick(101),
    date: '2026-01-01',
  }));
}

describe('SGNS relation training', () => {
  it('is deterministic for a fixed corpus and seed', () => {
    const decks = twoFamilyDecks(7, 40);
    const a = trainRelations(decks, { seed: 42 });
    const b = trainRelations(decks, { seed: 42 });
    expect([...a.keys()]).toEqual([...b.keys()]);
    for (const [id, vec] of a) expect([...vec]).toEqual([...b.get(id)!]);
    const other = trainRelations(decks, { seed: 43 });
    const first = [...a.keys()][0]!;
    expect([...other.get(first)!]).not.toEqual([...a.get(first)!]);
  });

  it('separates two deck families and passes the holdout coherence gate', () => {
    const all = twoFamilyDecks(7, 120);
    const vectors = trainRelations(all, { seed: 42 });
    expect(vectors.size).toBe(16);
    const cos = (a: number, b: number): number => {
      const va = vectors.get(a)!;
      const vb = vectors.get(b)!;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let d = 0; d < va.length; d++) {
        dot += va[d]! * vb[d]!;
        na += va[d]! * va[d]!;
        nb += vb[d]! * vb[d]!;
      }
      return dot / Math.sqrt(na * nb);
    };
    expect(cos(1, 2)).toBeGreaterThan(cos(1, 101)); // within-family > cross-family
    const gate = coherenceCheck(all.slice(0, 20), vectors, {
      randomPairs: 2000,
    });
    expect(gate.passed).toBe(true);
    expect(gate.value).toBeGreaterThan(gate.random);
  });

  it('rejects an empty corpus and single-card vocab', () => {
    expect(trainRelations([]).size).toBe(0);
    const gate = coherenceCheck([], trainRelations([]), {});
    expect(gate.passed).toBe(false);
    const oneCard = [{ tokens: [5, 5, 5], date: '2026-01-01' }];
    const vectors = trainRelations(oneCard);
    expect(coherenceCheck(oneCard, vectors, {}).passed).toBe(false);
  });

  it('recency weighting is a parameter and leaves the corpus unchanged when off', () => {
    const old = twoFamilyDecks(7, 20).map((d) => ({
      ...d,
      date: '2025-01-01',
    }));
    const recent = twoFamilyDecks(7, 20).map((d) => ({
      ...d,
      date: '2026-06-01',
    }));
    const off = trainRelations([...old, ...recent]);
    const on = trainRelations([...old, ...recent], {
      recencyHalfLifeDays: 90,
      seed: 42,
    });
    expect(on.size).toBe(off.size);
    const first = [...on.keys()][0]!;
    expect([...on.get(first)!]).not.toEqual([...off.get(first)!]);
  });
});

describe('relation embedding quantization', () => {
  it('round-trips Int16 + scale within tolerance', () => {
    const vectors = trainRelations(twoFamilyDecks(7, 40), { seed: 42 });
    const dim = vectors.values().next().value!.length;
    const artifact = quantizeEmbeddings(dim, vectors);
    expect(artifact.dim).toBe(dim);
    expect(artifact.quantization).toBe('int16-le');
    const id = [...vectors.keys()][0]!;
    const entry = artifact.vectors[String(id)]!;
    const buf = Buffer.from(entry.b64, 'base64');
    for (let d = 0; d < dim; d++) {
      const q = buf.readInt16LE(d * 2);
      expect(q * entry.scale).toBeCloseTo(vectors.get(id)![d]!, 4);
    }
  });
});

describe('capability-gated publication', () => {
  const base = {
    dataThroughDate: '2026-11-16',
    cardSchemaVersion: 1,
    sources: { topdeck: 100 },
  };
  const calibration = (passed: boolean): CalibrationOutput => ({
    passed,
    archetypes: [
      {
        id: 1,
        name: 'Amber/Sapphire X + Y',
        observedWinRate: 0.55,
        sampleSize: 10,
        centroid: { 1: 0.5 },
      },
    ],
    cardWeights: { 1: 0.25 },
    metrics: {
      metric: 'holdout_winrate_mae',
      value: 0.1,
      baseline: 0.2,
      passed,
      holdoutDecks: 25,
    },
  });
  const relations = (passed: boolean): RelationsOutput => {
    const vectors = passed
      ? trainRelations(twoFamilyDecks(7, 40), { seed: 42 })
      : new Map();
    return {
      passed,
      vectors,
      metrics: {
        metric: 'holdout_coherence_ratio',
        value: passed ? 1.5 : 0.9,
        random: 0.05,
        threshold: 1.1,
        passed,
        holdoutDecks: 20,
        vocab: vectors.size,
        pairs: 30,
      },
    };
  };

  it('ships both capabilities when both gates pass', () => {
    const model = assembleMetaModel({
      ...base,
      calibration: calibration(true),
      relations: relations(true),
    });
    expect(model!.capabilities).toEqual({ relations: true, calibration: true });
    expect(model!.archetypes).toHaveLength(1);
    expect(model!.cardWeights).toBeDefined();
    expect(Object.keys(model!.relations!.vectors).length).toBeGreaterThan(0);
  });

  it('ships relations alone when the calibration gate fails', () => {
    const model = assembleMetaModel({
      ...base,
      calibration: calibration(false),
      relations: relations(true),
    });
    expect(model!.capabilities).toEqual({
      relations: true,
      calibration: false,
    });
    expect(model!.archetypes).toBeUndefined();
    expect(model!.cardWeights).toBeUndefined();
    expect(model!.relations).toBeDefined();
  });

  it('ships calibration alone when the coherence gate fails', () => {
    const model = assembleMetaModel({
      ...base,
      calibration: calibration(true),
      relations: relations(false),
    });
    expect(model!.capabilities).toEqual({
      relations: false,
      calibration: true,
    });
    expect(model!.relations).toBeUndefined();
    expect(model!.archetypes).toBeDefined();
  });

  it('publishes nothing when neither gate passes', () => {
    const model = assembleMetaModel({
      ...base,
      calibration: calibration(false),
      relations: relations(false),
    });
    expect(model).toBeNull();
  });
});
