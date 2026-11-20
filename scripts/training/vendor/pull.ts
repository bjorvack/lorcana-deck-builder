/**
 * Pull the vendored CardGoat lorcana engine subset into scripts/training/vendor.
 *
 * Usage: npx tsx scripts/training/vendor/pull.ts <path-to-tcg-engines-checkout>
 *
 * Applies the exclusion rules recorded in PIN.md (tests, unused packages,
 * heavy localization data) so the committed vendor tree stays minimal and
 * reproducible for engine bumps. Never edits upstream sources; the only
 * vendored additions live in stubs/.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const checkout = resolve(process.argv[2] ?? '');
if (!existsSync(checkout)) throw new Error(`checkout not found: ${checkout}`);

const vendor = import.meta.dirname;
const lorcana = join(checkout, 'submodules/lorcana/packages/lorcana');
const agnostic = join(checkout, 'submodules/agnostic-simulator/packages');

const pin = readFileSync(join(vendor, 'PIN.md'), 'utf8');
const pinnedCommit = /Upstream commit: `([0-9a-f]{40})`/.exec(pin)?.[1];
if (!pinnedCommit) throw new Error('PIN.md is missing the "Upstream commit" line');
const headCommit = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (pinnedCommit !== headCommit)
  throw new Error(
    `PIN.md pins ${pinnedCommit.slice(0, 8)} but checkout HEAD is ${headCommit.slice(0, 8)}. ` +
      'Check out the pinned commit (or update PIN.md) and re-run.',
  );

const skipTests = (name: string): boolean => name.endsWith('.test.ts');

interface CopyJob {
  from: string;
  to: string;
  filter?: (name: string) => boolean;
}

const jobs: CopyJob[] = [
  { from: join(agnostic, 'shared/src'), to: 'shared/src', filter: skipTests },
  { from: join(agnostic, 'bot-core/src'), to: 'bot-core/src', filter: skipTests },
  { from: join(agnostic, 'protocol/src'), to: 'protocol/src', filter: skipTests },
  { from: join(agnostic, 'shared/package.json'), to: 'shared/package.json' },
  { from: join(agnostic, 'bot-core/package.json'), to: 'bot-core/package.json' },
  { from: join(agnostic, 'protocol/package.json'), to: 'protocol/package.json' },
  { from: join(lorcana, 'lorcana-types/src'), to: 'lorcana-types/src', filter: skipTests },
  { from: join(lorcana, 'lorcana-types/package.json'), to: 'lorcana-types/package.json' },
  { from: join(lorcana, 'lorcana-engine/src'), to: 'lorcana-engine/src', filter: skipTests },
  { from: join(lorcana, 'lorcana-engine/package.json'), to: 'lorcana-engine/package.json' },
  {
    from: join(lorcana, 'lorcana-cards/src/cards'),
    to: 'lorcana-cards/src/cards',
    filter: skipTests,
  },
  { from: join(lorcana, 'lorcana-cards/src/helpers'), to: 'lorcana-cards/src/helpers' },
  {
    from: join(lorcana, 'lorcana-cards/src/utils'),
    to: 'lorcana-cards/src/utils',
    filter: skipTests,
  },
  { from: join(lorcana, 'lorcana-cards/src/index.ts'), to: 'lorcana-cards/src/index.ts' },
  { from: join(lorcana, 'lorcana-cards/package.json'), to: 'lorcana-cards/package.json' },
];

for (const { from, to, filter } of jobs) {
  if (!existsSync(from)) throw new Error(`missing in checkout: ${from}`);
  const dest = join(vendor, to);
  rmSync(dest, { recursive: true, force: true });
  cpSync(from, dest, {
    recursive: true,
    filter: (src) => {
      if (src.includes('/node_modules/')) return false;
      if (filter && statSync(src).isFile() && filter(src.split('/').pop() ?? '')) return false;
      return true;
    },
  });
  console.log(`pulled ${to}`);
}

// npm cannot resolve upstream's internal (link:/workspace:/catalog:) refs and
// private @tcg/* names from a file: dep — those packages are provided at the
// repo root instead, and upstream devDependencies are irrelevant at runtime.
const manifestDirs = [
  'bot-core',
  'shared',
  'protocol',
  'lorcana-types',
  'lorcana-engine',
  'lorcana-cards',
];
for (const manifest of manifestDirs) {
  const path = join(vendor, manifest, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    if (pkg[section]) {
      for (const name of Object.keys(pkg[section])) {
        const value: string = pkg[section][name] ?? '';
        if (name.startsWith('@tcg/') || /^(link:|workspace:|catalog:)/.test(value))
          delete pkg[section][name];
      }
      if (Object.keys(pkg[section]).length === 0) delete pkg[section];
    }
  }
  delete pkg.devDependencies;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log('vendor subset updated');
