/**
 * M2 close-out / meta convergence: evolutionary deck optimization with the
 * arena as fitness.
 *
 * Population: seeded from the meta panel. Mutations guided by the trained
 * interactions table (synergy swaps) + legality-preserving random swaps and
 * count adjustments. Fitness: win rate vs anchor set A (top panel decks).
 * Final gate: top evolved decks vs anchor set B — the DISJOINT panel decks —
 * fresh seeds, PASS = CI low > 0.5 (evolution must generalize beyond the
 * opponents it evolved against).
 *
 * Usage:
 *   npx tsx scripts/training/arena/evolve.ts \
 *     [--generations 6] [--population 24] [--games-per-candidate 16] \
 *     [--parallel 6] [--seed 20261121]
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Card } from '../../../src/data/types';
import { buildCanonicalRegistry } from '../canonical';
import { mulberry32 } from '../prng';
import { proportionStats } from './ab';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import {
  deckSignature,
  legalIdentities,
  type MutationContext,
  mutateDeck,
} from './evolve-mutation';
import { playGame, strategyById } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;
const OUT_DIR = resolve(ARENA_DIR, '..', 'data', 'arena', 'evolution');
const STRATEGY_ID = 'best-deck-aware-lore-race';
const STRATEGY = STRATEGY_ID;

interface Args {
  generations: number;
  population: number;
  gamesPerCandidate: number;
  parallel: number;
  seed: number;
}

interface Individual {
  cards: Record<string, number>;
  inks: string[];
  signature: string;
  origin: string;
}

interface FitnessEntry {
  index: number;
  wins: number;
  games: number;
}

/** child-mode assignment file shape */
interface EvalChunk {
  assignments: Array<{ index: number; cards: Record<string, number> }>;
  anchors: Array<Record<string, number>>;
  seedBase: number;
  gamesPerAnchor: number;
}

