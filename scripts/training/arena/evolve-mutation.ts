/**
 * M2 close-out / meta convergence: evolutionary deck optimization with the
 * arena as fitness.
 *
 * Population: seeded from the meta panel. Mutation: synergy-guided swaps
 * (using the trained interactions table) + legality-preserving random swaps
 * and count adjustments. Fitness: win rate vs anchor set A (top original
 * panel decks). Selection: elites + mutated top half. Gate: final top decks
 * vs anchor set B (the DISJOINT remaining panel decks, fresh seeds) — PASS =
 * CI low > 0.5, i.e. evolved decks generalize beyond the opponents they
 * evolved against.
 *
 * Usage:
 *   npx tsx scripts/training/arena/evolve.ts \
 *     [--generations 6] [--population 24] [--games-per-candidate 16] \
 *     [--parallel 6] [--seed 20261121]
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Card } from '../../../src/data/types';
import { buildCanonicalRegistry } from '../canonical';
import { mulberry32 } from '../prng';
import { proportionStats } from './ab';
import { buildCardMap, type CardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import { playGame, strategyById } from './play';

const execFileAsync = promisify(execFile);

const ARENA_DIR = import.meta.dirname;
const STRATEGY = 'best-deck-aware-lore-race';

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
  /** provenance: 'panel' | parent signature + generation */
  origin: string;
}

interface FitnessEntry {
  index: number;
  wins: number;
  games: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    generations: Number(get('--generations') ?? 6),
    population: Number(get('--population') ?? 24),
    gamesPerCandidate: Number(get('--games-per-candidate') ?? 16),
    parallel: Math.max(1, Number(get('--parallel') ?? 6)),
    seed: Number(get('--seed') ?? 20261121),
  };
}

export function deckSignature(cards: Record<string, number>): string {
  const entries = Object.entries(cards).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  let hash = 0;
  for (const [id, count] of entries)
    hash = (hash * 31 + Number(id) * 7 + count) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** total copies in the deck */
const deckSize = (cards: Record<string, number>): number =>
  Object.values(cards).reduce((a, b) => a + b, 0);

/** partner affinity of `id` to the rest of the deck (both table directions) */
function affinityTo(
  id: string,
  deckCards: Record<string, number>,
  table: { partners: Record<string, Array<[number, number]>> } | null,
): number {
  if (!table) return 0;
  let best = 0;
  const own = table.partners[id] ?? [];
  for (const [partner, score] of own) {
    if (deckCards[String(partner)]) best = Math.max(best, score);
  }
  // inverse direction: any deck card naming id as its partner
  for (const deckId of Object.keys(deckCards)) {
    const list = table.partners[deckId] ?? [];
    for (const [partner, score] of list) {
      if (String(partner) === id) best = Math.max(best, score);
    }
  }
  return best;
}

export interface MutationContext {
  /** arena-legal identities with copy limits and inks */
  legalByIdentity: Map<number, { maxCopies: number; inks: string[] }>;
  interactions: { partners: Record<string, Array<[number, number]>> } | null;
}

/** all arena-legal identities with their copy limits and inks */
export function legalIdentities(
  cards: Card[],
  cardMap: CardMap,
): Map<number, { maxCopies: number; inks: string[] }> {
  const out = new Map<number, { maxCopies: number; inks: string[] }>();
  for (const [identity, entry] of Object.entries(cardMap.byIdentity)) {
    const card = cards.find((c) => c.id === Number(identity));
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
 * Apply one mutation to a deck copy. Returns null when no legal mutation was
 * found after `attempts` tries.
 */
export function mutateDeck(
  deck: Record<string, number>,
  inks: string[],
  mutationCtx: MutationContext,
  rng: () => number,
): Record<string, number> | null {
  const legal = mutationCtx.legalByIdentity;
  const identityIds = [...legal.keys()].sort((a, b) => a - b);
  const pick = <T>(list: T[]): T => list[Math.floor(rng() * list.length)]!;

  for (let attempt = 0; attempt < 12; attempt++) {
    const mutated = { ...deck };
    const roll = rng();
    const total = deckSize(mutated);

    if (roll < 0.34 && mutationCtx.interactions) {
      // ---- synergy swap: drop the least-connected card, add the best
      // trained partner of the most-connected card ----
      let weakest: string | null = null;
      let weakestScore = Number.POSITIVE_INFINITY;
      for (const id of Object.keys(mutated)) {
        const score = affinityTo(id, mutated, mutationCtx.interactions);
        if (score < weakestScore) {
          weakestScore = score;
          weakest = id;
        }
      }
      let strongest: string | null = null;
      let strongestScore = -1;
      for (const id of Object.keys(mutated)) {
        if (id === weakest) continue;
        const score = affinityTo(id, mutated, mutationCtx.interactions);
        if (score > strongestScore) {
          strongestScore = score;
          strongest = id;
        }
      }
      if (!weakest || !strongest) continue;
      const partnerList = mutationCtx.interactions.partners[strongest] ?? [];
      const candidates = partnerList
        .map(([partner]) => partner)
        .filter(
          (p) =>
            !mutated[String(p)] &&
            legal.has(p) &&
            (legal.get(p)!.inks.some((ink) => inks.includes(ink)) ||
              legal.get(p)!.inks.length === 0),
        );
      if (candidates.length === 0) continue;
      const addId = pick(candidates);
      const dropCount = Math.min(mutated[weakest]!, 2);
      mutated[weakest] = (mutated[weakest] ?? 0) - dropCount;
      if (mutated[weakest]! <= 0) delete mutated[weakest];
      mutated[String(addId)] = (mutated[String(addId)] ?? 0) + dropCount;
      if (deckSize(mutated) !== total) continue; // should not happen
      return mutated;
    }

    if (roll < 0.67) {
      // ---- random swap: drop up to 3 copies, add legal randoms ----
      const removable = Object.keys(mutated).filter(
        (id) => (mutated[id] ?? 0) > 0,
      );
      if (removable.length === 0) continue;
      const dropId = pick(removable);
      const dropCount = 1 + Math.floor(rng() * Math.min(3, mutated[dropId]!));
      mutated[dropId] = mutated[dropId]! - dropCount;
      if (mutated[dropId]! <= 0) delete mutated[dropId];
      let added = 0;
      for (let fills = 0; fills < 8 && added < dropCount; fills++) {
        const addId = pick(identityIds);
        const limit = legal.get(addId)?.maxCopies ?? 3;
        if ((mutated[String(addId)] ?? 0) + 1 > limit) continue;
        const addInks = legal.get(addId)?.inks ?? [];
        if (!addInks.some((ink) => inks.includes(ink))) continue;
        mutated[String(addId)] = (mutated[String(addId)] ?? 0) + 1;
        added += 1;
      }
      if (added !== dropCount) continue;
      return mutated;
    }

    // ---- count adjust: +1 somewhere, −1 elsewhere ----
    const bumpable = Object.keys(mutated).filter((id) => {
      const limit = legal.get(Number(id))?.maxCopies;
      return limit === undefined || (mutated[id] ?? 0) < limit;
    });
    if (bumpable.length === 0 || total < 60) continue;
    const bumpId = pick(bumpable);
    const trimId = pick(
      Object.keys(mutated).filter((id) => (mutated[id] ?? 0) > 0),
    );
    if (bumpId === trimId) continue;
    mutated[bumpId] = (mutated[bumpId] ?? 0) + 1;
    mutated[trimId] = (mutated[trimId] ?? 0) - 1;
    if ((mutated[trimId] ?? 0) <= 0) delete mutated[trimId];
    return mutated;
  }
  return null;
}
