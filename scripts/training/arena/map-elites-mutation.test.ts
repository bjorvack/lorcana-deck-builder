/**
 * MAP-Elites mutation tests: the property gate (100 seeded mutations all
 * fully legal and different from their parent) plus exhaustion and
 * determinism cases — synthetic pool, no engine, no games.
 */
import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import { validateDeck } from '../../../src/rules/engine';
import { mulberry32 } from '../prng';
import {
  deckSignature,
  declaredInks,
  elitesDeckProblems,
  type LegalPool,
  mutateDeckElites,
} from './map-elites-mutation';

const mkCard = (id: number, ink: 'Amber' | 'Ruby'): Card => ({
  id,
  name: `Card ${id}`,
  fullName: `Card ${id}`,
  groupKey: `card-${id}`,
  inks: [ink],
  isDualInk: false,
  cost: 3,
  inkwell: true,
  type: 'Character',
  subtypes: ['Floodborn'],
  isSong: false,
  franchise: 'test',
  setCode: 'TST',
  setName: 'Test',
  setNumber: 1,
  setType: 'expansion',
  rarity: 'common',
  maxCopies: 3,
  lore: 2,
  text: '',
  keywords: [],
  tags: [],
  deckRuleEffects: [],
  payoffs: [],
  images: {},
  formats: { core: true, infinity: true },
});

// 30 identities: 100–124 Amber, 125–129 Ruby; max 3 copies each
const cards: Card[] = [
  ...Array.from({ length: 25 }, (_, i) => mkCard(100 + i, 'Amber')),
  ...Array.from({ length: 5 }, (_, i) => mkCard(125 + i, 'Ruby')),
];
const pool: LegalPool = new Map(
  cards.map((c) => [c.id, { maxCopies: 3, inks: c.inks }]),
);

const seq = (start: number, end: number): Record<string, number> => {
  const deck: Record<string, number> = {};
  for (let id = start; id <= end; id++) deck[String(id)] = 3;
  return deck;
};

// 20 Amber identities × 3 = 60 cards, declared inks ['Amber']
const seedDeck = seq(100, 119);
const seedInks = declaredInks(seedDeck, pool);

const asDeckState = (deck: Record<string, number>) => ({
  title: 'test',
  inks: declaredInks(deck, pool) as ('Amber' | 'Ruby')[],
  format: 'core' as const,
  cards: Object.fromEntries(
    Object.entries(deck).map(([id, count]) => [Number(id), count]),
  ),
});

const distance = (
  a: Record<string, number>,
  b: Record<string, number>,
): number => {
  let total = 0;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    total += Math.abs((a[id] ?? 0) - (b[id] ?? 0));
  }
  return total;
};

describe('mutateDeckElites property: 100 seeded mutations stay legal', () => {
  it('every output passes validateDeck, the pool gate and differs from its parent', () => {
    const rng = mulberry32(11);
    expect(seedInks).toEqual(['Amber']);
    let parent = seedDeck;
    for (let i = 0; i < 100; i++) {
      const mutant = mutateDeckElites(parent, pool, cards, rng);
      expect(mutant, `mutation ${i} returned null`).not.toBeNull();
      const next = mutant!;
      // full rules validation against the declared inks
      expect(
        validateDeck(asDeckState(next), new Map(cards.map((c) => [c.id, c]))),
      ).toEqual([]);
      // arena eligibility: pool membership, copy limits, declared inks
      expect(elitesDeckProblems(next, pool, cards)).toEqual([]);
      // size and composition invariants
      expect(Object.values(next).reduce((a, b) => a + b, 0)).toBe(60);
      for (const [id, count] of Object.entries(next)) {
        expect(pool.has(Number(id))).toBe(true);
        expect(count).toBeLessThanOrEqual(3);
        expect(pool.get(Number(id))?.inks).toContain('Amber');
      }
      expect(deckSignature(next)).not.toBe(deckSignature(parent));
      parent = next;
    }
  }, 30_000);

  it('is deterministic: the same seed replays the same mutation chain', () => {
    const chain = (seed: number): string[] => {
      const rng = mulberry32(seed);
      let parent = seedDeck;
      const signatures: string[] = [];
      for (let i = 0; i < 25; i++) {
        const mutant = mutateDeckElites(parent, pool, cards, rng);
        if (!mutant) break;
        signatures.push(deckSignature(mutant));
        parent = mutant;
      }
      return signatures;
    };
    expect(chain(7)).toEqual(chain(7));
    expect(chain(7)).not.toEqual(chain(8));
  });

  it('honours the swaps option (distance = 2 × removed copies)', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 10; i++) {
      const mutant = mutateDeckElites(seedDeck, pool, cards, rng, { swaps: 1 });
      expect(mutant).not.toBeNull();
      const d = distance(seedDeck, mutant!);
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThanOrEqual(4); // one step removes 1–2 copies
      expect(d % 2).toBe(0);
    }
  });
});

describe('mutateDeckElites never returns an illegal deck', () => {
  it('returns null when the pool is exhausted (everything at its copy limit)', () => {
    const tinyCards = cards.filter((c) => c.id >= 100 && c.id < 120);
    const tinyPool: LegalPool = new Map(
      tinyCards.map((c) => [c.id, { maxCopies: 3, inks: c.inks }]),
    );
    const full = seq(100, 119); // holds every pool copy: 20 × 3 = 60
    expect(elitesDeckProblems(full, tinyPool, tinyCards)).toEqual([]);
    const mutant = mutateDeckElites(full, tinyPool, tinyCards, mulberry32(3), {
      maxAttempts: 4,
    });
    expect(mutant).toBeNull();
  });

  it('returns null instead of a deck failing full validation (59 cards)', () => {
    const short: Record<string, number> = {};
    for (const [id, count] of Object.entries(seedDeck)) {
      short[id] = count;
    }
    short['100'] = 2; // 59 cards — below the 60-card minimum
    const mutant = mutateDeckElites(short, pool, cards, mulberry32(4), {
      maxAttempts: 3,
    });
    expect(mutant).toBeNull();
  });

  it('synergy-guided swaps (injected interactions) also stay legal', () => {
    const interactions = {
      partners: {
        // 100 ↔ 101 are strong partners; the others are unconnected
        100: [[101, 255]],
        101: [[100, 255]],
      } as Record<string, Array<[number, number]>>,
    };
    const rng = mulberry32(9);
    let parent = seedDeck;
    for (let i = 0; i < 20; i++) {
      const mutant = mutateDeckElites(parent, pool, cards, rng, {
        interactions,
      });
      expect(mutant).not.toBeNull();
      expect(elitesDeckProblems(mutant!, pool, cards)).toEqual([]);
      expect(deckSignature(mutant!)).not.toBe(deckSignature(parent));
      parent = mutant!;
    }
  });
});
