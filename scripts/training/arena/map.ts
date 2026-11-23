/**
 * Regenerate the identity → engine card map and report coverage.
 *
 * Usage: npx tsx scripts/training/arena/map.ts
 *
 * Writes scripts/training/arena/card-map.json and merges the coverage section
 * into public/data/report.json (which must exist — run npm run data:build
 * first). Byte-stable output: no timestamps, sorted keys.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';

const MAP_PATH = resolve(import.meta.dirname, 'card-map.json');
const REPORT_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'public',
  'data',
  'report.json',
);

const cards = loadCards();
const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
const catalog = await loadEngineCatalog();
const map = buildCardMap({
  cards,
  alias,
  canonicalByGroup,
  engineById: catalog.byId,
  engineCommit: catalog.engineCommit,
});

const sorted = {
  format: map.format,
  engineCommit: map.engineCommit,
  byIdentity: Object.fromEntries(
    Object.entries(map.byIdentity).sort(([a], [b]) => Number(a) - Number(b)),
  ),
  coverage: map.coverage,
} as const;
writeFileSync(MAP_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

if (!existsSync(REPORT_PATH)) {
  throw new Error(`${REPORT_PATH} not found — run npm run data:build first`);
}
const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as Record<
  string,
  unknown
>;
report.arena = {
  engineCommit: map.engineCommit,
  identities: map.coverage.identities,
  mapped: map.coverage.mapped,
  mappedVia: map.coverage.mappedVia,
  ineligible: map.coverage.ineligible,
  missingImplementation: map.coverage.missingImplementation,
  coverageStatuses: map.coverage.coverageStatuses,
  partialIdentities: map.coverage.partialIdentities,
  statDriftGroups: map.coverage.statDriftGroups.length,
  perSet: map.coverage.perSet,
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report)}\n`);

const { coverage } = map;
console.log(
  JSON.stringify(
    {
      map: MAP_PATH,
      identities: coverage.identities,
      mapped: coverage.mapped,
      mappedVia: coverage.mappedVia,
      ineligible: coverage.ineligible,
      missingImplementation: coverage.missingImplementation,
      coverageStatuses: coverage.coverageStatuses,
      statDriftGroups: coverage.statDriftGroups.length,
    },
    null,
    1,
  ),
);
if (coverage.ineligible['name-mismatch'] > 0) {
  console.error(
    `needs-review: ${coverage.ineligible['name-mismatch']} identities hit an engine key but the name disagreed — snapshot numbering collision`,
  );
}
