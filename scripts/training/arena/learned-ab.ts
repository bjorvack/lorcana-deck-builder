/**
 * Matched A/B gate for the learned deck completion (learned-deck-generator,
 * tasks 5.1/5.2; design D6; spec learned-deck-completion "A/B gate before
 * shipping").
 *
 * Matched generation: for every deck-pair the learned variant and the shipped
 * variant run the SAME generateDeck options (same seed, same conditioning,
 * same meta model) — only the fill source differs (gate-forced learned
 * artifact vs the shipped suggest-fill scoring, learnedModel undefined).
 * Every generated deck is legality-gated (arena deckProblems + ineligible
 * identities + the conditioning's relaxation notes must be empty); any
 * illegality is gate-fail evidence, never silently dropped.
 *
 * Matched play: both decks of a pair play the full 10-member league from
 * seat p1 on identical per-member seed bases (schedule.ts CRN), heuristic
 * referee, fixed 8 games per member (no SPRT — fixed budget). Deck-pair
 * master seeds are fresh and disjoint from every prior run's seed ranges
 * (see SEED documentation below).
 *
 * Verdict (pre-committed): PASS = no illegal decks AND the aggregate
 * uplift win-rate 95% CI lower bound > 0 (bootstrap percentile interval,
 * cluster-resampled over deck-pairs — the seed-pool draws — because games
 * within a pair are correlated). Per-regime uplift CIs are reported next to
 * the aggregate so a model that only wins the easy regime cannot hide.
 *
 * Seed ranges (disjointness evidence): all prior training/selection runs
 * consumed master seeds ≤ ~20.3 M (league/self-play 20261121-22, restricted
 * pools 20261123..27, sweep 20261130, deltas 20261123 with +9,000 member
 * spacing, slices 20262023..30; acceptance used fresh bases ≥ 70.3 M). This
 * gate uses 30.0 M+ — outside every documented range on both sides.
 *
 * Resume contract: deck generation is deterministic per seed, and every
 * completed member schedule is served from the arena disk cache — a killed
 * run re-invoked with identical flags replays only the missing games.
 *
 * Usage (detached, parallel ≤ 3 while the IS-MCTS gate runs):
 *   npx tsx scripts/training/arena/learned-ab.ts \
 *     --league <league.json> [--parallel 3] [--out <report.json>]
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
import type { Card, Ink } from '../../../src/data/types';
import { generateDeck } from '../../../src/generate/generator';
import { parseGeneratorModel } from '../../../src/generate/learned-fill';
import { type MetaModel, parseMetaModel } from '../../../src/meta/infer';
import { buildCanonicalRegistry } from '../canonical';
import { mulberry32 } from '../prng';
import { buildCardMap, type CardMap } from './card-map';
import { loadCards } from './cards';
import { deckProblems, ineligibleIdentities } from './deck-io';
import { loadEngineCatalog } from './engine-cards';
import { cachedBatchPlayer } from './evaluate-candidate';
import { loadLeague } from './league';
import { DEFAULT_REFEREE, evaluateCandidateVsLeague } from './schedule';

const execFileAsync = promisify(execFile);

// ---- pre-committed gate parameters (task 5.1) ----

/** generation seeds: 30.0 M + pair index (deck-pair draw from the seed pool) */
export const AB_GEN_SEED_BASE = 30_000_000;
/** play master seeds: 30.1 M + pairIndex × 10,000 (member bases +1,000 each) */
export const AB_PLAY_SEED_BASE = 30_100_000;
export const AB_PLAY_SEED_STRIDE = 10_000;
/** cluster-bootstrap replicate stream (mulberry32) */
export const AB_BOOTSTRAP_SEED = 30_200_000;
export const BOOTSTRAP_REPLICATES = 10_000;
export const PAIRS_PER_REGIME = 4;
export const AB_GAMES_PER_MEMBER = 8;
export const AB_BATCH_SIZE = 8;

export const DEFAULT_AB_OUT = resolve(
  import.meta.dirname,
  '..',
  'data',
  'generator',
  'learned-ab-6de59de1.json',
);