/** fitness vs anchors: seat-balanced, deterministic per (deck, seedBase) */
function fitnessFor(
  deck: Record<string, number>,
  anchors: Array<Record<string, number>>,
  seedBase: number,
  gamesPerAnchor: number,
  catalog: Parameters<typeof playGame>[0]['catalog'],
  cardMap: Parameters<typeof playGame>[0]['cardMap'],
  strategy: ReturnType<typeof strategyById>,
): { wins: number; games: number } {
  let wins = 0;
  let games = 0;
  anchors.forEach((anchor, index) => {
    for (let g = 0; g < gamesPerAnchor; g++) {
      const even = (index + g) % 2 === 0;
      const record = playGame({
        catalog,
        cardMap,
        deckA: even ? deck : anchor,
        deckB: even ? anchor : deck,
        strategyA: strategy,
        strategyB: strategy,
        seed: `ev-${seedBase}-${index}-${g}`,
      });
      const deckSeat = even ? 'p1' : 'p2';
      wins += record.winner === deckSeat ? 1 : 0;
      games += 1;
    }
  });
  return { wins, games };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  // ---- child mode: evaluate assigned decks, write fitness lines, exit ----
  const evalChunkPath = get('--eval-chunk');
  if (evalChunkPath) {
    const anchorsPath = get('--anchors')!;
    const partPath = get('--part')!;
    const chunk = JSON.parse(readFileSync(evalChunkPath, 'utf8')) as EvalChunk;
    const cards = loadCards();
    const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
    const catalog = await loadEngineCatalog();
    const cardMap = buildCardMap({
      cards,
      alias,
      canonicalByGroup,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const strategy = strategyById(STRATEGY);
    const lines: string[] = [];
    for (const { index, cards: deckCards } of chunk.assignments) {
      const fitness = fitnessFor(
        deckCards,
        chunk.anchors,
        chunk.seedBase,
        chunk.gamesPerAnchor,
        catalog,
        cardMap,
        strategy,
      );
      lines.push(JSON.stringify({ index, ...fitness }));
    }
    mkdirSync(resolve(partPath, '..'), { recursive: true });
    writeFileSync(partPath, lines.join('\n') + (lines.length ? '\n' : ''));
    return;
  }

  // ---- parent mode ----
  const args: Args = {
    generations: Number(get('--generations') ?? 6),
    population: Number(get('--population') ?? 24),
    gamesPerCandidate: Number(get('--games-per-candidate') ?? 16),
    parallel: Math.max(1, Number(get('--parallel') ?? 6)),
    seed: Number(get('--seed') ?? 20261121),
  };
  const rng = mulberry32(args.seed);

  const cards = loadCards();
  const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
  const catalog = await loadEngineCatalog();
  const cardMap = buildCardMap({
    cards,
    alias,
    canonicalByGroup,
    engineById: catalog.byId,
    engineCommit: catalog.engineCommit,
  });
  const modelPath = resolve(
    ARENA_DIR,
    '..',
    '..',
    '..',
    'public',
    'data',
    'meta-model.json',
  );
  const model = JSON.parse(readFileSync(modelPath, 'utf8')) as {
    interactions?: { partners: Record<string, Array<[number, number]>> } | null;
  };
  const mutationCtx: MutationContext = {
    legalByIdentity: legalIdentities(cards, cardMap),
    interactions: model.interactions ?? null,
  };

  const panel = JSON.parse(
    readFileSync(join(ARENA_DIR, 'panel', 'panel.json'), 'utf8'),
  ) as {
    decks: Array<{
      file: string;
      winRate: number;
      cards: Record<string, number>;
    }>;
  };

  // anchors: A drives fitness, B is the held-out gate set (disjoint)
  const anchorsA = panel.decks.slice(0, 8).map((d) => d.cards);
  const anchorsB = panel.decks.slice(8, 16).map((d) => d.cards);

  // ---- initial population: panel decks + synergy-mutated copies ----
  const seen = new Set<string>();
  let population: Individual[] = [];
  for (const d of panel.decks) {
    const signature = deckSignature(d.cards);
    if (seen.has(signature)) continue;
    seen.add(signature);
    population.push({
      cards: d.cards,
      inks: [],
      signature,
      origin: `panel:${d.file}`,
    });
  }
  while (population.length < args.population) {
    const parent = population[Math.floor(rng() * population.length)]!;
    const mutated = mutateDeck(parent.cards, parent.inks, mutationCtx, rng);
    if (!mutated) continue;
    const signature = deckSignature(mutated);
    if (seen.has(signature)) continue;
    seen.add(signature);
    population.push({
      cards: mutated,
      inks: parent.inks,
      signature,
      origin: `mut:${parent.origin}`,
    });
  }
  population = population.slice(0, args.population);

  // ---- generation evaluation via parallel children ----
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const self = fileURLToPath(import.meta.url);
  const evaluatePopulation = async (
    pop: Individual[],
    generation: number,
  ): Promise<Array<FitnessEntry>> => {
    const workers = Math.max(1, Math.min(args.parallel, pop.length));
    const assignments: Array<
      Array<{ index: number; cards: Record<string, number> }>
    > = Array.from({ length: workers }, () => []);
    pop.forEach((individual, index) => {
      assignments[index % workers]!.push({
        index,
        cards: individual.cards,
      });
    });
    const partDir = join(OUT_DIR, `.parts-${args.seed}-${generation}`);
    mkdirSync(partDir, { recursive: true });
    const parts: string[] = [];
    try {
      await Promise.all(
        assignments.map(async (assignment, w) => {
          const chunkPath = join(partDir, `chunk-${w}.json`);
          const part = join(partDir, `fit-${w}.json`);
          parts.push(part);
          writeFileSync(
            chunkPath,
            JSON.stringify({
              assignments: assignment,
              anchors: anchorsA,
              seedBase: args.seed + generation * 1000,
              gamesPerAnchor: Math.max(
                1,
                Math.round(args.gamesPerCandidate / anchorsA.length),
              ),
            } satisfies EvalChunk),
          );
          return execFileAsync(process.execPath, [
            tsxCli,
            self,
            '--eval-chunk',
            chunkPath,
            '--anchors',
            join(partDir, `anchors-${w}.json`),
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
    const fitness: FitnessEntry[] = [];
    for (const part of parts) {
      if (!existsSync(part)) continue;
      for (const line of readFileSync(part, 'utf8').split('\n')) {
        if (line.trim()) fitness.push(JSON.parse(line) as FitnessEntry);
      }
      rmSync(part, { force: true });
    }
    rmSync(partDir, { recursive: true, force: true });
    return fitness;
  };

  // ---- evolution loop ----
  const strategy = strategyById(STRATEGY) as unknown as Parameters<
    typeof playGame
  >[0]['strategyA'];
  const history: Array<{
    generation: number;
    bestWins: number;
    meanWins: number;
    games: number;
  }> = [];

  for (let generation = 1; generation <= args.generations; generation++) {
    const fitness = await evaluatePopulation(population, generation);
    const ranked = population
      .map((individual, index) => ({
        individual,
        fitness: fitness.find((f) => f.index === index) ?? {
          index,
          wins: 0,
          games: 1,
        },
      }))
      .sort(
        (a, b) =>
          b.fitness.wins / Math.max(1, b.fitness.games) -
          a.fitness.wins / Math.max(1, a.fitness.games),
      );
    const best = ranked[0]!;
    const meanWins =
      ranked.reduce((sum, r) => sum + r.fitness.wins, 0) /
      Math.max(
        1,
        ranked.reduce((s, r) => s + r.fitness.games, 0),
      );
    history.push({
      generation,
      bestWins: best.fitness.wins,
      meanWins: Math.round(meanWins * 100) / 100,
      games: best.fitness.games,
    });
    console.error(
      `generation ${generation}: best ${best.fitness.wins}/${best.fitness.games}, mean ${meanWins.toFixed(2)}`,
    );

    if (generation >= args.generations) break;

    // selection: elites copied, top half breeds, fresh panel re-seeds for
    // diversity
    const survivors = ranked.slice(
      0,
      Math.max(2, Math.floor(args.population / 2)),
    );
    const next: Individual[] = survivors.slice(0, 2).map((s) => ({
      cards: { ...s.individual.cards },
      inks: s.individual.inks,
      signature: s.individual.signature,
      origin: `elite-g${generation}:${s.individual.origin}`,
    }));
    const nextSeen = new Set(next.map((n) => n.signature));
    while (next.length < args.population) {
      const parent =
        survivors[Math.floor(rng() * survivors.length)]!.individual;
      const mutated = mutateDeck(parent.cards, parent.inks, mutationCtx, rng);
      if (!mutated) continue;
      const signature = deckSignature(mutated);
      if (nextSeen.has(signature)) continue;
      nextSeen.add(signature);
      next.push({
        cards: mutated,
        inks: parent.inks,
        signature,
        origin: `mut-g${generation}:${parent.origin}`,
      });
    }
    population = next.slice(0, args.population);
  }

  // ---- final gate: top-4 evolved decks vs held-out anchors B ----
  const finalFitness = await evaluatePopulation(
    population,
    args.generations + 1,
  );
  const ranked = population
    .map((individual, index) => ({
      individual,
      fitness: finalFitness.find((f) => f.index === index) ?? {
        index,
        wins: 0,
        games: 1,
      },
    }))
    .sort(
      (a, b) =>
        b.fitness.wins / Math.max(1, b.fitness.games) -
        a.fitness.wins / Math.max(1, a.fitness.games),
    );
  const top4 = ranked.slice(0, 4);
  let gateWins = 0;
  let gateGames = 0;
  top4.forEach(({ individual }, deckIndex) => {
    anchorsB.forEach((anchor, o) => {
      for (let g = 0; g < 2; g++) {
        const even = (deckIndex + o + g) % 2 === 0;
        const record = playGame({
          catalog,
          cardMap,
          deckA: even ? individual.cards : anchor,
          deckB: even ? anchor : individual.cards,
          strategyA: strategy,
          strategyB: strategy,
          seed: `gate-${deckIndex}-${o}-${g}`,
        });
        gateGames += 1;
        gateWins += record.winner === (even ? 'p1' : 'p2') ? 1 : 0;
      }
    });
  });
  const gateStats = proportionStats(gateWins, gateGames);
  const pass = gateStats.ciLow > 0.5;

  // ---- records ----
  const result = {
    seed: args.seed,
    generations: args.generations,
    population: args.population,
    gamesPerCandidate: args.gamesPerCandidate,
    history,
    gate: {
      games: gateGames,
      tunedWins: gateWins,
      winRate: gateStats.winRate,
      ciLow: gateStats.ciLow,
      ciHigh: gateStats.ciHigh,
      passed: pass,
    },
    topDecks: top4.map(({ individual, fitness }) => ({
      origin: individual.origin,
      signature: individual.signature,
      cards: individual.cards,
      inks: individual.inks,
      trainWins: fitness.wins,
      trainGames: fitness.games,
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `evolution-${args.seed}.json`);
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  const byId = new Map(cards.map((c) => [c.id, c]));
  top4.forEach(({ individual }, i) => {
    const lines = Object.entries(individual.cards)
      .map(([identity, count]) => ({ card: byId.get(Number(identity)), count }))
      .filter((e): e is { card: Card; count: number } => e.card !== undefined)
      .sort(
        (a, b) =>
          b.count - a.count || a.card.fullName.localeCompare(b.card.fullName),
      )
      .map((e) => `${e.count}x ${e.card.fullName}`);
    writeFileSync(
      join(OUT_DIR, `evolved-${i + 1}.txt`),
      `${lines.join('\n')}\n`,
    );
  });
  console.log(JSON.stringify({ out, gate: result.gate }, null, 1));
  console.error(
    `gate: evolved ${gateStats.winRate} vs held-out anchors (CI [${gateStats.ciLow}, ${gateStats.ciHigh}]) → ${pass ? 'PASS' : 'FAIL'}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
