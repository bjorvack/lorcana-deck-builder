import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAll, loadCache, saveCache, type FetchResult } from './fetch';
import { normalizeAll, type NormalizeResult } from './normalize';
import { applyTags, loadTagRules } from './tag';
import { emitModel } from './emit-model';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.data-cache');
const OUT_DIR = path.join(ROOT, 'public', 'data');

type Step = 'fetch' | 'build' | 'all';

export function parseArgs(argv: string[] = process.argv.slice(2)): Step {
  const i = argv.indexOf('--step');
  const step = i >= 0 ? (argv[i + 1] as Step | undefined) : undefined;
  if (i >= 0 && step !== 'fetch' && step !== 'build') {
    throw new Error('usage: pipeline.ts [--step fetch|build] (default: both)');
  }
  return step ?? 'all';
}

export interface BuildResult {
  cards: unknown[];
  sets: unknown[];
  meta: object;
  report: object;
}

export function buildSnapshot(normalized: NormalizeResult, data: FetchResult, tagRulesVersion: number, generatedOn: string): BuildResult {
  applyTags(normalized.cards, loadTagRules(path.join(ROOT, 'scripts', 'tag-rules.json')));

  const perSetCounts: Record<string, { expected: number; actual: number }> = {};
  const rawSets = (data.allCards as { sets?: Record<string, { cardCounts?: { total?: number } }> }).sets ?? {};
  for (const card of normalized.cards) {
    const entry = perSetCounts[card.setCode] ?? { expected: 0, actual: 0 };
    entry.actual++;
    perSetCounts[card.setCode] = entry;
  }
  for (const [code, s] of Object.entries(rawSets)) {
    const expected = s.cardCounts?.total;
    if (typeof expected === 'number') {
      perSetCounts[code] = { expected, actual: perSetCounts[code]?.actual ?? 0 };
    }
  }

  const countsMismatch = Object.entries(perSetCounts)
    .filter(([, c]) => c.expected > 0 && c.actual !== c.expected)
    .map(([code, c]) => `${code}: ${c.actual}/${c.expected}`);
  if (countsMismatch.length > 0) {
    throw new Error(`per-set card count mismatch: ${countsMismatch.join(', ')}`);
  }

  const report = {
    generatedOn,
    ok: normalized.missingStory.length === 0 && data.checksums.every((c) => c.ok),
    cardCount: normalized.cards.length,
    perSetCounts,
    missingStory: normalized.missingStory,
    needsReview: normalized.needsReview,
    derivations: normalized.derivations,
    checksums: data.checksums,
  };

  const meta = {
    generatedOn,
    cardCount: normalized.cards.length,
    sources: {
      lorcanajson: { generatedOn: normalized.meta.generatedOn, formatVersion: normalized.meta.formatVersion },
      lorcast: { fetched: data.lorcastFetched },
    },
    tagRulesVersion,
  };

  return { cards: normalized.cards, sets: normalized.sets, meta, report };
}

export function assertPublishable(build: BuildResult): void {
  const report = build.report as { ok: boolean; missingStory: number[]; checksums: { ok: boolean }[] };
  if (!report.ok || report.missingStory.length > 0 || report.checksums.some((c) => !c.ok)) {
    throw new Error('validation report is not clean; blocking snapshot update');
  }
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const step = parseArgs(argv);

  if (step === 'fetch' || step === 'all') {
    const skipLorcast = process.env.SKIP_LORCAST === '1';
    const data = await fetchAll(CACHE_DIR, { skipLorcast });
    await saveCache(CACHE_DIR, data);
    console.log(
      `fetched: lorcanajson ok (checksum ${data.checksums[0]?.ok ? 'verified' : 'MISMATCH'}), ` +
        `lorcast sets: ${Object.keys(data.lorcastBySet).length}${data.lorcastFetched ? '' : ' (skipped/failed)'}`
    );
  }

  if (step === 'build' || step === 'all') {
    await runBuild();
  }
}

async function runBuild(): Promise<void> {
  const data = await loadCache(CACHE_DIR);
  const normalized = normalizeAll(data);
  const tagRules = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'tag-rules.json'), 'utf8')) as {
    version: number;
  };
  const generatedOn = new Date().toISOString();
  const build = buildSnapshot(normalized, data, tagRules.version, generatedOn);
  assertPublishable(build);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'cards.min.json'), JSON.stringify({ cards: build.cards }));
  await writeFile(path.join(OUT_DIR, 'sets.json'), JSON.stringify({ sets: build.sets }));
  await writeFile(path.join(OUT_DIR, 'meta.json'), JSON.stringify(build.meta));
  await writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(build.report));

  const report = build.report as { needsReview: unknown[]; derivations: unknown[] };
  console.log(
    `snapshot: ${build.cards.length} cards, ${build.sets.length} sets; ` +
      `needs-review: ${report.needsReview.length}, derived fields: ${report.derivations.length}`
  );

  // meta model artifact: emitted only when the offline training pipeline has
  // produced a gate-passing capability (relations or calibration); otherwise
  // the app runs deterministic-only
  const emit = await emitModel(ROOT);
  if (emit.emitted) console.log(`meta artifact: meta-model.json (${emit.bytes} gzip bytes)`);
  else console.log(`meta artifact: skipped — ${emit.reason}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
