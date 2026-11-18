import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Emits the trained meta model into the static data dir. The training pipeline
 * (scripts/training/) writes scripts/training/output/meta-model.json when
 * either gated capability (relations, calibration) passes; without a passing
 * capability there is no artifact and the app degrades to deterministic-only
 * metrics. The artifact is capability-gated: failing parts are omitted by the
 * trainer and their capability flag is false.
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
    return { ok: false, reason: 'meta-model.json is not valid JSON' };
  }
  const m = model as Record<string, unknown>;
  if (typeof m.version !== 'string' || m.version.length === 0) return { ok: false, reason: 'missing version' };
  if (typeof m.dataThroughDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(m.dataThroughDate)) {
    return { ok: false, reason: 'missing dataThroughDate (YYYY-MM-DD)' };
  }
  const caps = m.capabilities as Record<string, unknown> | undefined;
  if (!caps || typeof caps.relations !== 'boolean' || typeof caps.calibration !== 'boolean') {
    return { ok: false, reason: 'missing capabilities block (relations/calibration flags)' };
  }
  if (caps.relations) {
    const rel = m.relations as Record<string, unknown> | undefined;
    if (!rel || typeof rel.dim !== 'number' || rel.dim <= 0) {
      return { ok: false, reason: 'capabilities.relations is true but relations.dim is missing' };
    }
    if (rel.quantization !== 'int16-le') return { ok: false, reason: 'relations.quantization must be int16-le' };
    const vectors = rel.vectors as Record<string, unknown> | undefined;
    if (!vectors || typeof vectors !== 'object' || Object.keys(vectors).length === 0) {
      return { ok: false, reason: 'capabilities.relations is true but relations.vectors is missing' };
    }
    const sample = Object.values(vectors)[0] as { b64?: unknown; scale?: unknown } | undefined;
    if (typeof sample?.b64 !== 'string' || typeof sample?.scale !== 'number') {
      return { ok: false, reason: 'relation vectors must carry { b64, scale } entries' };
    }
  }
  if (caps.calibration) {
    if (!Array.isArray(m.archetypes) || m.archetypes.length === 0) {
      return { ok: false, reason: 'capabilities.calibration is true but archetypes are missing' };
    }
    if (typeof m.cardWeights !== 'object' || m.cardWeights === null) {
      return { ok: false, reason: 'capabilities.calibration is true but cardWeights are missing' };
    }
  }
  if (!caps.relations && !caps.calibration) {
    return { ok: false, reason: 'no capability passed its gate — nothing to publish' };
  }
  const gzipBytes = gzipSync(json).length;
  if (gzipBytes > MAX_GZIP_BYTES) {
    return { ok: false, reason: `artifact too large: ${gzipBytes} gzip bytes (max ${MAX_GZIP_BYTES})` };
  }
  return { ok: true, gzipBytes };
}

export async function emitModel(root: string): Promise<EmitResult> {
  const trainingPath = path.join(root, 'scripts', 'training', 'output', 'meta-model.json');
  let json: string;
  try {
    json = await readFile(trainingPath, 'utf8');
  } catch {
    return { emitted: false, reason: 'no trained model yet (scripts/training/output/meta-model.json missing)' };
  }
  const check = validateModelJson(json);
  if (!check.ok) return { emitted: false, reason: check.reason };
  const outDir = path.join(root, 'public', 'data');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'meta-model.json'), json);
  return { emitted: true, bytes: check.gzipBytes };
}

// CLI entry: npx tsx scripts/emit-model.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await emitModel(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(
    result.emitted ? `meta artifact: meta-model.json (${result.bytes} gzip bytes)` : `meta artifact: skipped — ${result.reason}`
  );
}
