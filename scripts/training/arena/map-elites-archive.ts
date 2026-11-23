/**
 * MAP-Elites archive (self-play-league, task 4.1).
 *
 * The archive holds one elite deck per behaviour-descriptor cell (see
 * map-elites-descriptors.ts). A mutant replaces its cell's elite only when
 * strictly fitter; ties keep the incumbent. Fitness is the league win rate
 * supplied by the search loop (task 4.3).
 *
 * Artifact (D3 — run-state, never part of meta-model.json):
 *   scripts/training/data/arena/selfplay/archive-<commit8>-<seed>.json
 * An engine-commit + seed change starts a new era and never mixes cells
 * (AGENTS.md cache-key rule).
 *
 * Determinism: serialization sorts every object key with a fixed indent, and
 * `updatedOn` is a caller-supplied deterministic step label (e.g. the
 * generation number) — wall-clock time must never enter the archive, or
 * task 4.4's byte-identical re-run check could never pass.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BehaviourDescriptor } from './map-elites-descriptors';

/** commit8-keyed archive artifacts live next to the league files */
export const ARCHIVE_DIR = path.resolve(
  import.meta.dirname,
  '..',
  'data',
  'arena',
  'selfplay',
);

export interface ArchiveEntry {
  cellKey: string;
  descriptor: BehaviourDescriptor;
  /** identity id → count; has passed full legality validation (task 4.2) */
  deck: Record<string, number>;
  /** league win rate over `games` games */
  fitness: number;
  /** games the fitness was measured over */
  games: number;
  /** deterministic step label of the last replacement (generation) — never wall-clock */
  updatedOn: number;
}

export interface ElitesArchive {
  /** game format the decks are legal in */
  format: string;
  engineCommit: string;
  seed: number;
  /**
   * Resume checkpoint (map-elites.ts): generations fully placed + promoted.
   * Absent in archives written before resumability — such archives restart
   * the generation counter at 0.
   */
  generationsCompleted?: number;
  cells: Record<string, ArchiveEntry>;
}

export function emptyArchive(
  format: string,
  engineCommit: string,
  seed: number,
): ElitesArchive {
  return { format, engineCommit, seed, generationsCompleted: 0, cells: {} };
}

export interface PlaceResult {
  /** the (possibly unchanged) archive — inputs are never mutated */
  archive: ElitesArchive;
  /** true when the entry replaced the cell's incumbent */
  placed: boolean;
}

/**
 * Place a mutant into its cell: replace only when strictly fitter, ties keep
 * the incumbent. Returns a new archive object; the input is left untouched
 * (same convention as league promote()).
 */
export function place(
  archive: ElitesArchive,
  cellKey: string,
  entry: Omit<ArchiveEntry, 'cellKey'>,
): PlaceResult {
  const incumbent = archive.cells[cellKey];
  if (incumbent && entry.fitness <= incumbent.fitness) {
    return { archive, placed: false };
  }
  const cell: ArchiveEntry = {
    cellKey,
    descriptor: {
      ...entry.descriptor,
      typeMix: { ...entry.descriptor.typeMix },
    },
    deck: { ...entry.deck },
    fitness: entry.fitness,
    games: entry.games,
    updatedOn: entry.updatedOn,
  };
  return {
    archive: { ...archive, cells: { ...archive.cells, [cellKey]: cell } },
    placed: true,
  };
}

export interface Range {
  min: number;
  max: number;
}

export interface FitnessStats {
  min: number;
  max: number;
  mean: number;
  /** nearest-rank quantiles over sorted fitness values */
  p25: number;
  median: number;
  p75: number;
}

export interface DescriptorRanges {
  avgCost: Range;
  inkableRatio: Range;
  lorePerTurnProxy: Range;
  typeMix: {
    character: Range;
    action: Range;
    item: Range;
  };
}

export interface ArchiveStats {
  cells: number;
  totalGames: number;
  /** null when the archive is empty */
  descriptorRanges: DescriptorRanges | null;
  /** null when the archive is empty */
  fitness: FitnessStats | null;
}

