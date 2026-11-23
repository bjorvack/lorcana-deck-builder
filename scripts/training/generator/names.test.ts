import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import {
  CARD_TYPE_VOCAB,
  cardNameInfo,
  familyIndex,
  NAME_CARD_COUNTS,
  NAME_FAMILIES,
  parseCardNames,
  SUBTYPE_VOCAB,
} from './names';

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

/** minimal fixture card outside the snapshot (unique id per call) */
let fixtureId = 900_000;
function makeCard(
  overrides: Partial<Card> & Pick<Card, 'name' | 'text'>,
): Card {
  fixtureId += 1;
  return {
    id: fixtureId,
    fullName: overrides.name,
    groupKey: overrides.name.toLowerCase(),
    inks: ['ruby'],
    isDualInk: false,
    cost: 1,
    inkwell: false,
    type: 'Character',
    subtypes: [],
    isSong: false,
    franchise: 'fixture',
    setCode: 'TST',
    setName: 'Fixture Set',
    setNumber: 1,
    setType: 'expansion',
    rarity: 'common',
    maxCopies: 3,
    keywords: [],
    tags: [],
    deckRuleEffects: [],
    payoffs: [],
    images: {},
    formats: { core: true, infinity: true },
    ...overrides,
  } as Card;
}

describe('name parsing', () => {
  it('splits only on the exact " & " separator', () => {
    expect(parseCardNames('Flotsam & Jetsam')).toEqual(['Flotsam', 'Jetsam']);
    expect(parseCardNames('Mickey Mouse & Minnie Mouse')).toEqual([
      'Mickey Mouse',
      'Minnie Mouse',
    ]);
    expect(parseCardNames('Aladdin')).toEqual(['Aladdin']);
  });

  it('keeps the Hamish comma composite intact (no standalone Hamish/Hubert cards)', () => {
    // Verified in the snapshot: NAME_CARD_COUNTS has no "Hamish"/"Hubert"
    // entries, and "Hamish, Hubert" sits on 2 cards ("Making Mischief",
    // "Troublemaking Triplets"). Splitting the comma would break the pinned
    // 531-family / 1400-name vocabulary.
    expect(parseCardNames('Hamish, Hubert & Harris')).toEqual([
      'Hamish, Hubert',
      'Harris',
    ]);
    expect(NAME_CARD_COUNTS.get('Hamish')).toBeUndefined();
    expect(NAME_CARD_COUNTS.get('Hubert')).toBeUndefined();
    expect(NAME_CARD_COUNTS.get('Hamish, Hubert')).toBe(2);
  });

  it('never splits on commas, periods or exclamation marks', () => {
    // "Fix-It Felix, Jr." — one name, 4 prints, and no "Fix-It Felix" family
    // exists that trimming the ", Jr." would invent.
    expect(parseCardNames('Fix-It Felix, Jr.')).toEqual(['Fix-It Felix, Jr.']);
    expect(NAME_CARD_COUNTS.get('Fix-It Felix, Jr.')).toBe(4);
    expect(NAME_CARD_COUNTS.has('Fix-It Felix')).toBe(false);
    // "Wake Up, Alice!" — one Action name, "!" intact.
    expect(parseCardNames('Wake Up, Alice!')).toEqual(['Wake Up, Alice!']);
  });

  it('has exactly 37 multi-name cards in the snapshot', () => {
    expect(CARDS.filter((c) => c.name.includes(' & '))).toHaveLength(37);
  });

  it('has 1400 distinct parsed names snapshot-wide', () => {
    expect(NAME_CARD_COUNTS.size).toBe(1400);
  });

  it('never includes the version field in a parsed name', () => {
    for (const card of CARDS) {
      if (!card.version) continue;
      const names = parseCardNames(card.name).join(' & ');
      expect(names).not.toContain(card.version);
    }
  });
});

