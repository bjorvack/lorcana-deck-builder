/**
 * MAP-Elites mutation operators (self-play-league, task 4.2, design D5).
 *
 * A mutant swaps one or a few card groups: remove 1–2 copies of one identity
 * ("a random group", respecting counts) and refill the slots from the
 * self-play pool. This is the spirit of evolve-mutation.ts's random swap /
 * synergy swap (a 1-copy swap ≡ its count adjust), but that module
 * top-level-imports play.ts (the vendored engine chain), so the small pure
 * pieces are reimplemented here to keep this module engine-free; the trained
 * partners table is optional and injected by the caller.
 *
 * Legality is never trusted from the operator: every candidate must clear
 * elitesDeckProblems() — pool membership, copy limits, ink declaration, and
 * full src/rules validateDeck (60-card minimum, per-group copy limits across
 * prints, dual-ink, format bans) — before it is returned. The pool passed in
 * MUST be the output of league.legalSelfPlayIdentities (arena-legal ∩
 * fully-scripted), so pool membership is the arena-eligibility (mapped,
 * self-play) gate. An archive therefore can never contain an illegal deck.
 */
import type { Card, Format, Ink } from '../../../src/data/types';
import { MIN_DECK_SIZE, validateDeck } from '../../../src/rules/engine';

export interface PoolEntry {
  /** copy limit of the identity (maxCopies of its canonical card) */
  maxCopies: number;
  /** the card's inks; adds must be a subset of the deck's declared inks */
  inks: string[];
}

/** arena-legal, fully-scripted identity pool (league.legalSelfPlayIdentities) */
export type LegalPool = Map<number, PoolEntry>;

export interface MutateElitesOptions {
  /** max swap steps per mutant, each swapping 1–2 copies (default 2) */
  swaps?: number;
  /** attempts before giving up and returning null (default 24) */
  maxAttempts?: number;
  /** trained partners table; enables synergy-guided drop/add (optional) */
  interactions?: { partners: Record<string, Array<[number, number]>> } | null;
  /** format validateDeck enforces (default 'core') */
  format?: Format;
}

export const DEFAULT_MAX_ATTEMPTS = 24;
/** refill picks per swap step before the step is abandoned */
const REFILL_TRIES = 12;
/** copies a single swap step may remove from one identity */
const MAX_GROUP_REMOVAL = 2;

const deckSize = (cards: Record<string, number>): number =>
  Object.values(cards).reduce((a, b) => a + b, 0);

/**
 * Declared inks of a deck: the union of its cards' inks (≤ 2 for legal
 * decks, since every card's inks must be declared). Computed from the pool
 * — parents fed to mutateDeckElites must be pool-legal.
 */
export function declaredInks(
  deck: Record<string, number>,
  pool: LegalPool,
): string[] {
  const inks = new Set<string>();
  for (const identity of Object.keys(deck)) {
    if ((deck[identity] ?? 0) <= 0) continue;
    for (const ink of pool.get(Number(identity))?.inks ?? []) inks.add(ink);
  }
  return [...inks].sort();
}

/**
 * Full legality + eligibility gate for archive decks: exactly 60 cards, every
 * identity in the pool within its copy limit, declared inks covering every
 * card (pool-restricted — stricter than the rules' ink exemptions), ≤ 2
 * declared inks, and zero src/rules validateDeck violations. Returns problem
 * strings (empty = legal).
 */
export function elitesDeckProblems(
  deck: Record<string, number>,
  pool: LegalPool,
  cards: readonly Card[],
  format: Format = 'core',
): string[] {
  const problems: string[] = [];
  const total = deckSize(deck);
  if (total !== MIN_DECK_SIZE) {
    problems.push(`card-count-${total}`);
  }
  // a legal parent declares every card ink, so the union is ≤ 2 inks
  const inks = declaredInks(deck, pool);
  if (inks.length > 2) problems.push(`inks-${inks.length}`);
  for (const [identity, count] of Object.entries(deck)) {
    const entry = pool.get(Number(identity));
    if (!entry) {
      problems.push(`not-in-pool-${identity}`);
      continue;
    }
    if (count > entry.maxCopies) {
      problems.push(`copy-limit-${identity}-${count}>${entry.maxCopies}`);
    }
    if (!entry.inks.every((ink) => inks.includes(ink))) {
      problems.push(`off-ink-${identity}`);
    }
  }
  // the app owns the rules: 60-card minimum, per-group copy limits across
  // prints, dual-ink, format bans — the archive never overrides it
  const byId = new Map(cards.map((c) => [c.id, c]));
  const numeric: Record<number, number> = {};
  for (const [identity, count] of Object.entries(deck)) {
    numeric[Number(identity)] = count;
  }
  for (const violation of validateDeck(
    { title: 'map-elites', inks: inks as Ink[], format, cards: numeric },
    byId,
  )) {
    problems.push(`${violation.rule}:${violation.message}`);
  }
  return problems;
}

/**
 * Same convention as evolve-mutation.ts / league.ts (31-multiplier FNV-style
 * hash, 8 hex chars). Reimplemented locally instead of imported to keep this
 * module free of evolve-mutation's engine import chain (play.ts).
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

/** partner affinity of `id` to the rest of the deck (both table directions) */
function affinityTo(
  id: string,
  deckCards: Record<string, number>,
  partners: Record<string, Array<[number, number]>>,
): number {
  let best = 0;
  for (const [partner, score] of partners[id] ?? []) {
    if ((deckCards[String(partner)] ?? 0) > 0) best = Math.max(best, score);
  }
  for (const deckId of Object.keys(deckCards)) {
    for (const [partner, score] of partners[deckId] ?? []) {
      if (String(partner) === id) best = Math.max(best, score);
    }
  }
  return best;
}

