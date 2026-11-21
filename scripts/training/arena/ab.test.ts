/** A/B aggregation + Wilson interval unit tests (pure helpers of ab.ts). */
import { describe, expect, it } from 'vitest';
import { aggregate, proportionStats } from './ab';

describe('proportionStats', () => {
  it('computes the Wilson interval', () => {
    const stats = proportionStats(50, 100);
    expect(stats.winRate).toBe(0.5);
    expect(stats.ciLow).toBeGreaterThan(0.4);
    expect(stats.ciHigh).toBeLessThan(0.6);
  });

  it('never leaves the [0,1] range at the extremes', () => {
    expect(proportionStats(10, 10).ciLow).toBeGreaterThan(0.5);
    expect(proportionStats(0, 10).ciHigh).toBeLessThan(0.5);
    expect(proportionStats(10, 10).ciHigh).toBe(1);
    expect(proportionStats(0, 10).ciLow).toBe(0);
  });

  it('handles zero games', () => {
    const stats = proportionStats(0, 0);
    expect(stats.games).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.ciLow).toBe(0);
    expect(stats.ciHigh).toBe(0);
  });
});

describe('aggregate', () => {
  it('reports uplift and pass only when the CI lower bound is positive', () => {
    // synergy clearly better: 600/1000 vs 500/1000
    const report = aggregate(
      { wins: 500, games: 1000 },
      { wins: 600, games: 1000 },
      0,
      { seeds: 16, opponents: 8, gamesPerMatchup: 4 },
    );
    expect(report.uplift).toBe(0.1);
    expect(report.pass).toBe(true);
    expect(report.upliftCiLow).toBeGreaterThan(0);
  });

  it('fails when the uplift is within noise', () => {
    const report = aggregate(
      { wins: 505, games: 1000 },
      { wins: 510, games: 1000 },
      0,
      { seeds: 16, opponents: 8, gamesPerMatchup: 4 },
    );
    expect(report.pass).toBe(false);
    expect(report.upliftCiLow).toBeLessThanOrEqual(0);
  });

  it('carries the illegal-deck count through', () => {
    const report = aggregate({ wins: 0, games: 0 }, { wins: 0, games: 0 }, 3, {
      seeds: 1,
      opponents: 1,
      gamesPerMatchup: 1,
    });
    expect(report.illegalDecks).toBe(3);
  });
});