describe('family vocabulary', () => {
  it('pins 531 families, sorted, distinct', () => {
    expect(NAME_FAMILIES).toHaveLength(531);
    expect([...NAME_FAMILIES].sort()).toEqual([...NAME_FAMILIES]);
    expect(new Set(NAME_FAMILIES).size).toBe(NAME_FAMILIES.length);
    expect(NAME_FAMILIES[0]).toBe('4*Town');
  });

  it('partitions the vocabulary into 531 families + 869 unique names', () => {
    const families = [...NAME_CARD_COUNTS].filter(([, n]) => n >= 2).length;
    const unique = [...NAME_CARD_COUNTS].filter(([, n]) => n === 1).length;
    expect(families).toBe(531);
    expect(unique).toBe(869);
    expect(families + unique).toBe(NAME_CARD_COUNTS.size);
  });

  it('counts the Gaston family at 14 cards', () => {
    expect(NAME_CARD_COUNTS.get('Gaston')).toBe(14);
    expect(NAME_FAMILIES).toContain('Gaston');
  });

  it('indexes families 1-based and unique/unknown names as -1', () => {
    expect(familyIndex(NAME_FAMILIES[0] as string)).toBe(1);
    expect(familyIndex(NAME_FAMILIES[NAME_FAMILIES.length - 1] as string)).toBe(
      NAME_FAMILIES.length,
    );
    for (const family of NAME_FAMILIES) {
      expect(familyIndex(family)).toBe(NAME_FAMILIES.indexOf(family) + 1);
    }
    expect(familyIndex('Wake Up, Alice!')).toBe(-1); // unique bucket
    expect(familyIndex('Not A Real Card Name')).toBe(-1); // unknown
  });
});

describe('subtype and type vocabularies', () => {
  it('pins the 50-subtype vocabulary, sorted and distinct', () => {
    expect(SUBTYPE_VOCAB).toHaveLength(50);
    expect([...SUBTYPE_VOCAB].sort()).toEqual([...SUBTYPE_VOCAB]);
    expect(new Set(SUBTYPE_VOCAB).size).toBe(SUBTYPE_VOCAB.length);
  });

  it('contains the Hunny, Seven Dwarfs and classification subtypes', () => {
    for (const subtype of [
      'Hunny',
      'Seven Dwarfs',
      'Prince',
      'Princess',
      'King',
      'Queen',
    ]) {
      expect(SUBTYPE_VOCAB).toContain(subtype);
    }
  });

  it('pins the fixed card-type vocabulary in dim order', () => {
    expect([...CARD_TYPE_VOCAB]).toEqual([
      'Character',
      'Action',
      'Item',
      'Location',
    ]);
  });
});

describe('cardNameInfo reference extraction', () => {
  it('extracts LeFou - Bumbler → [Gaston]', () => {
    const info = cardNameInfo(byFullName('LeFou - Bumbler'));
    expect(info.names).toEqual(['LeFou']);
    expect(info.familyIndices).toEqual([familyIndex('LeFou')]);
    expect(info.referencesNames).toEqual([familyIndex('Gaston')]);
    expect(info.referencesSubtypes).toEqual([]);
    expect(info.referencesTypes).toEqual(['Character']);
    expect(info.isUniqueName).toBe(false);
  });

  it('extracts Grand Duke → Prince, Princess, King, Queen subtypes', () => {
    const info = cardNameInfo(byFullName('Grand Duke - Advisor to the King'));
    expect(info.referencesSubtypes).toEqual([
      'King',
      'Prince',
      'Princess',
      'Queen',
    ]);
    expect(info.referencesNames).toEqual([]);
    // only plural "characters" in the text — counts as the Character type
    expect(info.referencesTypes).toEqual(['Character']);
  });

  it('extracts Doc → Seven Dwarfs + Princess, without the shadowed Prince', () => {
    const info = cardNameInfo(byFullName('Doc - Taking Notes'));
    expect(info.referencesSubtypes).toEqual(['Princess', 'Seven Dwarfs']);
    expect(info.referencesNames).toEqual([]);
    expect(info.isUniqueName).toBe(false); // "Doc" sits on 4 cards
  });

  it('extracts Starlight Vial type references [Action, Item] from prose', () => {
    const info = cardNameInfo(byFullName('Starlight Vial'));
    expect(info.referencesTypes).toEqual(['Action', 'Item']);
    expect(info.referencesNames).toEqual([]);
    expect(info.referencesSubtypes).toEqual([]);
  });

  it('buckets the unique Action "Wake Up, Alice!"', () => {
    const card = byFullName('Wake Up, Alice!');
    expect(card.type).toBe('Action');
    const info = cardNameInfo(card);
    expect(info.names).toEqual(['Wake Up, Alice!']);
    expect(info.familyIndices).toEqual([-1]);
    expect(info.isUniqueName).toBe(true);
  });
});