const pick = <T>(list: T[], rng: () => number): T =>
  list[Math.floor(rng() * list.length)]!;

interface SwapContext {
  pool: LegalPool;
  poolIds: number[];
  inks: string[];
  interactions: { partners: Record<string, Array<[number, number]>> } | null;
  /** identities reduced earlier in this attempt — never refilled by it */
  reduced: Set<string>;
  rng: () => number;
}

const fitsPool = (pool: LegalPool, id: number, inks: string[]): boolean =>
  pool.get(id)?.inks.every((ink) => inks.includes(ink)) ?? false;

/**
 * One swap step on `cards` (mutated in place): remove 1–MAX_GROUP_REMOVAL
 * copies of one identity, refill the slots from the pool. Returns false when
 * the step could not complete (the whole attempt is then discarded).
 */
function swapStep(cards: Record<string, number>, ctx: SwapContext): boolean {
  const present = Object.keys(cards)
    .filter((id) => (cards[id] ?? 0) > 0)
    .sort((a, b) => Number(a) - Number(b));
  if (present.length === 0) return false;

  const roll = ctx.rng();
  if (roll < 0.34 && ctx.interactions) {
    // synergy swap: drop the least-connected identity, refill from the best
    // trained partners of the most-connected remaining one (evolve spirit)
    let weakest: string | null = null;
    let weakestScore = Number.POSITIVE_INFINITY;
    for (const id of present) {
      const score = affinityTo(id, cards, ctx.interactions.partners);
      if (score < weakestScore) {
        weakestScore = score;
        weakest = id;
      }
    }
    let strongest: string | null = null;
    let strongestScore = -1;
    for (const id of present) {
      if (id === weakest) continue;
      const score = affinityTo(id, cards, ctx.interactions.partners);
      if (score > strongestScore) {
        strongestScore = score;
        strongest = id;
      }
    }
    if (!weakest || !strongest) return false;
    const dropCount = Math.min(cards[weakest]!, MAX_GROUP_REMOVAL);
    const candidates = (ctx.interactions.partners[strongest] ?? [])
      .map(([partner]) => partner)
      .filter(
        (p) =>
          !ctx.reduced.has(String(p)) &&
          (cards[String(p)] ?? 0) === 0 &&
          (ctx.pool.get(p)?.maxCopies ?? 0) >= dropCount &&
          fitsPool(ctx.pool, p, ctx.inks),
      )
      .sort((a, b) => a - b);
    if (candidates.length === 0) return false;
    const addId = candidates[Math.floor(ctx.rng() * candidates.length)]!;
    cards[weakest] = cards[weakest]! - dropCount;
    if (cards[weakest]! <= 0) delete cards[weakest];
    ctx.reduced.add(weakest);
    cards[String(addId)] = (cards[String(addId)] ?? 0) + dropCount;
    return true;
  }

  // random swap: remove a random group, refill one copy at a time
  const dropId = pick(present, ctx.rng);
  const dropCount =
    1 + Math.floor(ctx.rng() * Math.min(MAX_GROUP_REMOVAL, cards[dropId]!));
  cards[dropId] = cards[dropId]! - dropCount;
  if (cards[dropId]! <= 0) delete cards[dropId];
  ctx.reduced.add(dropId);
  let added = 0;
  for (let fill = 0; fill < REFILL_TRIES && added < dropCount; fill++) {
    const addId = pick(ctx.poolIds, ctx.rng);
    if (ctx.reduced.has(String(addId))) continue;
    const limit = ctx.pool.get(addId)?.maxCopies ?? 0;
    if ((cards[String(addId)] ?? 0) + 1 > limit) continue;
    if (!fitsPool(ctx.pool, addId, ctx.inks)) continue;
    cards[String(addId)] = (cards[String(addId)] ?? 0) + 1;
    added += 1;
  }
  return added === dropCount;
}

/**
 * Mutate a legal parent deck by swapping 1..k card groups, validated end to
 * end. Returns a deck that passes elitesDeckProblems() (hence full
 * src/rules validateDeck) and differs from the parent, or null after
 * `maxAttempts` failed attempts — never an illegal deck. Deterministic
 * given the rng stream (seeded mulberry32 only).
 */
export function mutateDeckElites(
  deck: Record<string, number>,
  pool: LegalPool,
  cards: readonly Card[],
  rng: () => number,
  opts: MutateElitesOptions = {},
): Record<string, number> | null {
  const swaps = Math.max(1, opts.swaps ?? 2);
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const format = opts.format ?? 'core';
  const poolIds = [...pool.keys()].sort((a, b) => a - b);
  const inks = declaredInks(deck, pool);
  const parentSig = deckSignature(deck);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const mutated = { ...deck };
    const reduced = new Set<string>();
    const ctx: SwapContext = {
      pool,
      poolIds,
      inks,
      interactions: opts.interactions ?? null,
      reduced,
      rng,
    };
    let complete = true;
    for (let step = 0; step < swaps && complete; step++) {
      complete = swapStep(mutated, ctx);
    }
    if (!complete) continue;
    if (deckSignature(mutated) === parentSig) continue;
    if (elitesDeckProblems(mutated, pool, cards, format).length > 0) continue;
    return mutated;
  }
  return null;
}
