/**
 * Browser bundle for the engine-winrate feature (openspec change
 * engine-winrate): bundles the PINNED vendored engine + the shipped heuristic
 * bot strategy into a lazy-loadable ESM file under public/data/, so the deck
 * page can play real full-rules games in the browser.
 *
 *   npm run engine:bundle
 *
 * The vendored tree is imported only by training code (spec "Pinned vendored
 * engine with attribution"); this script is the one bridge that turns it into
 * a shipped static artifact. The runtime (src/stats/engine-winrate.ts) loads
 * the built file — never the vendor sources.
 *
 * Injected defines:
 * - __ENGINE_COMMIT__: the pinned upstream commit (PIN.md is the source of
 *   truth; the bundle refuses to build without it)
 * - __ENGINE_PIN_ATTRIBUTION__: upstream repo + license note (attribution
 *   travels with the shipped artifact)
 * - __ENGINE_IDENTITY_MAP__: our catalog print id → engine card id, computed
 *   from the arena card map so runtime decks (canonical print ids) feed the
 *   engine directly.
 *
 * Rebuild after every arena engine bump (the commit8 filename changes; the
 * stale bundle for the old commit is removed by this script).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';

const ARENA_DIR = import.meta.dirname;
const PUBLIC_DATA = resolve(ARENA_DIR, '..', '..', '..', 'public', 'data');
const ENTRY = join(ARENA_DIR, 'engine-bundle-entry.ts');
const STRATEGY_ID = 'best-deck-aware-lore-race';

async function main(): Promise<void> {
  const { engineCommit } = await loadEngineCatalog();
  const commit8 = engineCommit.slice(0, 8);
  const outfile = join(PUBLIC_DATA, `engine-bundle-${commit8}.js`);

  // identity map: every print of our catalog resolves through its identity's
  // engine mapping, so runtime decks (print ids) and league decks (canonical
  // ids) feed the engine through one table
  const cards = loadCards();
  const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
  const cardMap = buildCardMap({
    cards,
    alias,
    canonicalByGroup,
    engineById: (await loadEngineCatalog()).byId,
    engineCommit,
  });
  const identityMap: Record<string, string> = {};
  for (const card of cards) {
    const canonicalId = alias.get(card.id);
    if (canonicalId === undefined) continue;
    const entry = cardMap.byIdentity[String(canonicalId)];
    if (entry) identityMap[String(card.id)] = entry.engineId;
  }
  const mapped = Object.keys(identityMap).length;
  if (mapped === 0)
    throw new Error('identity map is empty — run npm run arena:map first?');

  const pin = readFileSync(
    resolve(ARENA_DIR, '..', 'vendor', 'PIN.md'),
    'utf8',
  );
  const attribution =
    /## Attribution\n([\s\S]*?)(\n\n|$)/.exec(pin)?.[1]?.trim() ?? '';
  if (!attribution.includes('TheCardGoat/tcg-engines'))
    throw new Error('PIN.md attribution section missing or changed');

  const started = Date.now();
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    outfile,
    logLevel: 'warning',
    define: {
      __ENGINE_COMMIT__: JSON.stringify(engineCommit),
      __ENGINE_PIN_ATTRIBUTION__: JSON.stringify(attribution),
      __ENGINE_IDENTITY_MAP__: JSON.stringify(identityMap),
    },
    // the bundle header carries the pin provenance (spec delta: commit +
    // attribution recorded with the shipped artifact)
    banner: {
      js: [
        '/* Lorcana engine bundle — engine-winrate feature.',
        ` * Engine: TheCardGoat/tcg-engines @ ${engineCommit}`,
        ' * Strategy: best-deck-aware-lore-race (heuristic bot, both seats).',
        ` * Attribution: ${attribution.replaceAll('\n', ' ')}`,
        ' * Rebuild with `npm run engine:bundle` after every arena engine bump.',
        ' */',
      ].join('\n'),
    },
  });

  // a bump leaves the previous commit's bundle behind — the runtime resolves
  // the file through the opponents artifact's commit, so stale files are dead
  // weight in public/data and are removed
  for (const file of readdirSync(PUBLIC_DATA)) {
    if (
      /^engine-bundle-[0-9a-f]{8}\.js$/.test(file) &&
      file !== `engine-bundle-${commit8}.js`
    ) {
      rmSync(join(PUBLIC_DATA, file));
      console.error(`removed stale bundle: ${file}`);
    }
  }

  const kb =
    (existsSync(outfile) ? readFileSync(outfile, 'utf8').length : 0) / 1024;
  console.error(
    `engine bundle: ${outfile} (${kb.toFixed(0)} KB, ${mapped} catalog ids mapped, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s, engine ${commit8})`,
  );
  // the commit the bundle was built from — callers (and the freshness test)
  // compare this against the opponents artifact
  writeFileSync(
    join(PUBLIC_DATA, 'engine-bundle.json'),
    `${JSON.stringify({ engineCommit, strategyId: STRATEGY_ID }, null, 1)}\n`,
  );
}

await main();