const range = (values: number[]): Range => ({
  min: Math.min(...values),
  max: Math.max(...values),
});

/** nearest-rank quantile: sorted[Math.floor(q × (n − 1))] */
const quantile = (sorted: number[], q: number): number =>
  sorted[Math.floor(q * (sorted.length - 1))]!;

/** occupancy, descriptor ranges and fitness distribution over occupied cells */
export function archiveStats(archive: ElitesArchive): ArchiveStats {
  const entries = Object.values(archive.cells);
  if (entries.length === 0) {
    return { cells: 0, totalGames: 0, descriptorRanges: null, fitness: null };
  }
  const fitnessValues = entries.map((e) => e.fitness).sort((a, b) => a - b);
  return {
    cells: entries.length,
    totalGames: entries.reduce((sum, e) => sum + e.games, 0),
    descriptorRanges: {
      avgCost: range(entries.map((e) => e.descriptor.avgCost)),
      inkableRatio: range(entries.map((e) => e.descriptor.inkableRatio)),
      lorePerTurnProxy: range(
        entries.map((e) => e.descriptor.lorePerTurnProxy),
      ),
      typeMix: {
        character: range(entries.map((e) => e.descriptor.typeMix.character)),
        action: range(entries.map((e) => e.descriptor.typeMix.action)),
        item: range(entries.map((e) => e.descriptor.typeMix.item)),
      },
    },
    fitness: {
      min: fitnessValues[0]!,
      max: fitnessValues[fitnessValues.length - 1]!,
      mean: fitnessValues.reduce((sum, v) => sum + v, 0) / fitnessValues.length,
      p25: quantile(fitnessValues, 0.25),
      median: quantile(fitnessValues, 0.5),
      p75: quantile(fitnessValues, 0.75),
    },
  };
}

/** JSON with every object key sorted recursively — byte-identical for equal archives */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 1);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort())
      out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

export function archivePath(
  engineCommit: string,
  seed: number,
  dir = ARCHIVE_DIR,
): string {
  const commit8 = engineCommit.slice(0, 8);
  if (!commit8)
    throw new Error('engineCommit is empty — cannot derive archive file name');
  return path.join(dir, `archive-${commit8}-${seed}.json`);
}

/** persist the archive as its commit8+seed-keyed JSON artifact; returns the path */
export async function saveArchive(
  archive: ElitesArchive,
  dir = ARCHIVE_DIR,
): Promise<string> {
  const filePath = archivePath(archive.engineCommit, archive.seed, dir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${stableStringify(archive)}\n`);
  return filePath;
}

/** load + minimally validate an archive artifact */
export async function loadArchive(filePath: string): Promise<ElitesArchive> {
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as ElitesArchive;
  if (
    typeof raw.format !== 'string' ||
    typeof raw.engineCommit !== 'string' ||
    typeof raw.seed !== 'number' ||
    (raw.generationsCompleted !== undefined &&
      (typeof raw.generationsCompleted !== 'number' ||
        !Number.isInteger(raw.generationsCompleted) ||
        raw.generationsCompleted < 0)) ||
    raw.cells === null ||
    typeof raw.cells !== 'object'
  ) {
    throw new Error(`${filePath} is not a valid archive file`);
  }
  for (const [key, entry] of Object.entries(raw.cells)) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.cellKey !== 'string' ||
      typeof entry.fitness !== 'number' ||
      typeof entry.games !== 'number' ||
      typeof entry.updatedOn !== 'number' ||
      entry.deck === null ||
      typeof entry.deck !== 'object' ||
      entry.descriptor === null ||
      typeof entry.descriptor !== 'object' ||
      typeof entry.descriptor.avgCost !== 'number' ||
      typeof entry.descriptor.inkableRatio !== 'number' ||
      typeof entry.descriptor.lorePerTurnProxy !== 'number' ||
      entry.descriptor.typeMix === null ||
      typeof entry.descriptor.typeMix !== 'object'
    ) {
      throw new Error(`${filePath} contains a malformed archive cell: ${key}`);
    }
  }
  return raw;
}