// ---- regime construction (the three user-facing conditioning surfaces) ----

export interface AbRegime {
  name: 'unrestricted' | 'declared-inks' | 'franchise';
  description: string;
  inks?: [Ink, Ink];
  franchises?: string[];
}

const RUBY_SAPPHIRE: [Ink, Ink] = ['Ruby', 'Sapphire'];
const AMETHYST_EMERALD: [Ink, Ink] = ['Amethyst', 'Emerald'];

/** the two feasible franchise filters (probed: Aladdin relaxes at runtime) */
const FRANCHISE_PAIRS: readonly string[][] = [['Frozen'], ['Lilo & Stitch']];

/**
 * The 12 deck-pairs: 4 unrestricted, 4 declared-inks (2 per representative
 * ink pair — the corpus's ink pools), 4 franchise-filtered (the two feasible
 * franchises — Frozen and Lilo & Stitch complete without filter relaxation;
 * Aladdin relaxes at runtime and is excluded). Feasibility was probed with
 * the shipped generator before the pre-commit.
 */
export function regimeForPair(pairIndex: number): AbRegime {
  if (pairIndex < PAIRS_PER_REGIME) {
    return {
      name: 'unrestricted',
      description: 'no declared inks, no filters',
    };
  }
  if (pairIndex < PAIRS_PER_REGIME + 2) {
    return {
      name: 'declared-inks',
      description: `declared ${RUBY_SAPPHIRE.join('/')}`,
      inks: [...RUBY_SAPPHIRE],
    };
  }
  if (pairIndex < PAIRS_PER_REGIME + 4) {
    return {
      name: 'declared-inks',
      description: `declared ${AMETHYST_EMERALD.join('/')}`,
      inks: [...AMETHYST_EMERALD],
    };
  }
  const franchise =
    FRANCHISE_PAIRS[Math.floor((pairIndex - 2 * PAIRS_PER_REGIME) / 2)!] ??
    FRANCHISE_PAIRS[0]!;
  return {
    name: 'franchise',
    description: `franchise filter ${franchise.join(', ')}`,
    franchises: franchise,
  };
}

// ---- pure stats (unit-tested; no engine imports) ----

export interface PairTally {
  learnedWins: number;
  learnedGames: number;
  shippedWins: number;
  shippedGames: number;
}

/**
 * Cluster bootstrap over deck-pairs (the seed-pool sample units): each
 * replicate resamples `tallies` with replacement and differences the pooled
 * win rates. Percentile 95% CI. Seeded — no Math.random.
 */
export function bootstrapUpliftCi(
  tallies: readonly PairTally[],
  replicates = BOOTSTRAP_REPLICATES,
  seed = AB_BOOTSTRAP_SEED,
): { uplift: number; ciLow: number; ciHigh: number } {
  if (tallies.length === 0) {
    return { uplift: 0, ciLow: 0, ciHigh: 0 };
  }
  const pooled = (t: readonly PairTally[]): { rate: number; games: number } => {
    let wins = 0;
    let games = 0;
    for (const tally of t) {
      wins += tally.learnedWins;
      games += tally.learnedGames;
    }
    return { rate: games > 0 ? wins / games : 0, games };
  };
  const shippedPool = (
    t: readonly PairTally[],
  ): { rate: number; games: number } => {
    let wins = 0;
    let games = 0;
    for (const tally of t) {
      wins += tally.shippedWins;
      games += tally.shippedGames;
    }
    return { rate: games > 0 ? wins / games : 0, games };
  };
  const a = pooled(tallies);
  const b = shippedPool(tallies);
  const uplift = a.games > 0 && b.games > 0 ? a.rate - b.rate : 0;
  const rng = mulberry32(seed);
  const samples: number[] = [];
  for (let i = 0; i < replicates; i++) {
    let learnedWins = 0;
    let learnedGames = 0;
    let shippedWins = 0;
    let shippedGames = 0;
    for (let j = 0; j < tallies.length; j++) {
      const tally = tallies[Math.floor(rng() * tallies.length)]!;
      learnedWins += tally.learnedWins;
      learnedGames += tally.learnedGames;
      shippedWins += tally.shippedWins;
      shippedGames += tally.shippedGames;
    }
    if (learnedGames === 0 || shippedGames === 0) continue;
    samples.push(learnedWins / learnedGames - shippedWins / shippedGames);
  }
  if (samples.length === 0) return { uplift, ciLow: uplift, ciHigh: uplift };
  samples.sort((x, y) => x - y);
  const at = (q: number): number =>
    samples[
      Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))
    ]!;
  return {
    uplift: Math.round(uplift * 1e6) / 1e6,
    ciLow: Math.round(at(0.025) * 1e6) / 1e6,
    ciHigh: Math.round(at(0.975) * 1e6) / 1e6,
  };
}

