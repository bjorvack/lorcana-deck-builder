/**
 * League evaluation CLI (self-play-league, task 3.2): score one candidate
 * deck against the league with paired seeds, common random numbers and SPRT
 * sequential stopping (see schedule.ts), playing real arena games.
 *
 * Usage:
 *   npx tsx scripts/training/arena/evaluate-candidate.ts \
 *     --league scripts/training/data/arena/selfplay/league-<commit8>.json \
 *     --deck <deck.txt> [--twin <mutation.txt>] \
 *     [--games-per-member 32] [--batch-size 8] [--master-seed 20261121] \
 *     [--referee best-deck-aware-lore-race] [--out <path>]
 *
 * Every simulated game is cached under the arena cache key (deck pair,
 * strategy pair, seed base, game count — design D4): completed member
 * schedules hit the cache on re-runs, and stopped schedules resume from
 * their cached prefix files instead of replaying decided games. Games run
 * sequentially in this process; MAP-Elites (task 4.3) adds batch.ts-style
 * parallelism per candidate on top.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AutomatedActionStrategy } from '@tcg/lorcana-engine/automation';
import type { Card } from '../../../src/data/types';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap, type CardMap } from './card-map';
import { loadCards } from './cards';
import { deckProblems, ineligibleIdentities, prepareDeck } from './deck-io';
import { type EngineCatalog, loadEngineCatalog } from './engine-cards';
import { loadLeague } from './league';
import { type GameRecord, playGame, strategyById } from './play';
import { cachePathFor, readCachedRecords } from './run';
import {
  type BatchGameRequest,
  type BatchGameResult,
  type BatchPlayer,
  DEFAULT_BATCH_SIZE,
  DEFAULT_GAMES_PER_MEMBER,
  DEFAULT_REFEREE,
  evaluateCandidateVsLeague,
  seedForGame,
} from './schedule';

interface EvalArgs {
  league: string;
  deck: string;
  twin: string | null;
  gamesPerMember: number;
  batchSize: number;
  masterSeed: number;
  referee: string;
  out: string | null;
}

function parseArgs(argv: string[]): EvalArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const args: EvalArgs = {
    league: get('--league') ? resolve(get('--league')!) : '',
    deck: get('--deck') ? resolve(get('--deck')!) : '',
    twin: get('--twin') ? resolve(get('--twin')!) : null,
    gamesPerMember: Number(
      get('--games-per-member') ?? DEFAULT_GAMES_PER_MEMBER,
    ),
    batchSize: Number(get('--batch-size') ?? DEFAULT_BATCH_SIZE),
    masterSeed: Number(get('--master-seed') ?? 20261121),
    referee: get('--referee') ?? DEFAULT_REFEREE,
    out: get('--out') ? resolve(get('--out')!) : null,
  };
  if (!args.league) throw new Error('--league <file> is required');
  if (!args.deck) throw new Error('--deck <file> is required');
  strategyById(args.referee);
  return args;
}

export interface CachedPlayerDeps {
  catalog: EngineCatalog;
  cardMap: CardMap;
  engineCommit: string;
  mapFormat: number;
  referee: string | AutomatedActionStrategy;
}

/**
 * Real batch player with the arena disk cache. Cache layout per (deck pair,
 * strategy pair, seed base): the run.ts `arena-2-<seedBase>-<games>.jsonl`
 * file holds records for games 0..games-1. Each batch checks its exact
 * cumulative count file, then the whole-schedule file, then warm-starts from
 * the previous count's file (a previous run's stop point or this run's
 * previous batch) — only the missing games are simulated, and cumulative
 * files are rewritten whenever a complete 0..target-1 set is available.
 */
