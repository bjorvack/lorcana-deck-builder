/**
 * Generator A/B gate (M2): does trained synergy actually produce better
 * decks? Generates matched decks with and without the interactions
 * capability (same seeds, same starting conditions — only the scoring
 * differs) and plays both against the meta panel.
 *
 * Usage: npx tsx scripts/training/arena/ab.ts [--seeds 16] [--games 4]
 *        [--opponents 8] [--parallel 8]
 *
 * Work is split by seed across child processes (each worker generates and
 * plays only its own seeds). PASS requires the synergy variant's win-rate
 * uplift over the baseline to have a positive 95% CI lower bound (normal
 * approximation).
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DeckState, Ink } from '../../../src/data/types';
import { INKS } from '../../../src/data/types';
import { generateDeck } from '../../../src/generate/generator';
import { type MetaModel, parseMetaModel } from '../../../src/meta/infer';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import { playGame } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;
const PANEL_DIR = join(ARENA_DIR, 'panel');

export interface VariantStats {
  games: number;
  wins: number;
  winRate: number;
  /** 95% Wilson lower/upper bounds on the win rate */
  ciLow: number;
  ciHigh: number;
}

/** Wilson score interval — honest CIs for small samples near 0/1 */
export function proportionStats(wins: number, games: number): VariantStats {
  const z = 1.96;
  const p = games > 0 ? wins / games : 0;
  const denominator = 1 + (z * z) / games;
  const center = games > 0 ? (p + (z * z) / (2 * games)) / denominator : 0;
  const spread =
    games > 0
      ? (z / denominator) *
        Math.sqrt((p * (1 - p)) / games + (z * z) / (4 * games * games))
      : 0;
  return {
    games,
    wins,
    winRate: Math.round(p * 1000) / 1000,
    ciLow: Math.max(0, Math.round((center - spread) * 1000) / 1000),
    ciHigh: Math.min(1, Math.round((center + spread) * 1000) / 1000),
  };
}

export interface AbReport {
  seeds: number;
  opponents: number;
  gamesPerMatchup: number;
  baseline: VariantStats;
  synergy: VariantStats;
  /** synergy win rate − baseline win rate */
  uplift: number;
  /** 95% CI on the uplift (normal approximation, independent samples) */
  upliftCiLow: number;
  upliftCiHigh: number;
  pass: boolean;
  illegalDecks: number;
}

export function aggregate(
  baseline: { wins: number; games: number },
  synergy: { wins: number; games: number },
  illegalDecks: number,
  config: { seeds: number; opponents: number; gamesPerMatchup: number },
): AbReport {
  const base = proportionStats(baseline.wins, baseline.games);
  const syn = proportionStats(synergy.wins, synergy.games);
  const uplift = Math.round((syn.winRate - base.winRate) * 1000) / 1000;
  const se = Math.sqrt(
    (base.winRate * (1 - base.winRate)) / Math.max(1, base.games) +
      (syn.winRate * (1 - syn.winRate)) / Math.max(1, syn.games),
  );
  const upliftCiLow = Math.round((uplift - 1.96 * se) * 1000) / 1000;
  const upliftCiHigh = Math.round((uplift + 1.96 * se) * 1000) / 1000;
  return {
    seeds: config.seeds,
    opponents: config.opponents,
    gamesPerMatchup: config.gamesPerMatchup,
    baseline: base,
    synergy: syn,
    uplift,
    upliftCiLow,
    upliftCiHigh,
    pass: upliftCiLow > 0,
    illegalDecks,
  };
}

/** ink pairs in deterministic order — the seed picks the archetype */
const INK_PAIRS: Array<[Ink, Ink]> = INKS.flatMap((a, i) =>
  INKS.slice(i + 1).map((b) => [a, b] as [Ink, Ink]),
);

function toIdentityCounts(
  deck: DeckState,
  alias: Map<number, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [printId, count] of Object.entries(deck.cards) as Array<
    [string, number]
  >) {
    const identity = alias.get(Number(printId));
    if (identity === undefined) continue;
    out[String(identity)] = (out[String(identity)] ?? 0) + count;
  }
  return out;
}

/** the baseline variant: identical model with the interactions capability off */
function stripInteractions(model: MetaModel): MetaModel {
  return {
    ...model,
    capabilities: { ...model.capabilities, interactions: false },
    interactions: undefined,
  };
}

