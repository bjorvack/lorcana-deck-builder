/** MAP-Elites archive tests: place semantics, stats, deterministic serialization. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ArchiveEntry,
  archivePath,
  archiveStats,
  type ElitesArchive,
  emptyArchive,
  loadArchive,
  place,
  saveArchive,
  stableStringify,
} from './map-elites-archive';

const descriptor = (avgCost: number, lore: number) => ({
  avgCost,
  inkableRatio: 0.5,
  typeMix: { character: 0.6, action: 0.3, item: 0.1 },
  lorePerTurnProxy: lore,
});

const entry = (fitness: number, games = 8): Omit<ArchiveEntry, 'cellKey'> => ({
  descriptor: descriptor(2.5, 9),
  deck: { 101: 3, 102: 3, 103: 54 },
  fitness,
  games,
  updatedOn: 3,
});

const cellKey = (n: number): string =>
  `cost-${n}_ink-2_mix-character-1_lore-18`;

describe('place', () => {
  it('fills an empty cell', () => {
    const archive = emptyArchive('core', 'commit', 1);
    const result = place(archive, cellKey(5), entry(0.5));
    expect(result.placed).toBe(true);
    expect(result.archive.cells[cellKey(5)]?.fitness).toBe(0.5);
  });

  it('replaces only on strictly better fitness; ties keep the incumbent', () => {
    let archive = emptyArchive('core', 'commit', 1);
    archive = place(archive, cellKey(5), entry(0.5)).archive;
    // worse
    const worse = place(archive, cellKey(5), entry(0.4, 99));
    expect(worse.placed).toBe(false);
    expect(worse.archive.cells[cellKey(5)]?.fitness).toBe(0.5);
    expect(worse.archive.cells[cellKey(5)]?.games).toBe(8);
    // tie
    const tie = place(archive, cellKey(5), entry(0.5, 99));
    expect(tie.placed).toBe(false);
    // strictly better
    const better = place(archive, cellKey(5), entry(0.6, 12));
    expect(better.placed).toBe(true);
    expect(better.archive.cells[cellKey(5)]?.fitness).toBe(0.6);
    expect(better.archive.cells[cellKey(5)]?.games).toBe(12);
  });

  it('never mutates the input archive', () => {
    const archive = emptyArchive('core', 'commit', 1);
    const before = stableStringify(archive);
    place(archive, cellKey(5), entry(0.9));
    expect(stableStringify(archive)).toBe(before);
  });
});

describe('archiveStats', () => {
  it('summarizes occupancy, descriptor ranges and the fitness distribution', () => {
    let archive = emptyArchive('core', 'commit', 1);
    const fitnesses = [0.5, 0.4, 0.9];
    fitnesses.forEach((fitness, i) => {
      archive = place(archive, cellKey(i + 1), {
        ...entry(fitness),
        descriptor: descriptor(1 + i, 5 + i),
      }).archive;
    });
    const stats = archiveStats(archive);
    expect(stats.cells).toBe(3);
    expect(stats.totalGames).toBe(24);
    expect(stats.descriptorRanges).toEqual({
      avgCost: { min: 1, max: 3 },
      inkableRatio: { min: 0.5, max: 0.5 },
      lorePerTurnProxy: { min: 5, max: 7 },
      typeMix: {
        character: { min: 0.6, max: 0.6 },
        action: { min: 0.3, max: 0.3 },
        item: { min: 0.1, max: 0.1 },
      },
    });
    expect(stats.fitness).toEqual({
      min: 0.4,
      max: 0.9,
      mean: 0.6,
      p25: 0.4,
      median: 0.5,
      p75: 0.5,
    });
  });

  it('reports null ranges and fitness for an empty archive', () => {
    expect(archiveStats(emptyArchive('core', 'commit', 1))).toEqual({
      cells: 0,
      totalGames: 0,
      descriptorRanges: null,
      fitness: null,
    });
  });
});

describe('serialization', () => {
  it('keys the artifact by commit8 + seed', () => {
    expect(archivePath('abcdef1234567890', 20261121)).toMatch(
      /archive-abcdef12-20261121\.json$/,
    );
    expect(() => archivePath('', 1)).toThrow('engineCommit is empty');
  });

  it('is byte-identical regardless of cell insertion order', async () => {
    const build = (order: number[]): ElitesArchive => {
      let archive = emptyArchive('core', 'commit', 1);
      for (const i of order) {
        archive = place(archive, cellKey(i), entry(0.3 + i / 10)).archive;
      }
      return archive;
    };
    const forward = build([1, 2, 3]);
    const backward = build([3, 2, 1]);
    expect(stableStringify(backward)).toBe(stableStringify(forward));

    const dir = await mkdtemp(path.join(tmpdir(), 'map-elites-archive-'));
    const forwardPath = await saveArchive(forward, dir);
    const backwardPath = await saveArchive(backward, dir);
    expect(await readFile(backwardPath, 'utf8')).toBe(
      await readFile(forwardPath, 'utf8'),
    );
    expect(await readFile(forwardPath, 'utf8')).toMatch(/\n$/);
  });

  it('round-trips through save/load', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'map-elites-archive-'));
    let archive = emptyArchive('core', 'engine-commit-xyz', 42);
    archive = place(archive, cellKey(5), entry(0.55)).archive;
    const filePath = await saveArchive(archive, dir);
    expect(await loadArchive(filePath)).toEqual(archive);
  });

  it('rejects malformed archives', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'map-elites-archive-'));
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ format: 'core' }));
    await expect(loadArchive(bad)).rejects.toThrow('not a valid archive file');
  });
});