export interface GateVerdict {
  passed: boolean;
  verdict: 'SHIPPED' | 'NOT_SHIPPED';
  ciLow: number;
  reason: string;
}

/** the pre-committed rule: no illegal decks AND aggregate CI low > 0 */
export function gateVerdict(
  aggregate: { ciLow: number },
  illegalDecks: number,
): GateVerdict {
  if (illegalDecks > 0) {
    return {
      passed: false,
      verdict: 'NOT_SHIPPED',
      ciLow: aggregate.ciLow,
      reason: `${illegalDecks} illegal generated deck(s) — gate-fail evidence (spec)`,
    };
  }
  if (aggregate.ciLow > 0) {
    return {
      passed: true,
      verdict: 'SHIPPED',
      ciLow: aggregate.ciLow,
      reason: 'aggregate uplift 95% CI low > 0 with all decks legal',
    };
  }
  return {
    passed: false,
    verdict: 'NOT_SHIPPED',
    ciLow: aggregate.ciLow,
    reason: 'aggregate uplift 95% CI low ≤ 0',
  };
}

// ---- deck generation + legality (worker side) ----

export interface AbDeckPair {
  pairIndex: number;
  regime: string;
  description: string;
  genSeed: number;
  /** identity-count decks (alias-resolved) for arena play */
  learned: Record<string, number>;
  shipped: Record<string, number>;
  identical: boolean;
}

