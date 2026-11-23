/**
 * Self-play league store and seeding (self-play-league, tasks 3.1/3.4).
 *
 * The league is the fixed opponent pool for candidate decks: held-out real
 * tournament decks (opponents ONLY — seedLeague takes them as explicit input
 * and its only output is the league, so no candidate can derive from them)
 * plus seeded baselines (random legal decks and smart-generator decks).
 * Winning candidates can be promoted into the league with near-duplicate
 * pruning by card-list distance.
 *
 * The artifact is keyed by engine commit (8 chars) so an engine bump starts a
 * new era and never mixes members (AGENTS.md cache-key rule):
 *   scripts/training/data/arena/selfplay/league-<commit8>.json
 *
 * Usage:
 *   npx tsx scripts/training/arena/league.ts \
 *     [--real 8] [--random 4] [--smart 4] [--seed 20261121] [--era-days 365]
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, Ink } from '../../../src/data/types';
import { INKS } from '../../../src/data/types';
import { generateDeck } from '../../../src/generate/generator';
import { mulberry32 } from '../prng';
import type { CardMap } from './card-map';

const ARENA_DIR = import.meta.dirname;
/** commit8-keyed league artifacts live next to the arena cache */
export const LEAGUE_DIR = path.resolve(
  ARENA_DIR,
  '..',
  'data',
  'arena',
  'selfplay',
);

export type MemberKind =
  | 'real'
  | 'baseline-random'
  | 'baseline-smart'
  | 'selfplay';

export interface LeagueMember {
  id: string;
  kind: MemberKind;
  /** identity id → count */
  deck: Record<string, number>;
  /** meta weight P(j); all member shares sum to 1 */
  share: number;
  origin: string;
  /** league score at promotion time (selfplay members only) */
  score?: number;
}

export interface League {
  /** game format the decks are legal in */
  format: string;
  engineCommit: string;
  /** ISO timestamp of seeding */
  seededOn: string;
  members: LeagueMember[];
}

export interface BaselineDeck {
  cards: Record<string, number>;
  inks: string[];
}

export interface RealDeckInput {
  cards: Record<string, number>;
  origin: string;
}

/**
 * Same convention as evolve/evolve-mutation.ts (31-multiplier FNV-style hash,
 * 8 hex chars) so league members, evolution individuals and panel entries can
 * be compared. Reimplemented here instead of imported to keep this module
 * free of the engine import chain that evolve-mutation pulls in via play.ts.
 */
export function deckSignature(cards: Record<string, number>): string {
  const entries = Object.entries(cards).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  let hash = 0;
  for (const [id, count] of entries)
    hash = (hash * 31 + Number(id) * 7 + count) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** stable, human-readable member/candidate id: `<kind>:<signature>` */
export function candidateId(
  kind: MemberKind,
  signature: string,
  nth = 1,
): string {
  return nth > 1 ? `${kind}:${signature}-${nth}` : `${kind}:${signature}`;
}

/**
 * Card-list distance: symmetric difference over identity counts
 * (Σ |a(id) − b(id)|, missing identities count as 0). Two 60-card decks
 * range from 0 (identical) to 120 (disjoint); one 2-copy swap = 2.
 */
export function cardListDistance(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let distance = 0;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    distance += Math.abs((a[id] ?? 0) - (b[id] ?? 0));
  }
  return distance;
}

/**
 * Arena legality gate for baseline decks (same constraints evolve enforces
 * via its legalByIdentity pool): exactly 60 cards, ≤ 2 inks, every identity
 * from the pool within its copy limit and matching the deck's inks.
 */
export function baselineProblems(
  deck: BaselineDeck,
  legalByIdentity: Map<number, { maxCopies: number; inks: string[] }>,
): string[] {
  const problems: string[] = [];
  const total = Object.values(deck.cards).reduce((a, b) => a + b, 0);
  if (total !== 60) problems.push(`card-count-${total}`);
  if (deck.inks.length > 2) problems.push(`inks-${deck.inks.length}`);
  for (const [identity, count] of Object.entries(deck.cards)) {
    const entry = legalByIdentity.get(Number(identity));
    if (!entry) {
      problems.push(`illegal-identity-${identity}`);
      continue;
    }
    if (count > entry.maxCopies)
      problems.push(`copy-limit-${identity}-${count}>${entry.maxCopies}`);
    if (!entry.inks.some((ink) => deck.inks.includes(ink)))
      problems.push(`ink-mismatch-${identity}`);
  }
  return problems;
}

