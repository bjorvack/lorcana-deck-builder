import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../prng';
import {
  genomeToVector,
  NEUTRAL_GENOME,
  type StrategyGenome,
  tunableStrategy,
  vectorToGenome,
} from './tunable-strategy';
import { mutate } from './weight-search';

/** structural fakes mirroring the engine's planner surface */
const def = (
  id: string,
  shape: {
    cost?: number;
    lore?: number;
    strength?: number;
    willpower?: number;
    inkable?: boolean;
    cardType?: string;
  },
) => ({
  id,
  ...shape,
});

function fakeContext(deckCards: Record<string, ReturnType<typeof def>>) {
  return {
    actorId: 'p1',
    opponentId: 'p2',
    board: { players: { p1: { lore: 5 }, p2: { lore: 12 } } },
    getCardDefinition: (cardId: string) => deckCards[cardId],
  };
}

const baseStrategy = (
  order: string[],
): {
  name: string;
  summarizeCandidates: (
    context: unknown,
    candidates: readonly unknown[],
  ) => Array<{
    candidate: {
      family: string;
      cardId?: string;
      attackerId?: string;
      defenderId?: string;
    };
  }>;
} => ({
  name: 'fake-base',
  summarizeCandidates: (_context, _candidates) =>
    order.map((cardId) => ({ candidate: { family: 'playCard', cardId } })),
});

describe('tunable strategy', () => {
  const deck = {
    a: def('a', { cost: 3, lore: 2, inkable: true, cardType: 'Character' }),
    b: def('b', { cost: 6, lore: 1, inkable: false, cardType: 'Character' }),
    c: def('c', { cost: 2, lore: 3, inkable: true, cardType: 'Character' }),
  };
  const context = fakeContext(deck);
  const candidates = [
    { family: 'playCard', cardId: 'a' },
    { family: 'playCard', cardId: 'b' },
    { family: 'playCard', cardId: 'c' },
  ];

  it('a neutral genome reproduces the wrapped strategy’s ordering', () => {
    const base = baseStrategy(['b', 'a', 'c']);
    const tuned = tunableStrategy(base, NEUTRAL_GENOME);
    expect(
      tuned
        .summarizeCandidates(context, candidates)
        .map((s) => s.candidate.cardId),
    ).toEqual(['b', 'a', 'c']);
  });

  it('a lore weight re-ranks quest candidates by lore', () => {
    const questBase = {
      name: 'fake-base',
      summarizeCandidates: () => [
        { candidate: { family: 'quest', cardId: 'b' } },
        { candidate: { family: 'quest', cardId: 'c' } },
      ],
    };
    // neutral: base order preserved (b first)
    const neutral = tunableStrategy(questBase, NEUTRAL_GENOME);
    expect(
      neutral.summarizeCandidates(context, []).map((s) => s.candidate.cardId),
    ).toEqual(['b', 'c']);
    // lore-positive: c (lore 3) overtakes b (lore 1)
    const loreGenome: StrategyGenome = { ...NEUTRAL_GENOME, base: 0, lore: 1 };
    const tuned = tunableStrategy(questBase, loreGenome);
    expect(
      tuned.summarizeCandidates(context, []).map((s) => s.candidate.cardId),
    ).toEqual(['c', 'b']);
  });

  it('an ink bias lifts ink candidates above plays', () => {
    const mixed = {
      name: 'fake-base',
      summarizeCandidates: () => [
        { candidate: { family: 'playCard', cardId: 'a' } },
        { candidate: { family: 'putCardIntoInkwell', cardId: 'c' } },
      ],
    };
    const inkGenome: StrategyGenome = {
      ...NEUTRAL_GENOME,
      base: 0.5,
      familyBias: { ...NEUTRAL_GENOME.familyBias, ink: 2 },
    };
    const tuned = tunableStrategy(mixed, inkGenome);
    expect(
      tuned.summarizeCandidates(context, []).map((s) => s.candidate.family),
    ).toEqual(['putCardIntoInkwell', 'playCard']);
  });

  it('round-trips genome ↔ vector', () => {
    const genome: StrategyGenome = {
      base: 0.5,
      familyBias: { playCard: 1, quest: -1, challenge: 0.5, ink: 2 },
      cost: -0.3,
      lore: 0.8,
      inkable: 0.2,
      killPotential: 0.4,
      denyLore: -0.1,
      tempo: 0.6,
    };
    expect(vectorToGenome(genomeToVector(genome))).toEqual(genome);
  });
});

describe('search helpers', () => {
  it('mutates deterministically from the seeded PRNG', () => {
    const genome = genomeToVector(NEUTRAL_GENOME);
    const a = mutate(genome, mulberry32(5), 0.25);
    const b = mutate(genome, mulberry32(5), 0.25);
    expect(a).toEqual(b);
    expect(a).not.toEqual(genome); // sigma > 0 must actually move
  });
});