function toIdentityCounts(
  deck: NonNullable<ReturnType<typeof generateDeck>['deck']>,
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

function deckTotal(deck: Record<string, number>): number {
  return Object.values(deck).reduce((sum, count) => sum + count, 0);
}

/** the deck's distinct inks in canonical order (deckProblems' inks check) */
export function deckInks(
  deck: Record<string, number>,
  cards: readonly Card[],
): string[] {
  const inks = new Set<string>();
  for (const [id] of Object.entries(deck)) {
    for (const ink of cards.find((card) => card.id === Number(id))?.inks ??
      []) {
      inks.add(ink);
    }
  }
  return [...inks].sort();
}

export function deckLegalProblems(
  deck: Record<string, number>,
  cardMap: CardMap,
  cards: readonly Card[],
): string[] {
  const prepared = {
    cards: deck,
    inks: deckInks(deck, cards),
    title: 'learned-ab',
  };
  const problems = deckProblems(prepared, cardMap, [...cards]);
  if (problems.length > 0) {
    return problems.map((p) => `${p.kind}: ${p.detail}`);
  }
  const missing = ineligibleIdentities(prepared, cardMap, [...cards]);
  return missing.map((m) => `ineligible: ${m.name} [${m.reason}]`);
}

export function generateAbPair(opts: {
  pairIndex: number;
  cards: readonly Card[];
  meta: MetaModel;
  learnedArtifact: NonNullable<ReturnType<typeof parseGeneratorModel>>;
  alias: Map<number, number>;
  cardMap: CardMap;
}): { pair: AbDeckPair | null; illegalReasons: string[] } {
  const regime = regimeForPair(opts.pairIndex);
  const genSeed = AB_GEN_SEED_BASE + opts.pairIndex;
  const shared = {
    cards: [...opts.cards],
    format: 'core' as const,
    ...(regime.inks ? { inks: regime.inks } : {}),
    ...(regime.franchises ? { franchises: regime.franchises } : {}),
    seed: genSeed,
    novelty: 0.5,
    targetSize: 60,
    model: opts.meta,
  };
  // shipped variant: learnedModel undefined = the shipped behavior exactly
  const shippedResult = generateDeck({ ...shared });
  // learned variant: the same artifact with its gate flag force-enabled —
  // the gate itself must exercise the learned path (PENDING at gate time)
  const forced = {
    ...opts.learnedArtifact,
    gate: { ...opts.learnedArtifact.gate, passed: true },
  };
  const learnedResult = generateDeck({ ...shared, learnedModel: forced });
  const illegalReasons: string[] = [];
  const check = (
    result: ReturnType<typeof generateDeck>,
    variant: string,
  ): Record<string, number> | null => {
    if (!result.deck) {
      illegalReasons.push(
        `${variant}: generation failed (${result.error ?? 'no deck'})`,
      );
      return null;
    }
    if (result.notes.relaxations.length > 0) {
      illegalReasons.push(
        `${variant}: conditioning relaxed (${result.notes.relaxations.join('; ')})`,
      );
    }
    const identityDeck = toIdentityCounts(result.deck, opts.alias);
    if (deckTotal(identityDeck) !== 60) {
      illegalReasons.push(`${variant}: ${deckTotal(identityDeck)} cards ≠ 60`);
      return identityDeck;
    }
    for (const problem of deckLegalProblems(
      identityDeck,
      opts.cardMap,
      opts.cards,
    )) {
      illegalReasons.push(`${variant}: ${problem}`);
    }
    return identityDeck;
  };
  const shippedDeck = check(shippedResult, 'shipped');
  const learnedDeck = check(learnedResult, 'learned');
  if (!shippedDeck || !learnedDeck) return { pair: null, illegalReasons };
  return {
    pair: {
      pairIndex: opts.pairIndex,
      regime: regime.name,
      description: regime.description,
      genSeed,
      learned: learnedDeck,
      shipped: shippedDeck,
      identical:
        JSON.stringify(Object.entries(learnedDeck).sort()) ===
        JSON.stringify(Object.entries(shippedDeck).sort()),
    },
    illegalReasons,
  };
}

// ---- matched league play ----

export function playAbPair(
  pair: AbDeckPair,
  league: Awaited<ReturnType<typeof loadLeague>>,
  play: ReturnType<typeof cachedBatchPlayer>,
): { learnedWins: number; shippedWins: number; games: number } {
  const masterSeed = AB_PLAY_SEED_BASE + pair.pairIndex * AB_PLAY_SEED_STRIDE;
  const tally = (deck: Record<string, number>): number => {
    const evaluation = evaluateCandidateVsLeague(deck, league, {
      play,
      masterSeed,
      gamesPerMember: AB_GAMES_PER_MEMBER,
      batchSize: AB_BATCH_SIZE,
      referee: DEFAULT_REFEREE,
    });
    let wins = 0;
    for (const member of evaluation.results) wins += member.wins;
    return wins;
  };
  const learnedWins = tally(pair.learned);
  const shippedWins = tally(pair.shipped);
  const games = league.members.length * AB_GAMES_PER_MEMBER;
  return { learnedWins, shippedWins, games };
}

// ---- worker plumbing (ab.ts pattern; parts merge in pair order) ----

interface AbPartEntry extends PairTally {
  pairIndex: number;
  regime: string;
  description: string;
  genSeed: number;
  identical: boolean;
  illegalReasons: string[];
}

interface AbArgs {
  leaguePath: string;
  parallel: number;
  workerIndex: number;
  workerCount: number;
  part: string | null;
  out: string;
}

function parseArgs(argv: string[]): AbArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    leaguePath: get('--league')
      ? resolve(get('--league')!)
      : resolve(
          import.meta.dirname,
          '..',
          'data',
          'arena',
          'selfplay',
          'league-6de59de1.json',
        ),
    parallel: Math.max(1, Number(get('--parallel') ?? 3)),
    workerIndex: Number(get('--worker-index') ?? 0),
    workerCount: Number(get('--worker-count') ?? 1),
    part: get('--part') ? resolve(get('--part')!) : null,
    out: get('--out') ? resolve(get('--out')!) : DEFAULT_AB_OUT,
  };
}