export interface SeedLeagueOptions {
  /**
   * Held-out real tournament decks — opponents ONLY. They are stored as
   * kind 'real' members and never emitted as candidate material; the seeder
   * has no candidate output at all, which is the API-level holdout guarantee.
   */
  realDecks: RealDeckInput[];
  randomCount: number;
  smartCount: number;
  seed: number;
  engineCommit: string;
  format?: string;
  /**
   * Arena-legal, fully-scripted identity pool (see legalSelfPlayIdentities).
   * Required whenever baselines are seeded — the legality gate is never
   * skipped.
   */
  legalByIdentity?: Map<number, { maxCopies: number; inks: string[] }>;
  /** injectable baseline factories; defaults are randomLegalDeck/smartGeneratorDeck */
  generateRandom?: (rng: () => number) => BaselineDeck | null;
  generateSmart?: (index: number, rng: () => number) => BaselineDeck | null;
}

export interface LeagueSeedResult {
  league: League;
  /** decks rejected during seeding, by reason */
  dropped: Record<string, number>;
}

/**
 * Seed a league: real decks first (opponents), then random-legal and
 * smart-generator baselines, each drawn from the seeded RNG stream. Members
 * start with uniform shares; duplicates (by deck signature) are dropped.
 *
 * Inviolate assumption (resume contract, AGENTS.md): this is a from-scratch
 * constructor, never additive — the CLI overwrites the commit8-keyed
 * artifact wholesale, so re-running with the same flags reproduces the same
 * composition (member ids embed the seed) modulo `seededOn`. It must never
 * run against a league that promotions have already evolved; there is
 * deliberately no merge-on-reseed guard because reseeding IS the reset.
 */
export function seedLeague(opts: SeedLeagueOptions): LeagueSeedResult {
  const rng = mulberry32(opts.seed);
  const dropped: Record<string, number> = {};
  const drop = (reason: string): void => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const members: LeagueMember[] = [];
  const seen = new Set<string>();
  const needsBaselines = opts.randomCount > 0 || opts.smartCount > 0;
  if (needsBaselines && !opts.legalByIdentity) {
    throw new Error(
      'legalByIdentity is required to seed baseline decks — the arena legality gate cannot be skipped',
    );
  }
  if (opts.smartCount > 0 && !opts.generateSmart) {
    throw new Error(
      'generateSmart is required when smartCount > 0 (wire smartGeneratorDeck from the CLI)',
    );
  }
  const legalByIdentity = opts.legalByIdentity;

  const addMember = (
    kind: MemberKind,
    cards: Record<string, number>,
    origin: string,
    score?: number,
  ): boolean => {
    const signature = deckSignature(cards);
    if (seen.has(signature)) {
      drop(`${kind}-duplicate`);
      return false;
    }
    seen.add(signature);
    members.push({
      id: candidateId(kind, signature),
      kind,
      deck: { ...cards },
      share: 0,
      origin,
      ...(score !== undefined ? { score } : {}),
    });
    return true;
  };

  // ---- real decks: held-out opponents, gate is a plain 60-card sanity check
  // (they are pre-gated by the panel/corpus legality pipeline upstream) ----
  for (const real of opts.realDecks) {
    const total = Object.values(real.cards).reduce((a, b) => a + b, 0);
    if (total !== 60) {
      drop(`real-card-count-${total}`);
      continue;
    }
    addMember('real', real.cards, real.origin);
  }

  // ---- random-legal baselines ----
  let seeded = 0;
  let attempts = 0;
  const maxAttempts = opts.randomCount * 25 + 25;
  while (seeded < opts.randomCount && attempts < maxAttempts) {
    attempts++;
    const deck = opts.generateRandom
      ? opts.generateRandom(rng)
      : randomLegalDeck(legalByIdentity!, rng);
    if (!deck) {
      drop('baseline-random-generate-failed');
      continue;
    }
    const problems = baselineProblems(deck, legalByIdentity!);
    if (problems.length > 0) {
      drop(`baseline-random-illegal:${problems[0]}`);
      continue;
    }
    if (
      addMember(
        'baseline-random',
        deck.cards,
        `random-legal:seed-${opts.seed}-${seeded}`,
      )
    )
      seeded++;
  }

  // ---- smart-generator baselines (app generator, evolve --diversity style) ----
  seeded = 0;
  attempts = 0;
  while (seeded < opts.smartCount && attempts < maxAttempts) {
    attempts++;
    const deck = opts.generateSmart
      ? opts.generateSmart(attempts - 1, rng)
      : null;
    if (!deck) {
      drop('baseline-smart-generate-failed');
      continue;
    }
    const problems = baselineProblems(deck, legalByIdentity!);
    if (problems.length > 0) {
      drop(`baseline-smart-illegal:${problems[0]}`);
      continue;
    }
    if (
      addMember(
        'baseline-smart',
        deck.cards,
        `generator:seed-${opts.seed}-${seeded}`,
      )
    )
      seeded++;
  }

  // uniform shares to start with; promote() rebalances as winners join
  const share = members.length > 0 ? 1 / members.length : 0;
  for (const member of members) member.share = share;

  return {
    league: {
      format: opts.format ?? 'core',
      engineCommit: opts.engineCommit,
      seededOn: new Date().toISOString(),
      members,
    },
    dropped,
  };
}