interface Args {
  seeds: number;
  games: number;
  opponents: number;
  novelty: number;
  synergyWeight: number;
  parallel: number;
  workerIndex: number;
  workerCount: number;
  part: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    seeds: Number(get('--seeds') ?? 16),
    games: Number(get('--games') ?? 4),
    opponents: Number(get('--opponents') ?? 8),
    novelty: Number(get('--novelty') ?? 0.5),
    synergyWeight: Number(get('--synergy-weight') ?? 0.25),
    parallel: Math.max(1, Number(get('--parallel') ?? 1)),
    workerIndex: Number(get('--worker-index') ?? 0),
    workerCount: Number(get('--worker-count') ?? 1),
    part: get('--part') ? resolve(get('--part')!) : null,
  };
}

interface SeedPair {
  baseline: Record<string, number>;
  synergy: Record<string, number>;
}

/** generate the matched deck pair for one seed (illegal decks → empty) */
function generatePair(
  cards: Parameters<typeof generateDeck>[0]['cards'],
  model: MetaModel,
  baselineModel: MetaModel,
  alias: Map<number, number>,
  seed: number,
  novelty: number,
  synergyWeight: number,
): { pair: SeedPair | null; illegal: number } {
  const inks = INK_PAIRS[seed % INK_PAIRS.length]!;
  const opts = {
    cards,
    inks: [...inks] as [Ink, Ink],
    format: 'core' as const,
    seed: 1000 + seed,
    novelty,
    targetSize: 60,
  };
  const synergyDeck = generateDeck({ ...opts, model, synergyWeight });
  const baselineDeck = generateDeck({ ...opts, model: baselineModel });
  let illegal = 0;
  for (const result of [synergyDeck, baselineDeck]) {
    if (
      !result.deck ||
      Object.values(result.deck.cards).reduce((a, b) => a + b, 0) !== 60
    )
      illegal += 1;
  }
  if (!synergyDeck.deck || !baselineDeck.deck) return { pair: null, illegal };
  return {
    pair: {
      baseline: toIdentityCounts(baselineDeck.deck, alias),
      synergy: toIdentityCounts(synergyDeck.deck, alias),
    },
    illegal,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modelPath = resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'public',
    'data',
    'meta-model.json',
  );
  if (!existsSync(modelPath))
    throw new Error(
      'public/data/meta-model.json missing — run train + emit first',
    );
  const fullModel = parseMetaModel(JSON.parse(readFileSync(modelPath, 'utf8')));
  if (!fullModel) throw new Error('meta model failed to parse');
  if (fullModel.capabilities.interactions !== true)
    throw new Error(
      'the current artifact does not carry the interactions capability — nothing to A/B',
    );
  const baselineModel = stripInteractions(fullModel);

  const manifest = JSON.parse(
    readFileSync(join(PANEL_DIR, 'panel.json'), 'utf8'),
  ) as { decks: Array<{ file: string; cards: Record<string, number> }> };
  const panel = manifest.decks.slice(0, args.opponents);
  if (panel.length < 2)
    throw new Error('panel missing — run arena:panel first');

  // ---- worker mode: play my seeds' games, tally per variant, write part ----
  if (args.workerCount > 1 && args.part) {
    const cards = loadCards();
    const { alias } = buildCanonicalRegistry(cards);
    const catalog = await loadEngineCatalog();
    const cardMap = buildCardMap({
      cards,
      alias,
      canonicalByGroup: buildCanonicalRegistry(cards).canonicalByGroup,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const lines: string[] = [];
    for (let s = args.workerIndex; s < args.seeds; s += args.workerCount) {
      const { pair } = generatePair(
        cards,
        fullModel,
        baselineModel,
        alias,
        s,
        args.novelty,
        args.synergyWeight,
      );
      if (!pair) continue;
      for (let o = 0; o < panel.length; o++) {
        for (let g = 0; g < args.games; g++) {
          const even = g % 2 === 0;
          const base = playGame({
            catalog,
            cardMap,
            deckA: even ? pair.baseline : panel[o]!.cards,
            deckB: even ? panel[o]!.cards : pair.baseline,
            strategyA: 'best-deck-aware-lore-race',
            strategyB: 'best-deck-aware-lore-race',
            seed: `ab-${s}-${o}-${g}-base`,
          });
          const syn = playGame({
            catalog,
            cardMap,
            deckA: even ? pair.synergy : panel[o]!.cards,
            deckB: even ? panel[o]!.cards : pair.synergy,
            strategyA: 'best-deck-aware-lore-race',
            strategyB: 'best-deck-aware-lore-race',
            seed: `ab-${s}-${o}-${g}-syn`,
          });
          lines.push(
            JSON.stringify({
              v: 'base',
              w: base.winner === (even ? 'p1' : 'p2') ? 1 : 0,
            }),
            JSON.stringify({
              v: 'syn',
              w: syn.winner === (even ? 'p1' : 'p2') ? 1 : 0,
            }),
          );
        }
      }
    }
    mkdirSync(dirname(args.part), { recursive: true });
    writeFileSync(args.part, lines.join('\n') + (lines.length ? '\n' : ''));
    return;
  }

  // ---- parent mode ----
  const cards = loadCards();
  const { alias } = buildCanonicalRegistry(cards);
  const catalog = await loadEngineCatalog();
  const cardMap = buildCardMap({
    cards,
    alias,
    canonicalByGroup: buildCanonicalRegistry(cards).canonicalByGroup,
    engineById: catalog.byId,
    engineCommit: catalog.engineCommit,
  });

  const tally = {
    baseline: { wins: 0, games: 0 },
    synergy: { wins: 0, games: 0 },
  };
  let illegalDecks = 0;
  const generated: Array<SeedPair | null> = [];
  for (let s = 0; s < args.seeds; s++) {
    const { pair, illegal } = generatePair(
      cards,
      fullModel,
      baselineModel,
      alias,
      s,
      args.novelty,
      args.synergyWeight,
    );
    illegalDecks += illegal;
    generated.push(pair);
  }

  if (args.parallel === 1) {
    for (const [s, pair] of generated.entries()) {
      if (!pair) continue;
      for (let o = 0; o < panel.length; o++) {
        for (let g = 0; g < args.games; g++) {
          const even = g % 2 === 0;
          const base = playGame({
            catalog,
            cardMap,
            deckA: even ? pair.baseline : panel[o]!.cards,
            deckB: even ? panel[o]!.cards : pair.baseline,
            strategyA: 'best-deck-aware-lore-race',
            strategyB: 'best-deck-aware-lore-race',
            seed: `ab-${s}-${o}-${g}-base`,
          });
          const syn = playGame({
            catalog,
            cardMap,
            deckA: even ? pair.synergy : panel[o]!.cards,
            deckB: even ? panel[o]!.cards : pair.synergy,
            strategyA: 'best-deck-aware-lore-race',
            strategyB: 'best-deck-aware-lore-race',
            seed: `ab-${s}-${o}-${g}-syn`,
          });
          tally.baseline.games += 1;
          tally.synergy.games += 1;
          tally.baseline.wins += base.winner === (even ? 'p1' : 'p2') ? 1 : 0;
          tally.synergy.wins += syn.winner === (even ? 'p1' : 'p2') ? 1 : 0;
        }
      }
    }
  } else {
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const self = fileURLToPath(import.meta.url);
    // per-invocation dir: concurrent A/B runs must not delete each other's parts
    const partDir = join(ARENA_DIR, '.ab-parts', String(process.pid));
    mkdirSync(partDir, { recursive: true });
    const parts: string[] = [];
    try {
      await Promise.all(
        Array.from({ length: args.parallel }, (_, w) => {
          const part = join(partDir, `ab-${w}.jsonl`);
          parts.push(part);
          return execFileAsync(process.execPath, [
            tsxCli,
            self,
            '--seeds',
            String(args.seeds),
            '--games',
            String(args.games),
            '--opponents',
            String(args.opponents),
            '--novelty',
            String(args.novelty),
            '--parallel',
            String(args.parallel),
            '--worker-index',
            String(w),
            '--worker-count',
            String(args.parallel),
            '--part',
            part,
          ]);
        }),
      );
    } catch (error) {
      for (const part of parts) rmSync(part, { force: true });
      rmSync(partDir, { recursive: true, force: true });
      throw error;
    }
    for (const part of parts) {
      if (!existsSync(part)) continue;
      for (const line of readFileSync(part, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { v: 'base' | 'syn'; w: 0 | 1 };
        const key = entry.v === 'base' ? 'baseline' : 'synergy';
        tally[key].games += 1;
        tally[key].wins += entry.w;
      }
      rmSync(part, { force: true });
    }
    rmSync(partDir, { recursive: true, force: true });
  }

  const report = aggregate(tally.baseline, tally.synergy, illegalDecks, {
    seeds: args.seeds,
    opponents: args.opponents,
    gamesPerMatchup: args.games,
  });
  console.log(JSON.stringify(report, null, 1));
  console.error(
    `A/B: synergy ${report.synergy.winRate} vs baseline ${report.baseline.winRate} ` +
      `(uplift ${report.uplift}, CI [${report.upliftCiLow}, ${report.upliftCiHigh}]) → ${report.pass ? 'PASS' : 'FAIL'}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
