/**
 * Shared map-elites chunk evaluator for the generator strata runners (tasks
 * 1.4/1.5). Spawns the map-elites CLI's `--eval-chunk` child mode instead of
 * importing the engine chain: the child wires cachedBatchPlayer (arena disk
 * cache) and schedule.ts's paired-seed evaluation, while this parent process
 * stays engine-free. Re-invoking a runner with the same flags re-runs only
 * the orchestration — every completed member schedule is served from the
 * arena disk cache, so completed games are never re-simulated.
 *
 * The chunk/part shapes mirror map-elites.ts's internal EvalChunk/ChildPart
 * contracts (structural copies — drift breaks the child protocol). Parts are
 * validated (index match, finite fitness, twin presence iff requested)
 * before they are trusted, per the AGENTS.md resume rule; anything that
 * fails validation aborts the run loudly rather than being merged.
 *
 * Parts land in a per-invocation directory (label + pid) so concurrent runs
 * never sweep each other's work; the directory is removed when the run ends.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** mirrors map-elites.ts's internal EvalChunk */
export interface EvalChunkRequest {
  index: number;
  /** the evaluated deck — seat p1 against every league member */
  deck: Record<string, number>;
  /** twin-paired mode: the related deck played on the same seed bases */
  parentDeck: Record<string, number>;
  /** full league snapshot the child evaluates against */
  league: unknown;
  masterSeed: number;
  gamesPerMember: number;
  batchSize: number;
  referee: string;
  twinPaired: boolean;
}

export interface EvalChunkSide {
  fitness: number;
  games: number;
}

/** mirrors map-elites.ts's internal ChildPart */
export interface EvalChunkPart {
  index: number;
  fitness: number;
  games: number;
  twin?: EvalChunkSide;
}

export interface EvaluateChunksOptions {
  parallel: number;
  /** directory the per-invocation part directory is created in */
  workDir: string;
  /** distinguishes concurrent runners sharing a work directory */
  label: string;
}

function assertValidPart(
  part: EvalChunkPart,
  request: EvalChunkRequest,
  partPath: string,
): void {
  if (part.index !== request.index) {
    throw new Error(
      `chunk ${request.index}: part carries index ${part.index} (${partPath})`,
    );
  }
  if (!Number.isFinite(part.fitness)) {
    throw new Error(`chunk ${request.index}: fitness is not finite`);
  }
  if (!Number.isInteger(part.games) || part.games < 1) {
    throw new Error(`chunk ${request.index}: games ${part.games} is invalid`);
  }
  if (request.twinPaired !== (part.twin !== undefined)) {
    throw new Error(
      `chunk ${request.index}: twin ${request.twinPaired ? 'missing' : 'unexpected'}`,
    );
  }
  if (
    part.twin &&
    (!Number.isFinite(part.twin.fitness) ||
      !Number.isInteger(part.twin.games) ||
      part.twin.games < 1)
  ) {
    throw new Error(`chunk ${request.index}: twin evaluation is invalid`);
  }
}

/**
 * Evaluate every request through a dynamic pool of map-elites child
 * processes; parts are merged in request order — never completion order —
 * so the result is deterministic regardless of worker timing.
 */
export async function evaluateChunks(
  requests: EvalChunkRequest[],
  opts: EvaluateChunksOptions,
): Promise<EvalChunkPart[]> {
  if (requests.length === 0) return [];
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const mapElitesPath = fileURLToPath(
    new URL('../arena/map-elites.ts', import.meta.url),
  );
  const partDir = join(opts.workDir, `.parts-${opts.label}-${process.pid}`);
  mkdirSync(partDir, { recursive: true });
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < requests.length) {
      const request = requests[next++]!;
      const chunkPath = join(partDir, `chunk-${request.index}.json`);
      const partPath = join(partDir, `part-${request.index}.json`);
      writeFileSync(chunkPath, JSON.stringify(request));
      await execFileAsync(process.execPath, [
        tsxCli,
        mapElitesPath,
        '--eval-chunk',
        chunkPath,
        '--part',
        partPath,
      ]);
    }
  };
  try {
    const workers = Math.max(1, Math.min(opts.parallel, requests.length));
    await Promise.all(Array.from({ length: workers }, () => runWorker()));
    return requests.map((request) => {
      const partPath = join(partDir, `part-${request.index}.json`);
      if (!existsSync(partPath)) {
        throw new Error(`chunk ${request.index} wrote no part (${partPath})`);
      }
      const part = JSON.parse(readFileSync(partPath, 'utf8')) as EvalChunkPart;
      assertValidPart(part, request, partPath);
      return part;
    });
  } finally {
    rmSync(partDir, { recursive: true, force: true });
  }
}