export const TOTAL_PAIRS = 3 * PAIRS_PER_REGIME;

async function workerMain(args: AbArgs): Promise<void> {
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
  const league = await loadLeague(args.leaguePath);
  if (league.engineCommit.slice(0, 8) !== catalog.engineCommit.slice(0, 8)) {
    throw new Error(
      `league era ${league.engineCommit.slice(0, 8)} ≠ engine era ${catalog.engineCommit.slice(0, 8)}`,
    );
  }
  const meta = parseMetaModel(
    JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '..',
          '..',
          '..',
          'public',
          'data',
          'meta-model.json',
        ),
        'utf8',
      ),
    ),
  );
  if (!meta) throw new Error('meta model failed to parse');
  const learnedArtifact = parseGeneratorModel(
    JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '..',
          '..',
          '..',
          'public',
          'data',
          'generator-model.json',
        ),
        'utf8',
      ),
    ),
  );
  if (!learnedArtifact) {
    throw new Error(
      'generator model artifact missing or corrupt — nothing to gate',
    );
  }
  const play = cachedBatchPlayer({
    catalog,
    cardMap,
    engineCommit: catalog.engineCommit,
    mapFormat: cardMap.format,
    referee: DEFAULT_REFEREE,
  });
  const lines: string[] = [];
  for (
    let pairIndex = args.workerIndex;
    pairIndex < TOTAL_PAIRS;
    pairIndex += args.workerCount
  ) {
    const { pair, illegalReasons } = generateAbPair({
      pairIndex,
      cards,
      meta,
      learnedArtifact,
      alias,
      cardMap,
    });
    if (!pair) {
      lines.push(
        JSON.stringify({
          pairIndex,
          regime: regimeForPair(pairIndex).name,
          description: regimeForPair(pairIndex).description,
          genSeed: AB_GEN_SEED_BASE + pairIndex,
          learnedWins: 0,
          learnedGames: 0,
          shippedWins: 0,
          shippedGames: 0,
          identical: false,
          illegalReasons,
        } satisfies AbPartEntry),
      );
      continue;
    }
    const result = playAbPair(pair, league, play);
    lines.push(
      JSON.stringify({
        pairIndex: pair.pairIndex,
        regime: pair.regime,
        description: pair.description,
        genSeed: pair.genSeed,
        learnedWins: result.learnedWins,
        learnedGames: result.games,
        shippedWins: result.shippedWins,
        shippedGames: result.games,
        identical: pair.identical,
        illegalReasons,
      } satisfies AbPartEntry),
    );
  }
  mkdirSync(dirname(args.part!), { recursive: true });
  writeFileSync(args.part!, lines.join('\n') + (lines.length ? '\n' : ''));
}

