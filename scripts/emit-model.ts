import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

/**
 * Emits the trained meta model into the static data dir. The training pipeline
 * (scripts/training/) writes scripts/training/output/model.json when a
 * backtest-gated run succeeds; without that file there is no artifact and the
 * app degrades to deterministic-only metrics.
 */

const MAX_GZIP_BYTES = 300 * 1024;

export interface EmitResult {
  emitted: boolean;
  bytes?: number;
  reason?: string;
}

export function validateModelJson(json: string): { ok: true; gzipBytes: number } | { ok: false; reason: string } {
  let model: unknown;
  try {
    model = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'model.json is not valid JSON' };
  }
  const m = model as Record<string, unknown>;
  if (typeof m.version !== 'string' || m.version.length === 0) return { ok: false, reason: 'missing version' };
  if (typeof m.dataThroughDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.dataThroughDate)) {
    return { ok: false, reason: 'missing dataThroughDate (YYYY-MM-DD)' };
  }
  if (!Array.isArray(m.archetypes) || m.archetypes.length === 0) {
    return { ok: false, reason: 'missing archetypes' };
  }
  if (typeof m.cardWeights !== 'object' || m.cardWeights === null) {
    return { ok: false, reason: 'missing cardWeights' };
  }
  const gzipBytes = gzipSync(json).length;
  if (gzipBytes > MAX_GZIP_BYTES) {
    return { ok: false, reason: `artifact too large: ${gzipBytes} gzip bytes (max ${MAX_GZIP_BYTES})` };
  }
  return { ok: true, gzipBytes };
}

export async function emitModel(root: string): Promise<EmitResult> {
  const trainingPath = path.join(root, 'scripts', 'training', 'output', 'model.json');
  let json: string;
  try {
    json = await readFile(trainingPath, 'utf8');
  } catch {
    return { emitted: false, reason: 'no trained model yet (scripts/training/output/model.json missing)' };
  }
  const check = validateModelJson(json);
  if (!check.ok) return { emitted: false, reason: check.reason };
  const outDir = path.join(root, 'public', 'data');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'model.json'), json);
  return { emitted: true, bytes: check.gzipBytes };
}
