import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import {
  cardFeatures,
  FEATURE_DIM,
  FEATURE_NAMES,
  FEATURE_SCHEMA_VERSION,
} from './features';

/** minimal fixture card: only the fields features.ts reads vary */
function makeCard(
  overrides: Partial<Card> & Pick<Card, 'name' | 'type'>,
): Card {
  return {
    id: 1,
    fullName: overrides.name,
    groupKey: overrides.name.toLowerCase(),
    inks: ['ruby'],
    isDualInk: false,
    cost: 1,
    inkwell: false,
    subtypes: [],
    isSong: false,
    franchise: 'fixture',
    setCode: 'TST',
    setName: 'Fixture Set',
    setNumber: 1,
    setType: 'expansion',
    rarity: 'common',
    maxCopies: 3,
    text: '',
    keywords: [],
    tags: [],
    deckRuleEffects: [],
    payoffs: [],
    images: {},
    formats: { core: true, infinity: true },
    ...overrides,
  } as Card;
}

/** per-dimension closeness assert (floats like 1/3 are not exact) */
function expectFeatures(card: Card, expected: number[]): void {
  const actual = cardFeatures(card);
  expect(actual.length).toBe(expected.length);
  for (const [index, value] of expected.entries()) {
    expect(actual[index]).toBeCloseTo(value, 12);
  }
}

describe('card features (schema v1)', () => {
  it('pins the schema: version, dim and unique names', () => {
    expect(FEATURE_SCHEMA_VERSION).toBe(1);
    expect(FEATURE_NAMES.length).toBe(24);
    expect(FEATURE_DIM).toBe(24);
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
  });

  it('computes the hand-checked vector for an inkable rusher character', () => {
    // "Rush\nWhen you play this character, deal 2 damage to chosen character."
    // = 69 chars → text bucket 1; one numeric token ("2")
    const card = makeCard({
      name: 'Fixture Rusher',
      type: 'Character',
      cost: 3,
      inkwell: true,
      strength: 4,
      willpower: 5,
      lore: 2,
      text: 'Rush\nWhen you play this character, deal 2 damage to chosen character.',
    });
    expectFeatures(card, [
      0.3, // cost 3/10
      1, // inkable
      1,
      0,
      0,
      0, // character
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // rush only
      0.5,
      0.4,
      0.4, // willpower 5/10, strength 4/10, lore 2/5
      1 / 3, // text bucket 1
      0.2, // one numeric token / 5
      1,
      0,
      0, // when you play / on play / during-turn
    ]);
  });

  it('computes a non-inkable action with a when-played trigger', () => {
    const card = makeCard({
      name: 'Fixture Removal',
      type: 'Action',
      cost: 6,
      text: 'When you play this action, each opponent loses 1 lore.',
    });
    expectFeatures(card, [
      0.6, // cost 6/10
      0, // not inkable
      0,
      1,
      0,
      0, // action
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // no keywords
      0,
      0,
      0, // no stats
      1 / 3, // 54 chars → bucket 1
      0.2, // one numeric token
      1,
      0,
      0,
    ]);
  });

  it('treats items and locations correctly (item type, location → other)', () => {
    const item = makeCard({ name: 'Fixture Item', type: 'Item', cost: 1 });
    expectFeatures(item, [
      0.1,
      0,
      0,
      0,
      1,
      0, // item one-hot, cost 1/10
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0, // no text at all
    ]);
    const location = makeCard({
      name: 'Fixture Location',
      type: 'Location',
      cost: 2,
      willpower: 4,
      lore: 1,
      text: 'During each of your turns, if a character is here, you gain 1 lore.',
    });
    expectFeatures(location, [
      0.2,
      0,
      0,
      0,
      0,
      1, // other one-hot
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0.4,
      0,
      0.2, // willpower 4/10, lore 1/5
      1 / 3, // 67 chars → bucket 1
      0.2,
      0,
      0,
      1, // during-turn flag
    ]);
  });

  it('flags every keyword from body text, caps numerics and buckets long text', () => {
    const base =
      'Rush. Evasive. Singer 3. Ward. Resist +1. Challenger +2. Support. ' +
      'reckless. Bodyguard. Shift 4. On play, banish 1 2 3 4 5 6 7.';
    const text = `${base}${' '.repeat(120)}`;
    expect(text.length).toBeGreaterThan(200); // → bucket 3
    const card = makeCard({
      name: 'Fixture Keyword Sweep',
      type: 'Character',
      cost: 12, // clamps to 1
      strength: 99, // clamps to 1
      text,
    });
    const features = cardFeatures(card);
    expect(features[0]).toBe(1); // cost clamped
    expect(features[17]).toBe(1); // strength clamped
    for (const index of [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(features[index]).toBe(1); // all ten keyword flags
    }
    expect(features[19]).toBe(1); // text bucket 3 / 3
    expect(features[20]).toBe(1); // 11 numerals capped at 5 / 5
    expect(features[21]).toBe(0); // no "when you play"
    expect(features[22]).toBe(1); // "On play"
    expect(features[23]).toBe(0);
  });

  it('places text-length bucket boundaries at 80 and 200 chars', () => {
    const bucketOf = (text: string): number => {
      const features = cardFeatures(
        makeCard({ name: 'B', type: 'Action', text }),
      );
      return features[19]!;
    };
    expect(bucketOf('a'.repeat(80))).toBeCloseTo(1 / 3, 12); // bucket 1
    expect(bucketOf('a'.repeat(81))).toBeCloseTo(2 / 3, 12); // bucket 2
    expect(bucketOf('a'.repeat(200))).toBeCloseTo(2 / 3, 12);
    expect(bucketOf('a'.repeat(201))).toBe(1); // bucket 3
  });

  it('is a pure function: repeated calls return equal fresh vectors', () => {
    const card = makeCard({
      name: 'Pure',
      type: 'Character',
      cost: 5,
      inkwell: true,
      text: 'Rush',
    });
    const first = cardFeatures(card);
    const second = cardFeatures(card);
    first[0] = 123; // mutating one result must not leak into the next
    expect([...cardFeatures(card)]).toEqual([...second]);
    expect([...second]).not.toEqual([...first]);
  });
});
