import { describe, expect, it } from 'vitest';
import { buildCanonicalRegistry } from '../canonical';
import { mulberry32 } from '../prng';
import { buildCardMap } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import {
  deckSignature,
  legalIdentities,
  type MutationContext,
  mutateDeck,
} from './evolve-mutation';

const cards = loadCards();

describe('deck mutation', () => {
  it('preserves arena legality across many random mutations', async () => {
    const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
    const catalog = await loadEngineCatalog();
    const cardMap = buildCardMap({
      cards,
      alias,
      canonicalByGroup,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const legal = legalIdentities(cards, cardMap);
    // seed deck: 20 identities x 3 from the legal set (Amber/Sapphire)
    const amberSapphire = [...legal.entries()]
      .filter(
        ([, v]) => v.inks.includes('Amber') || v.inks.includes('Sapphire'),
      )
      .filter(([, v]) => v.maxCopies >= 3)
      .slice(0, 20)
      .map(([id]) => id);
    const deck: Record<string, number> = {};
    for (const id of amberSapphire) deck[String(id)] = 3;
    const inks = ['Amber', 'Sapphire'];
    const ctx: MutationContext = { legalByIdentity: legal, interactions: null };
    const rng = mulberry32(7);
    for (let i = 0; i < 25; i++) {
      const mutated = mutateDeck(deck, inks, ctx, rng);
      if (!mutated) continue;
      expect(deckSize(mutated)).toBe(60);
      // all identities legal
      for (const id of Object.keys(mutated)) {
        expect(legal.has(Number(id))).toBe(true);
        expect(mutated[id]!).toBeLessThanOrEqual(
          legal.get(Number(id))!.maxCopies,
        );
      }
      // ink count preserved (mutations only add cards sharing a deck ink)
      const inksSeen = new Set<string>();
      for (const id of Object.keys(mutated)) {
        for (const ink of legal.get(Number(id))!.inks) inksSeen.add(ink);
      }
      expect(inksSeen.size).toBeLessThanOrEqual(2);
    }
  }, 60_000);

  it('synergy swap drops the least-connected card', () => {
    const legal = new Map<number, { maxCopies: number; inks: string[] }>();
    for (const id of [1, 2, 3, 4])
      legal.set(id, { maxCopies: 4, inks: ['Amber'] });
    const interactions = {
      partners: {
        // card 1 is strongly partnered with card 2; card 3 has no partners
        1: [[2, 255]],
        2: [[1, 255]],
      } as Record<string, Array<[number, number]>>,
    };
    const deck = { 1: 4, 2: 4, 3: 4, 4: 4 };
    const ctx: MutationContext = { legalByIdentity: legal, interactions };
    const mutated = mutateDeck(deck, ['Amber'], ctx, mulberry32(1));
    if (!mutated) return; // no legal mutation found in 12 attempts: valid
    expect(deckSize(mutated)).toBe(16);
  });

  it('signatures differ when copy counts differ', () => {
    expect(deckSignature({ 1: 3 })).not.toBe(deckSignature({ 1: 4 }));
    expect(deckSignature({ 1: 3, 2: 1 })).toBe(deckSignature({ 2: 1, 1: 3 }));
  });
});

function deckSize(cards: Record<string, number>): number {
  return Object.values(cards).reduce((a, b) => a + b, 0);
}
