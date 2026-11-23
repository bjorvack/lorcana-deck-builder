import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import {
  featureVocabularies,
  cardFeatures as runtimeCardFeatures,
  fnv1a32 as runtimeFnv1a32,
} from '../../../src/generate/learned-fill';
import {
  cardFeatures,
  cardInteractionProfile,
  DUAL_SONG_OFFSET,
  FEATURE_DIM,
  FEATURE_NAMES,
  FEATURE_SCHEMA_VERSION,
  fnv1a32,
  hashCollisionStats,
  INTERACTION_DIM,
  INTERACTION_NAMES,
  interactionDims,
  KEYWORD_BLOCK_OFFSET,
  KEYWORD_HASH_WIDTH,
  NAME_BLOCK_OFFSET,
  NAME_HASH_WIDTH,
  SUBTYPE_BLOCK_OFFSET,
  SUBTYPE_HASH_WIDTH,
  seedInteractionAggregate,
  TAG_BLOCK_OFFSET,
  TAG_HASH_WIDTH,
  UNIQUE_NAME_OFFSET,
} from './features';

const CARDS: Card[] = (
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'public',
        'data',
        'cards.min.json',
      ),
      'utf8',
    ),
  ) as { cards: Card[] }
).cards;

const byFullName = (fullName: string): Card => {
  const card = CARDS.find((c) => c.fullName === fullName);
  if (!card) throw new Error(`fixture card not found: ${fullName}`);
  return card;
};

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

/** per-dimension closeness assert over the base dims (floats like 1/3 are not exact) */
function expectFeatures(card: Card, expected: number[]): void {
  const actual = cardFeatures(card);
  expect(actual.length).toBe(699);
  for (const [index, value] of expected.entries()) {
    expect(actual[index]).toBeCloseTo(value, 12);
  }
}

/** the v2 hashed blocks a bare fixture card: curated/subtype/tag blocks are
 * empty; the name block carries exactly its own parsed name's signed hash */
function expectEmptyHashedBlocks(card: Card): void {
  const features = cardFeatures(card);
  const block = (offset: number, length: number): number[] => [
    ...features.slice(offset, offset + length),
  ];
  expect(block(KEYWORD_BLOCK_OFFSET, KEYWORD_HASH_WIDTH)).toEqual(
    new Array(KEYWORD_HASH_WIDTH).fill(0),
  );
  expect(block(SUBTYPE_BLOCK_OFFSET, SUBTYPE_HASH_WIDTH)).toEqual(
    new Array(SUBTYPE_HASH_WIDTH).fill(0),
  );
  expect(block(TAG_BLOCK_OFFSET, TAG_HASH_WIDTH)).toEqual(
    new Array(TAG_HASH_WIDTH).fill(0),
  );
  expect(features[DUAL_SONG_OFFSET]).toBe(0);
  expect(features[DUAL_SONG_OFFSET + 1]).toBe(0);
  // own names always hash in (families or not): exactly one bucket carries
  // the card's parsed name, and the name is unique → uniqueName flag set
  const nameHash = fnv1a32(card.name);
  const nameSign = (nameHash >>> 8) & 1 ? 1 : -1;
  expect(block(NAME_BLOCK_OFFSET, NAME_HASH_WIDTH)).toEqual(
    new Array(NAME_HASH_WIDTH)
      .fill(0)
      .map((v, i) => (i === nameHash % NAME_HASH_WIDTH ? nameSign : v)),
  );
  expect(features[UNIQUE_NAME_OFFSET]).toBe(1);
}