describe('greedy longest-match precedence', () => {
  it('fires only the longer family when the short one is inside it', () => {
    // "Ed" and "Edna Mode" are both families; "Ed" is a substring of "Edna Mode".
    const onlyLong = cardNameInfo(
      makeCard({ name: 'Fixture', text: 'Edna Mode' }),
    );
    expect(onlyLong.referencesNames).toEqual([familyIndex('Edna Mode')]);
    expect(familyIndex('Ed')).toBeGreaterThan(0);
    expect(onlyLong.referencesNames).not.toContain(familyIndex('Ed'));
  });

  it('still fires the short name on its own separate occurrence', () => {
    const both = cardNameInfo(
      makeCard({ name: 'Fixture', text: 'Ed teams up with Edna Mode.' }),
    );
    expect(both.referencesNames).toEqual([
      familyIndex('Ed'),
      familyIndex('Edna Mode'),
    ]);
  });

  it('does the same for nested subtypes (Prince inside Princess)', () => {
    const princessOnly = cardNameInfo(
      makeCard({ name: 'Fixture', text: 'Your Princess characters get +1 ¤.' }),
    );
    expect(princessOnly.referencesSubtypes).toEqual(['Princess']);
  });
});

describe('determinism and caching', () => {
  it('returns byte-identical info across two full snapshot passes', () => {
    const first = CARDS.map((card) => JSON.stringify(cardNameInfo(card)));
    const second = CARDS.map((card) => JSON.stringify(cardNameInfo(card)));
    expect(second).toEqual(first);
  });

  it('serves repeated calls for one identity from the cache', () => {
    const card = byFullName('LeFou - Bumbler');
    expect(cardNameInfo(card)).toBe(cardNameInfo(card));
  });

  it('never returns a stale entry when fixtures reuse an id', () => {
    const id = 987_654;
    const a = makeCard({ name: 'Fixture', text: 'Gaston' });
    a.id = id;
    expect(cardNameInfo(a).referencesNames).toEqual([familyIndex('Gaston')]);
    const b = makeCard({ name: 'Fixture', text: 'Merlin' });
    b.id = id;
    expect(cardNameInfo(b).referencesNames).toEqual([familyIndex('Merlin')]);
  });
});

describe('parseCardNames type-gating (user rule: only Characters split)', () => {
  it('does not split non-character names on " & "', () => {
    expect(parseCardNames('Shield & Sword', 'Item')).toEqual([
      'Shield & Sword',
    ]);
    expect(parseCardNames('Wake Up, Alice!', 'Action')).toEqual([
      'Wake Up, Alice!',
    ]);
  });

  it('still splits character multi-name cards', () => {
    expect(parseCardNames('Flotsam & Jetsam', 'Character')).toEqual([
      'Flotsam',
      'Jetsam',
    ]);
    expect(parseCardNames('Fix-It Felix, Jr.', 'Character')).toEqual([
      'Fix-It Felix, Jr.',
    ]);
  });

  it('cardNameInfo keeps non-character composite names whole', () => {
    const cards = [
      { id: 9001, name: 'Shield & Sword', type: 'Item', text: '' },
      { id: 9002, name: 'Flotsam & Jetsam', type: 'Character', text: '' },
    ];
    const item = cardNameInfo(cards[0] as never);
    expect(item.names).toEqual(['Shield & Sword']);
    const duo = cardNameInfo(cards[1] as never);
    expect(duo.names).toEqual(['Flotsam', 'Jetsam']);
  });
});