/** A promoted winner's default slice of the league shares: 1/(N+1) */
export const DEFAULT_DISTANCE_THRESHOLD = 12;

export interface PromoteOptions {
  /** reject when within this card-list distance of any member (default 12) */
  distanceThreshold?: number;
  /** share taken for the new member (default 1/(N+1), existing scaled down) */
  share?: number;
  origin?: string;
}

export interface PromoteResult {
  league: League;
  promoted: boolean;
  /** set when rejected */
  reason?: 'near-duplicate';
  nearestId?: string;
  distance?: number;
}

/**
 * Promote a winning candidate deck into the league. The new member takes
 * `share` (default 1/(N+1)) and every existing member's share is scaled by
 * the remainder, so the shares keep summing to 1. Rejected (league returned
 * unchanged) when the deck is within `distanceThreshold` card-list distance
 * of an existing member — exact duplicates included, distance 0.
 */
export function promote(
  league: League,
  deck: Record<string, number>,
  score: number,
  opts: PromoteOptions = {},
): PromoteResult {
  const threshold = opts.distanceThreshold ?? DEFAULT_DISTANCE_THRESHOLD;
  let nearestId: string | undefined;
  let nearest = Number.POSITIVE_INFINITY;
  for (const member of league.members) {
    const distance = cardListDistance(deck, member.deck);
    if (distance < nearest) {
      nearest = distance;
      nearestId = member.id;
    }
  }
  if (nearest <= threshold) {
    return {
      league,
      promoted: false,
      reason: 'near-duplicate',
      nearestId,
      distance: nearest,
    };
  }
  const signature = deckSignature(deck);
  const newShare = opts.share ?? 1 / (league.members.length + 1);
  const members: LeagueMember[] = league.members.map((member) => ({
    ...member,
    share: member.share * (1 - newShare),
  }));
  members.push({
    id: candidateId('selfplay', signature),
    kind: 'selfplay',
    deck: { ...deck },
    share: newShare,
    origin: opts.origin ?? `promoted:${signature}`,
    score,
  });
  return {
    league: { ...league, members },
    promoted: true,
    nearestId,
    distance: nearest,
  };
}

export function leagueFilePath(engineCommit: string, dir = LEAGUE_DIR): string {
  const commit8 = engineCommit.slice(0, 8);
  if (!commit8)
    throw new Error('engineCommit is empty — cannot derive league file name');
  return path.join(dir, `league-${commit8}.json`);
}