export function cachedBatchPlayer(deps: CachedPlayerDeps): BatchPlayer {
  const strategyKey =
    typeof deps.referee === 'string' ? deps.referee : deps.referee.name;
  const strategies: [string, string] = [strategyKey, strategyKey];
  return (request: BatchGameRequest): BatchGameResult[] => {
    const { deckA, deckB, seedBase, from, count, scheduleCount, referee } =
      request;
    const target = from + count;
    const pathFor = (games: number): string =>
      cachePathFor({
        engineCommit: deps.engineCommit,
        mapFormat: deps.mapFormat,
        deckA,
        deckB,
        strategies,
        seedBase,
        games,
      });
    // whole-schedule fast path: a completed schedule serves every batch
    if (from === 0) {
      const full = readCachedRecords(pathFor(scheduleCount), scheduleCount);
      if (full) return full.slice(from, target);
    }
    const exact = readCachedRecords(pathFor(target), target);
    if (exact) return exact.slice(from, target);
    // warm start: records 0..from-1 from a smaller cumulative file
    let prefix: GameRecord[] = [];
    if (from > 0) {
      const cached = readCachedRecords(pathFor(from), from);
      if (cached) prefix = cached;
    }
    const records: GameRecord[] = [];
    for (let game = from; game < target; game++) {
      records.push(
        playGame({
          catalog: deps.catalog,
          cardMap: deps.cardMap,
          deckA,
          deckB,
          strategyA: referee,
          strategyB: referee,
          seed: seedForGame(seedBase, game),
          seedBase,
        }),
      );
    }
    // only rewrite a cumulative file when it can hold the full 0..target-1
    // prefix (otherwise a foreign cache state would be partially replicated)
    if (prefix.length >= from) {
      const all = [...prefix, ...records];
      // same ordering run.ts writes (lexicographic by seed)
      all.sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0));
      const path = pathFor(target);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''),
      );
    }
    return records;
  };
}

/** load + arena-gate a candidate/twin deck list into identity counts */
function loadArenaDeck(
  path: string,
  cards: Card[],
  alias: Map<number, number>,
  cardMap: CardMap,
): Record<string, number> {
  const deck = prepareDeck(path, cards, alias);
  const problems = deckProblems(deck, cardMap, cards);
  if (problems.length > 0) {
    throw new Error(
      `deck (${path}) is not arena-legal:\n  ${problems
        .map((p) => `${p.kind}: ${p.detail}`)
        .join('\n  ')}`,
    );
  }
  const missing = ineligibleIdentities(deck, cardMap, cards);
  if (missing.length > 0) {
    throw new Error(
      `deck (${path}) contains cards the engine cannot play:\n  ` +
        missing.map((m) => `${m.name} [${m.reason}]`).join('\n  '),
    );
  }
  return deck.cards;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
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
  const league = await loadLeague(args.league);
  if (league.engineCommit.slice(0, 8) !== catalog.engineCommit.slice(0, 8)) {
    throw new Error(
      `league era ${league.engineCommit.slice(0, 8)} ≠ engine era ${catalog.engineCommit.slice(0, 8)} — reseed the league`,
    );
  }

  const candidateDeck = loadArenaDeck(args.deck, cards, alias, cardMap);
  const twinDeck = args.twin
    ? loadArenaDeck(args.twin, cards, alias, cardMap)
    : undefined;

  const play = cachedBatchPlayer({
    catalog,
    cardMap,
    engineCommit: catalog.engineCommit,
    mapFormat: cardMap.format,
    referee: args.referee,
  });
  const evaluation = evaluateCandidateVsLeague(candidateDeck, league, {
    play,
    masterSeed: args.masterSeed,
    gamesPerMember: args.gamesPerMember,
    batchSize: args.batchSize,
    referee: args.referee,
    ...(twinDeck ? { twinDeck } : {}),
  });

  const report = {
    league: args.league,
    engineCommit: catalog.engineCommit,
    candidate: args.deck,
    ...(args.twin ? { twin: args.twin } : {}),
    masterSeed: args.masterSeed,
    gamesPerMember: args.gamesPerMember,
    batchSize: args.batchSize,
    referee: args.referee,
    ...evaluation,
  };
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 1)}\n`);
  }
  console.log(JSON.stringify(report, null, 1));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
