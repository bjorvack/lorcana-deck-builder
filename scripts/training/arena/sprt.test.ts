/** SPRT decision-bound tests on synthetic streaks (pure math). */
import { describe, expect, it } from 'vitest';
import { sprtDecision } from './sprt';

describe('sprtDecision', () => {
  it('keeps playing on balanced results', () => {
    const result = sprtDecision(10, 10);
    expect(result.decision).toBe('continue');
    // 10·ln(1.2) + 10·ln(0.8) ≈ -0.408
    expect(result.llr).toBeCloseTo(-0.40822, 4);
    expect(result.games).toBe(20);
  });

  it('keeps playing with no games', () => {
    const result = sprtDecision(0, 0);
    expect(result.decision).toBe('continue');
    expect(result.llr).toBe(0);
  });

  it('uses Wald bounds ±ln(19) at α = β = 0.05', () => {
    const { upper, lower } = sprtDecision(0, 0);
    expect(upper).toBeCloseTo(2.94444, 4);
    expect(lower).toBeCloseTo(-2.94444, 4);
  });

  it('crosses the accept bound on a winning streak', () => {
    // 16·ln(1.2) ≈ 2.917 < 2.944, 17·ln(1.2) ≈ 3.099 ≥ 2.944
    expect(sprtDecision(16, 0).decision).toBe('continue');
    const accepted = sprtDecision(17, 0);
    expect(accepted.decision).toBe('accept');
    expect(accepted.llr).toBeCloseTo(3.09947, 4);
    expect(sprtDecision(20, 0).decision).toBe('accept');
  });

  it('crosses the reject bound on a losing streak', () => {
    // 13·ln(0.8) ≈ -2.901 > -2.944, 14·ln(0.8) ≈ -3.124 ≤ -2.944
    expect(sprtDecision(0, 13).decision).toBe('continue');
    const rejected = sprtDecision(0, 14);
    expect(rejected.decision).toBe('reject');
    expect(rejected.llr).toBeCloseTo(-3.12401, 4);
    expect(sprtDecision(0, 20).decision).toBe('reject');
  });

  it('stops late on a noisy slight edge', () => {
    // a small edge drifts down toward H0 before enough games accumulate
    const mid = sprtDecision(30, 25);
    expect(mid.decision).toBe('continue');
  });

  it('tightens the bounds with smaller error probabilities', () => {
    // α = β = 0.01 → bounds ±ln(99) ≈ ±4.595; 20 straight wins no longer suffice
    const strict = sprtDecision(20, 0, { alpha: 0.01, beta: 0.01 });
    expect(strict.decision).toBe('continue');
    expect(strict.upper).toBeCloseTo(4.59512, 4);
    expect(sprtDecision(26, 0, { alpha: 0.01, beta: 0.01 }).decision).toBe(
      'accept',
    );
  });

  it('honours a custom alternative hypothesis p1', () => {
    // p1 = 0.75: each win contributes ln(1.5) ≈ 0.405 → 10 wins decide
    const result = sprtDecision(10, 0, { p1: 0.75 });
    expect(result.decision).toBe('accept');
    expect(result.llr).toBeCloseTo(4.05465, 4);
  });

  it('rejects invalid parameter values', () => {
    expect(() => sprtDecision(1, 0, { p0: 1 })).toThrowError('0 < p0, p1 < 1');
    expect(() => sprtDecision(1, 0, { p1: 0 })).toThrowError('0 < p0, p1 < 1');
    expect(() => sprtDecision(1, 0, { alpha: 0 })).toThrowError(
      '0 < alpha, beta < 1',
    );
    expect(() => sprtDecision(1, 0, { beta: 1.5 })).toThrowError(
      '0 < alpha, beta < 1',
    );
  });
});