async function parentMain(args: AbArgs): Promise<void> {
  const engineCommit = (
    JSON.parse(readFileSync(args.leaguePath, 'utf8')) as {
      engineCommit: string;
    }
  ).engineCommit;
  if (args.parallel === 1) {
    args.part = join(
      dirname(args.out),
      `.learned-ab-parts-${process.pid}.jsonl`,
    );
    await workerMain({
      ...args,
      workerIndex: 0,
      workerCount: 1,
      part: args.part,
    });
  } else {
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const self = fileURLToPath(import.meta.url);
    const partDir = join(dirname(args.out), `.learned-ab-parts-${process.pid}`);
    mkdirSync(partDir, { recursive: true });
    const parts: string[] = [];
    try {
      await Promise.all(
        Array.from({ length: args.parallel }, (_, w) => {
          const part = join(partDir, `learned-ab-${w}.jsonl`);
          parts.push(part);
          return execFileAsync(process.execPath, [
            tsxCli,
            self,
            '--league',
            args.leaguePath,
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
      rmSync(partDir, { recursive: true, force: true });
      throw error;
    }
    const entries: AbPartEntry[] = [];
    for (const part of parts) {
      if (!existsSync(part)) continue;
      for (const line of readFileSync(part, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        entries.push(JSON.parse(line) as AbPartEntry);
      }
    }
    rmSync(partDir, { recursive: true, force: true });
    entries.sort((a, b) => a.pairIndex - b.pairIndex);
    writeAbReport(entries, args, engineCommit);
    return;
  }
  const entries: AbPartEntry[] = [];
  for (const line of readFileSync(args.part, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line) as AbPartEntry);
  }
  rmSync(args.part, { force: true });
  entries.sort((a, b) => a.pairIndex - b.pairIndex);
  writeAbReport(entries, args, engineCommit);
}

export function writeAbReport(
  entries: readonly AbPartEntry[],
  args: { out: string; leaguePath: string; parallel: number },
  engineCommit: string,
): void {
  const pairIndexes = new Set(entries.map((entry) => entry.pairIndex));
  const missing = TOTAL_PAIRS - pairIndexes.size;
  if (missing > 0) {
    throw new Error(
      `A/B parts cover ${pairIndexes.size}/${TOTAL_PAIRS} deck-pairs (${missing} missing) — a worker died mid-run; re-invoke with identical flags to resume from the cache`,
    );
  }
  const illegalDecks = entries.reduce(
    (count, entry) => count + entry.illegalReasons.length,
    0,
  );
  const byRegime = new Map<string, PairTally[]>();
  const all: PairTally[] = [];
  for (const entry of entries) {
    const tally: PairTally = {
      learnedWins: entry.learnedWins,
      learnedGames: entry.learnedGames,
      shippedWins: entry.shippedWins,
      shippedGames: entry.shippedGames,
    };
    all.push(tally);
    const list = byRegime.get(entry.regime) ?? [];
    list.push(tally);
    byRegime.set(entry.regime, list);
  }
  const aggregate = bootstrapUpliftCi(all);
  const verdict = gateVerdict(aggregate, illegalDecks);
  const regimes = [...byRegime.entries()].map(([name, tallies]) => ({
    regime: name,
    pairs: tallies.length,
    learned: {
      wins: tallies.reduce((sum, t) => sum + t.learnedWins, 0),
      games: tallies.reduce((sum, t) => sum + t.learnedGames, 0),
    },
    shipped: {
      wins: tallies.reduce((sum, t) => sum + t.shippedWins, 0),
      games: tallies.reduce((sum, t) => sum + t.shippedGames, 0),
    },
    ...bootstrapUpliftCi(tallies),
  }));
  const report = {
    gate: 'learned-deck-completion A/B (task 5.1, D6)',
    engineCommit,
    league: args.leaguePath,
    referee: DEFAULT_REFEREE,
    gamesPerMember: AB_GAMES_PER_MEMBER,
    pairCount: entries.length,
    pairsPerRegime: PAIRS_PER_REGIME,
    seeds: {
      generationBase: AB_GEN_SEED_BASE,
      playBase: AB_PLAY_SEED_BASE,
      playStride: AB_PLAY_SEED_STRIDE,
      bootstrapSeed: AB_BOOTSTRAP_SEED,
      bootstrapReplicates: BOOTSTRAP_REPLICATES,
      disjointness:
        'prior runs consumed master seeds ≤ ~20.3 M (league/self-play 20261121-22, restricted 20261123..27, sweep 20261130, deltas +9,000 spacing, slices 20262023..30; acceptance ≥ 70.3 M); this gate uses 30.0 M+ — disjoint on both sides',
    },
    pairs: entries,
    perRegime: regimes,
    aggregate,
    illegalDecks,
    identicalDeckPairs: entries.filter((entry) => entry.identical).length,
    verdict,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report, null, 1));
  console.error(
    `learned-ab: aggregate uplift ${aggregate.uplift} CI [${aggregate.ciLow}, ${aggregate.ciHigh}] ` +
      `→ ${verdict.verdict} (${verdict.reason})`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.workerCount > 1 && args.part) {
    await workerMain(args);
    return;
  }
  await parentMain(args);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main();
}