/** persist the league as its commit8-keyed JSON artifact; returns the path */
export async function saveLeague(
  league: League,
  dir = LEAGUE_DIR,
): Promise<string> {
  const filePath = leagueFilePath(league.engineCommit, dir);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(league, null, 1)}\n`);
  return filePath;
}

/** load + minimally validate a league artifact */
export async function loadLeague(filePath: string): Promise<League> {
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as League;
  if (
    typeof raw.format !== 'string' ||
    typeof raw.engineCommit !== 'string' ||
    typeof raw.seededOn !== 'string' ||
    !Array.isArray(raw.members)
  ) {
    throw new Error(`${filePath} is not a valid league file`);
  }
  for (const member of raw.members) {
    if (
      typeof member.id !== 'string' ||
      typeof member.kind !== 'string' ||
      typeof member.deck !== 'object' ||
      member.deck === null ||
      typeof member.share !== 'number' ||
      typeof member.origin !== 'string'
    ) {
      throw new Error(`${filePath} contains a malformed league member`);
    }
  }
  return raw;
}

/**
 * Arena-legal, FULLY-scripted identity pool for league decks — the same pool
 * evolve's legalIdentities builds, additionally restricted to coverage
 * 'fully' per the selfplay-pool rule (league games must never rest on
 * half-implemented engine rules). Local copy instead of importing
 * evolve-mutation to avoid its engine import chain.
 */
export function legalSelfPlayIdentities(
  cards: Card[],
  cardMap: CardMap,
): Map<number, { maxCopies: number; inks: string[] }> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out = new Map<number, { maxCopies: number; inks: string[] }>();
  for (const [identity, entry] of Object.entries(cardMap.byIdentity)) {
    if (entry.coverage !== 'fully') continue;
    const card = byId.get(Number(identity));
    if (!card) continue;
    if (card.setType !== 'expansion' || !card.formats.core) continue;
    if (typeof card.maxCopies !== 'number') continue;
    out.set(Number(identity), {
      maxCopies: card.maxCopies,
      inks: card.inks as unknown as string[],
    });
  }
  return out;
}

/**
 * Default random-legal baseline: pick an ink (pair) from the pool, then fill
 * 60 slots with random pool cards sharing that ink, respecting copy limits —
 * legal by construction, verified again by the seeder's gate.
 */
export function randomLegalDeck(
  legalByIdentity: Map<number, { maxCopies: number; inks: string[] }>,
  rng: () => number,
): BaselineDeck | null {
  const ids = [...legalByIdentity.keys()].sort((a, b) => a - b);
  if (ids.length === 0) return null;
  const inksAvailable = [
    ...new Set(ids.flatMap((id) => legalByIdentity.get(id)?.inks ?? [])),
  ].sort();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < inksAvailable.length; i++) {
    for (let j = i; j < inksAvailable.length; j++) {
      pairs.push([inksAvailable[i]!, inksAvailable[j]!]);
    }
  }
  const pair = pairs[Math.floor(rng() * pairs.length)]!;
  const candidates = ids.filter((id) =>
    (legalByIdentity.get(id)?.inks ?? []).some((ink) => pair.includes(ink)),
  );
  if (candidates.length === 0) return null;
  const cards: Record<string, number> = {};
  let total = 0;
  let guard = 0;
  while (total < 60 && guard < 60 * 200) {
    guard++;
    const id = candidates[Math.floor(rng() * candidates.length)]!;
    const key = String(id);
    const limit = legalByIdentity.get(id)?.maxCopies ?? 3;
    if ((cards[key] ?? 0) + 1 > limit) continue;
    cards[key] = (cards[key] ?? 0) + 1;
    total++;
  }
  if (total !== 60) return null;
  return { cards, inks: [...new Set(pair)] };
}

/**
 * Default smart baseline: the app generator (generateDeck) with a seed, in
 * the evolve.ts --diversity style (model: null, novelty 1, cycling ink pairs),
 * reduced to identity counts restricted to the legal self-play pool.
 */
export function smartGeneratorDeck(
  cards: Card[],
  alias: Map<number, number>,
  legalByIdentity: Map<number, { maxCopies: number; inks: string[] }>,
  seed: number,
  index: number,
): BaselineDeck | null {
  const inkPairs: Array<[Ink, Ink]> = INKS.flatMap((a, i) =>
    INKS.slice(i + 1).map((b) => [a, b] as [Ink, Ink]),
  );
  const inks = inkPairs[index % inkPairs.length]!;
  const result = generateDeck({
    cards,
    inks,
    format: 'core',
    seed: seed + 50000 + index,
    novelty: 1,
    targetSize: 60,
    model: null,
  });
  if (!result.deck) return null;
  const identityCards: Record<string, number> = {};
  for (const [printId, count] of Object.entries(result.deck.cards) as Array<
    [string, number]
  >) {
    const identity = alias.get(Number(printId));
    if (identity === undefined || !legalByIdentity.has(identity)) return null;
    identityCards[String(identity)] =
      (identityCards[String(identity)] ?? 0) + count;
  }
  return { cards: identityCards, inks: result.deck.inks };
}

/** seeded Fisher–Yates shuffle (no Math.random in training paths) */
export function seededShuffle<T>(list: T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface LeagueArgs {
  real: number;
  random: number;
  smart: number;
  seed: number;
  eraDays: number;
}

function parseArgs(argv: string[]): LeagueArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    real: Number(get('--real') ?? 8),
    random: Number(get('--random') ?? 4),
    smart: Number(get('--smart') ?? 4),
    seed: Number(get('--seed') ?? 20261121),
    eraDays: Number(get('--era-days') ?? 365),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // imported lazily: keeps the test import graph free of corpus/engine loads
  const { buildCardMap } = await import('./card-map');
  const { buildCanonicalRegistry } = await import('../canonical');
  const { loadCards } = await import('./cards');
  const { loadEngineCatalog } = await import('./engine-cards');
  const { buildPanel, loadCorpus } = await import('./panel');

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
  const legalByIdentity = legalSelfPlayIdentities(cards, cardMap);

  // ---- held-out real decks: corpus decks gated like the panel, minus the
  // decks already used as the panel (evolve's training anchors), then sampled
  // with the seed ----
  const panelSignatures = new Set<string>();
  const panelManifestPath = path.join(ARENA_DIR, 'panel', 'panel.json');
  if (existsSync(panelManifestPath)) {
    const manifest = JSON.parse(await readFile(panelManifestPath, 'utf8')) as {
      decks?: Array<{ signature?: string }>;
    };
    for (const deck of manifest.decks ?? []) {
      if (deck.signature) panelSignatures.add(deck.signature);
    }
  }
  const rows = await loadCorpus();
  const panelResult = buildPanel(rows, cards, {
    size: args.real + 64,
    eraDays: args.eraDays,
  });
  const candidates = panelResult.decks
    .filter((deck) => !panelSignatures.has(deck.signature))
    .filter((deck) =>
      Object.keys(deck.cards).every((identity) => cardMap.byIdentity[identity]),
    );
  const realDecks = seededShuffle(candidates, mulberry32(args.seed))
    .slice(0, args.real)
    .map((deck) => ({
      cards: deck.cards,
      origin: `corpus:${deck.source}:${deck.eventId}:${deck.date}`,
    }));
  if (realDecks.length < args.real) {
    throw new Error(
      `only ${realDecks.length} held-out real decks available (--real ${args.real}); ` +
        'lower --real or --era-days',
    );
  }

  const { league, dropped } = seedLeague({
    realDecks,
    randomCount: args.random,
    smartCount: args.smart,
    seed: args.seed,
    engineCommit: cardMap.engineCommit,
    legalByIdentity,
    generateRandom: (rng) => randomLegalDeck(legalByIdentity, rng),
    generateSmart: (index) =>
      smartGeneratorDeck(cards, alias, legalByIdentity, args.seed, index),
  });

  const outPath = await saveLeague(league);
  const byKind: Record<string, number> = {};
  for (const member of league.members)
    byKind[member.kind] = (byKind[member.kind] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        league: outPath,
        engineCommit: cardMap.engineCommit,
        seed: args.seed,
        members: { total: league.members.length, ...byKind },
        sampledRealPool: candidates.length,
        dropped,
      },
      null,
      1,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