describe('card features (schema v2, D2b hashed)', () => {
  it('pins the schema: version, frozen widths, offsets and unique names', () => {
    expect(FEATURE_SCHEMA_VERSION).toBe(2);
    expect(KEYWORD_HASH_WIDTH).toBe(32);
    expect(SUBTYPE_HASH_WIDTH).toBe(64);
    expect(TAG_HASH_WIDTH).toBe(64);
    expect(NAME_HASH_WIDTH).toBe(512);
    expect(KEYWORD_BLOCK_OFFSET).toBe(24);
    expect(SUBTYPE_BLOCK_OFFSET).toBe(56);
    expect(TAG_BLOCK_OFFSET).toBe(120);
    expect(DUAL_SONG_OFFSET).toBe(184);
    expect(NAME_BLOCK_OFFSET).toBe(186);
    expect(UNIQUE_NAME_OFFSET).toBe(698);
    expect(FEATURE_DIM).toBe(699);
    expect(FEATURE_NAMES).toHaveLength(FEATURE_DIM);
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
  });

  it('hashes identically to the pinned FNV-1a 32-bit constants', () => {
    // hand-computed FNV-1a 32 over the lowercased string (UTF-16 code units)
    expect(fnv1a32('gaston')).toBe(4118703771);
    expect(fnv1a32('Gaston')).toBe(fnv1a32('gaston')); // lowercased first
    expect(fnv1a32('hunny')).toBe(450073217);
    expect(fnv1a32('shift')).toBe(1409389383);
    expect(fnv1a32('draw')).toBe(2827744275);
    expect(fnv1a32('storyborn')).toBe(9916409);
    // bucket/sign split
    expect(fnv1a32('gaston') % NAME_HASH_WIDTH).toBe(155);
    expect((fnv1a32('gaston') >>> 8) & 1).toBe(0); // → −1
    expect(fnv1a32('shift') % NAME_HASH_WIDTH).toBe(327);
    expect((fnv1a32('shift') >>> 8) & 1).toBe(1); // → +1
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
    expectEmptyHashedBlocks(card);
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
    expectEmptyHashedBlocks(card);
  });

  it('flags every text-derived keyword, caps numerics and buckets long text', () => {
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

describe('card features v2 signed-hash blocks (D2b fixtures)', () => {
  it('hashes the curated keywords field ("Shift" family) into its bucket', () => {
    const shiftCard = byFullName('Gaston - Intellectual Powerhouse');
    const features = cardFeatures(shiftCard);
    // fnv1a32('shift') = 1409389383 → bucket 327, sign +1
    expect(fnv1a32('shift')).toBe(1409389383);
    expect(features[KEYWORD_BLOCK_OFFSET + (327 % KEYWORD_HASH_WIDTH)]).toBe(1);
    // exactly one keyword hash dim set (the card's only curated keyword)
    let setKeywordHashes = 0;
    for (let i = 0; i < KEYWORD_HASH_WIDTH; i++) {
      if (features[KEYWORD_BLOCK_OFFSET + i] !== 0) setKeywordHashes++;
    }
    expect(setKeywordHashes).toBe(1);
    // the text-derived flag (index 15) fires too — "Shift 4" is in the text
    expect(features[15]).toBe(1);
  });

  it('hashes subtypes, tags and sets the dual-ink/song flags', () => {
    // Christopher Robin - Hunny Sage: Dreamborn/Hero/Hunny
    const sage = byFullName('Christopher Robin - Hunny Sage');
    const features = cardFeatures(sage);
    // hand-pinned: fnv1a32('dreamborn') % 64 = 34 sign −1, 'hero' % 64 = 30
    // sign +1, 'hunny' % 64 = 33 sign −1 (asserted via the hash itself)
    for (const subtype of ['Dreamborn', 'Hero', 'Hunny']) {
      const hash = fnv1a32(subtype);
      const bucket = SUBTYPE_BLOCK_OFFSET + (hash % SUBTYPE_HASH_WIDTH);
      const sign = (hash >>> 8) & 1 ? 1 : -1;
      expect(features[bucket]).toBe(sign);
    }
    // a Song: isSong flag + Song subtype hash
    const song = byFullName('Be Our Guest');
    const songFeatures = cardFeatures(song);
    expect(songFeatures[DUAL_SONG_OFFSET + 1]).toBe(1);
    const songHash = fnv1a32('Song');
    expect(
      songFeatures[SUBTYPE_BLOCK_OFFSET + (songHash % SUBTYPE_HASH_WIDTH)],
    ).toBe((songHash >>> 8) & 1 ? 1 : -1);
    // a dual-ink card
    const dual = byFullName('Rhino - Power Hamster');
    expect(cardFeatures(dual)[DUAL_SONG_OFFSET]).toBe(1);
  });

  it('accumulates signed name hashes for own names and text references', () => {
    // LeFou - Bumbler: own name "LeFou" + text-referenced "Gaston"
    const lefou = byFullName('LeFou - Bumbler');
    const features = cardFeatures(lefou);
    const gastonHash = fnv1a32('Gaston');
    const gastonBucket = NAME_BLOCK_OFFSET + (gastonHash % NAME_HASH_WIDTH);
    const gastonSign = (gastonHash >>> 8) & 1 ? 1 : -1;
    expect(features[gastonBucket]).toBe(gastonSign);
    const lefouHash = fnv1a32('LeFou');
    const lefouBucket = NAME_BLOCK_OFFSET + (lefouHash % NAME_HASH_WIDTH);
    const lefouSign = (lefouHash >>> 8) & 1 ? 1 : -1;
    expect(features[lefouBucket]).toBe(lefouSign);
    // exactly two buckets carry load in a 2-line rules text
    let setBuckets = 0;
    for (let i = 0; i < NAME_HASH_WIDTH; i++) {
      if (features[NAME_BLOCK_OFFSET + i] !== 0) setBuckets++;
    }
    expect(setBuckets).toBe(2);
    // the Hunny Staff (Item, single unique name) references no family name:
    // only its own name hashes, and uniqueName stays set
    const staff = byFullName('Magical Hunny Staff');
    const staffFeatures = cardFeatures(staff);
    const staffHash = fnv1a32('Magical Hunny Staff');
    expect(
      staffFeatures[NAME_BLOCK_OFFSET + (staffHash % NAME_HASH_WIDTH)],
    ).toBe((staffHash >>> 8) & 1 ? 1 : -1);
    expect(staffFeatures[UNIQUE_NAME_OFFSET]).toBe(1);
  });

  it('accumulates +2·sign when a card is named and references itself', () => {
    // Winnie the Pooh & Piglet - Hunny Mages: Shift text names both parts
    const pooh = byFullName('Winnie the Pooh & Piglet - Hunny Mages');
    const features = cardFeatures(pooh);
    const poohHash = fnv1a32('Winnie the Pooh');
    const poohBucket = NAME_BLOCK_OFFSET + (poohHash % NAME_HASH_WIDTH);
    const poohSign = (poohHash >>> 8) & 1 ? 1 : -1;
    // named "Winnie the Pooh" AND referenced in the Shift reminder text
    expect(features[poohBucket]).toBe(2 * poohSign);
    expect(features[UNIQUE_NAME_OFFSET]).toBe(0); // both parts are families
  });

  it('reports the measured per-block collision rates (evidence input)', () => {
    const stats = hashCollisionStats();
    // families: 531 entries into 512 buckets — collisions are unavoidable
    expect(stats.nameFamilies.entries).toBe(531);
    expect(stats.nameFamilies.buckets).toBe(512);
    expect(stats.nameFamilies.usedBuckets).toBeLessThanOrEqual(512);
    expect(stats.nameFamilies.collidingEntries).toBeGreaterThan(0);
    expect(stats.nameFamilies.collisionRate).toBeCloseTo(
      stats.nameFamilies.collidingEntries / stats.nameFamilies.entries,
      6,
    );
    // the smaller blocks keep their collision rates recorded too
    for (const block of ['subtypes', 'keywords', 'tags'] as const) {
      expect(stats[block].collisionRate).toBeGreaterThanOrEqual(0);
      expect(stats[block].collisionRate).toBeLessThanOrEqual(1);
    }
    // the full name-block load: all 1,400 distinct parsed names
    expect(stats.nameBlockAllNames.entries).toBe(1400);
  });

  it('matches the runtime implementation on every real snapshot card', () => {
    expect(CARDS.length).toBeGreaterThan(1000);
    const vocab = featureVocabularies(CARDS);
    for (const card of CARDS) {
      const runtime = runtimeCardFeatures(card, vocab);
      const training = cardFeatures(card);
      expect(runtime.length).toBe(training.length);
      for (let i = 0; i < training.length; i++) {
        if (runtime[i] !== training[i]) {
          throw new Error(
            `feature dim ${i} (${FEATURE_NAMES[i]}) drifts for ${card.fullName}: ` +
              `runtime ${runtime[i]} ≠ training ${training[i]}`,
          );
        }
      }
    }
  });

  it('matches the runtime hash on every vocabulary string in the snapshot', () => {
    const names = [...new Set(CARDS.map((c) => c.name))].sort();
    const subtypes = [...new Set(CARDS.flatMap((c) => c.subtypes))].sort();
    const keywords = [...new Set(CARDS.flatMap((c) => c.keywords))].sort();
    const tags = [
      ...new Set(CARDS.flatMap((c) => c.tags.map((t) => t.tag))),
    ].sort();
    for (const value of [...names, ...subtypes, ...keywords, ...tags]) {
      expect(runtimeFnv1a32(value), value).toBe(fnv1a32(value));
    }
  });
});

describe('interaction dims (D2b, task 6.2)', () => {
  it('declares the eight pinned dims', () => {
    expect(INTERACTION_DIM).toBe(8);
    expect([...INTERACTION_NAMES]).toEqual([
      'nameOverlap',
      'shiftMatch',
      'refNameMatch',
      'nameTargetMatch',
      'traitEngineMatch',
      'traitTargetMatch',
      'selfRefTrait',
      'typeRefMatch',
    ]);
  });

  it('LeFou ↔ Gaston: refNameMatch and nameTargetMatch', () => {
    const lefou = byFullName('LeFou - Bumbler');
    const gaston = byFullName('Gaston - Intellectual Powerhouse');
    const dims = interactionDims(
      cardInteractionProfile(lefou),
      seedInteractionAggregate([cardInteractionProfile(gaston)]),
    );
    expect(dims[0]).toBe(0); // nameOverlap — no shared family
    expect(dims[1]).toBe(0); // shiftMatch — LeFou has no Shift keyword
    expect(dims[2]).toBe(1); // refNameMatch — text references Gaston, seed has him
    expect(dims[3]).toBe(0); // nameTargetMatch
    // converse direction: Gaston in a LeFou context is a name target
    const converse = interactionDims(
      cardInteractionProfile(gaston),
      seedInteractionAggregate([cardInteractionProfile(lefou)]),
    );
    expect(converse[3]).toBe(1);
    expect(converse[2]).toBe(0);
  });

  it('Grand Duke fires traitEngineMatch on all four royal subtypes', () => {
    const duke = byFullName('Grand Duke - Advisor to the King');
    const royals = ['Prince', 'Princess', 'King', 'Queen'].map((subtype) => {
      const card = CARDS.find(
        (c) => c.type === 'Character' && c.subtypes.includes(subtype),
      );
      if (!card) throw new Error(`no ${subtype} fixture card in snapshot`);
      return card;
    });
    const dims = interactionDims(
      cardInteractionProfile(duke),
      seedInteractionAggregate(royals.map(cardInteractionProfile)),
    );
    expect(dims[4]).toBe(4); // traitEngineMatch on Prince/Princess/King/Queen
    // each royal in a Grand Duke context is a trait target
    for (const royal of royals) {
      const target = interactionDims(
        cardInteractionProfile(royal),
        seedInteractionAggregate([cardInteractionProfile(duke)]),
      );
      expect(target[5]).toBe(1); // traitTargetMatch
    }
  });

  it('the Hunny package fires the trait dims on the Hunny subtype', () => {
    const staff = byFullName('Magical Hunny Staff');
    const poohPiglet = byFullName('Winnie the Pooh & Piglet - Hunny Mages');
    const sage = byFullName('Christopher Robin - Hunny Sage');
    // Staff wants Hunny characters: traitEngineMatch vs Pooh & Piglet
    const staffDims = interactionDims(
      cardInteractionProfile(staff),
      seedInteractionAggregate([cardInteractionProfile(poohPiglet)]),
    );
    expect(staffDims[4]).toBe(1); // traitEngineMatch (Hunny in seed subtypes)
    // Pooh & Piglet is a trait target of the Staff
    const poohDims = interactionDims(
      cardInteractionProfile(poohPiglet),
      seedInteractionAggregate([cardInteractionProfile(staff)]),
    );
    expect(poohDims[5]).toBe(1); // traitTargetMatch
    // the Sage references its own subtype: selfRefTrait is per-identity
    const sageProfile = cardInteractionProfile(sage);
    expect(sageProfile.selfRefTrait).toBe(true);
    const sageDims = interactionDims(sageProfile, seedInteractionAggregate([]));
    expect(sageDims[6]).toBe(1); // selfRefTrait fires with an empty seed
    // the Staff (Item with Hunny subtype, referencing Hunny) is selfRef too
    expect(cardInteractionProfile(staff).selfRefTrait).toBe(true);
    expect(cardInteractionProfile(poohPiglet).selfRefTrait).toBe(true);
  });

  it('Starlight Vial fires typeRefMatch on an Action seed (case-insensitive)', () => {
    const vial = byFullName('Starlight Vial');
    const action = CARDS.find((c) => c.type === 'Action');
    if (!action) throw new Error('no Action fixture card in snapshot');
    const dims = interactionDims(
      cardInteractionProfile(vial),
      seedInteractionAggregate([cardInteractionProfile(action)]),
    );
    expect(dims[7]).toBe(1); // typeRefMatch — "action" mentioned in text
    // no Character in the seed with the Vial alone → nothing else fires
    expect(dims[4]).toBe(0);
    expect(dims[5]).toBe(0);
  });

  it('shiftMatch fires for a Shift card over a same-named seed card', () => {
    const gastonShift = byFullName('Gaston - Intellectual Powerhouse');
    const gastonPlain = byFullName('Gaston - Arrogant Hunter');
    const dims = interactionDims(
      cardInteractionProfile(gastonShift),
      seedInteractionAggregate([cardInteractionProfile(gastonPlain)]),
    );
    expect(dims[1]).toBe(1); // shiftMatch
    expect(dims[0]).toBe(1); // nameOverlap (Gaston family shared)
    // a non-shift card with the same name context does not fire shiftMatch
    const plainDims = interactionDims(
      cardInteractionProfile(gastonPlain),
      seedInteractionAggregate([cardInteractionProfile(gastonShift)]),
    );
    expect(plainDims[1]).toBe(0);
  });
});
