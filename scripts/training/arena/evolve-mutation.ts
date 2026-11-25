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
import type { Card } from '../../../src/data/types';
import type { CardMap } from './card-map';
import { affinityTo, deckSize } from './deck-utils';

export { deckSignature } from './deck-utils';

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
  for (const identity of Object.keys(cardMap.byIdentity)) {
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
        const score = affinityTo(
          id,
          mutated,
          mutationCtx.interactions?.partners ?? null,
        );
        if (score < weakestScore) {
          weakestScore = score;
          weakest = id;
        }
      }
      let strongest: string | null = null;
      let strongestScore = -1;
      for (const id of Object.keys(mutated)) {
        if (id === weakest) continue;
        const score = affinityTo(
          id,
          mutated,
          mutationCtx.interactions?.partners ?? null,
        );
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
