import { describe, expect, it } from 'vitest';
import { loadPayoffRules } from '../../scripts/normalize';
import type { Card } from '../data/types';
import {
  buildPayoffVocabulary,
  cardSatisfiesName,
  compilePayoffRules,
  extractPayoffs,
  isUnparseableShiftText,
} from './refs';

const rules = compilePayoffRules({
  payoffRules: loadPayoffRules(
    new URL('../../scripts/tag-rules.json', import.meta.url).pathname,
  ),
});

const card = (overrides: Partial<Card> & { text: string }): Card =>
  ({
    id: 1,
    name: 'Test',
    fullName: 'Test',
    subtypes: [],
    keywords: [],
    ...overrides,
  }) as unknown as Card;

const vocab = buildPayoffVocabulary([
  card({
    id: 2,
    name: 'Hiro Hamada',
    fullName: 'Hiro Hamada - Armor Designer',
    text: '',
    keywords: ['Shift'],
  }),
  card({
    id: 3,
    name: 'Sulley & Boo',
    fullName: 'Sulley & Boo - Scare Buddies',
    text: '',
    keywords: ['Combo Shift'],
  }),
  card({
    id: 4,
    name: 'Jetsam',
    fullName: 'Jetsam - Undersea Minion',
    text: '',
    subtypes: ['Villain'],
  }),
  card({
    id: 5,
    name: 'Puppy',
    fullName: 'Puppy Pals',
    text: '',
    subtypes: ['Puppy'],
  }),
  card({
    id: 7,
    name: 'Meilin Lee',
    fullName: 'Meilin Lee - Popular Red Panda',
    text: '',
    subtypes: ['Red Panda'],
  }),
  card({
    id: 6,
    name: 'Grant Giver',
    fullName: 'Grant Giver - Wise',
    text: '',
    keywords: ['Ward', 'Evasive', 'Rush', 'Resist'],
  }),
]);

describe('shift payoff extraction', () => {
  it('extracts a named shift with cost, ink mode and reminder target (rule 8.10.8.1)', () => {
    const c = card({
      keywords: ['Shift'],
      text: 'Shift 5 (You may pay 5 ⬡ to play this on top of one of your characters named Hiro Hamada.)',
    });
    expect(extractPayoffs(c, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'ink', amount: 5 },
        names: ['Hiro Hamada'],
      },
    ]);
  });

  it('parses parenthetical-free reprints to the card’s own base name', () => {
    const c = card({
      name: 'Belle',
      fullName: 'Belle - Accomplished Mystic',
      keywords: ['Shift'],
      text: 'Shift 3 ⬡ ENHANCED HEALING When you play this character, move damage.',
    });
    expect(extractPayoffs(c, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'ink', amount: 3 },
        names: ['Belle'],
      },
    ]);
  });

  it('extracts classification, universal, potato and duo variants', () => {
    const puppy = card({
      keywords: ['Puppy Shift'],
      text: 'Puppy Shift 3 (You may pay 3 ⬡ to play this on top of one of your Puppy characters.)',
    });
    expect(extractPayoffs(puppy, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'classification',
        classification: 'Puppy',
        cost: { mode: 'ink', amount: 3 },
      },
    ]);
    const universal = card({
      keywords: ['Universal Shift'],
      text: 'Universal Shift 4 (You may pay 4 ⬡ to play this on top of any one of your characters.)',
    });
    expect(extractPayoffs(universal, rules, vocab)).toEqual([
      { kind: 'shift', variant: 'universal', cost: { mode: 'ink', amount: 4 } },
    ]);
    const potato = card({
      keywords: ['Potato Shift'],
      text: 'Potato Shift 5 ⬡ (You may pay 5 ⬡ to play this on top of one of your items named Potato.)',
    });
    expect(extractPayoffs(potato, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'potato',
        cost: { mode: 'ink', amount: 5 },
        names: ['Potato'],
      },
    ]);
    const duo = card({
      name: 'Mickey Mouse & Minnie Mouse',
      fullName: 'Mickey Mouse & Minnie Mouse - Adventuring Duo',
      keywords: ['Duo Shift'],
      text: 'Duo Shift 0 ⬡ (You may pay 0 ⬡ to play this on top of two of your characters, one named Mickey Mouse and one named Minnie Mouse.)',
    });
    expect(extractPayoffs(duo, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'duo',
        cost: { mode: 'ink', amount: 0 },
        names: ['Mickey Mouse', 'Minnie Mouse'],
      },
    ]);
  });

  it('extracts combo shift with either-or multiplicity semantics', () => {
    const combo = card({
      name: 'Sulley & Boo',
      fullName: 'Sulley & Boo - Scare Buddies',
      keywords: ['Combo Shift'],
      text: 'Combo Shift 4 ⬡ (You may pay 4 ⬡ to play this on top of one of your characters named Sulley, one named Boo, or one of each.)',
    });
    expect(extractPayoffs(combo, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'combo',
        cost: { mode: 'ink', amount: 4 },
        names: ['Sulley', 'Boo'],
      },
    ]);
  });

  it('records the temporary flag for the Temporary Shift family', () => {
    const temp = card({
      keywords: ['Temporary Shift'],
      text: 'Temporary Shift 4 ⬡ (You may pay 4 ⬡ to play this on top of one of your characters named Grandma Wu. At the end of your turn, return only this card to your hand.)',
    });
    expect(extractPayoffs(temp, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'ink', amount: 4 },
        names: ['Grandma Wu'],
        temporary: true,
      },
    ]);
    // combined variants: Temporary <classification> Shift
    const tempClass = card({
      name: 'Meilin Lee',
      fullName: 'Meilin Lee - Popular Red Panda',
      keywords: ['Temporary Red Panda Shift'],
      text: 'Temporary Red Panda Shift 3 ⬡ (You may pay 3 ⬡ to play this on top of one of your Red Panda characters.)',
    });
    expect(extractPayoffs(tempClass, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'classification',
        classification: 'Red Panda',
        cost: { mode: 'ink', amount: 3 },
        temporary: true,
      },
    ]);
  });

  it('extracts discard and ink-drop cost modes', () => {
    const discard = card({
      keywords: ['Shift'],
      text: 'Shift: Discard 2 cards (You may discard 2 cards to play this on top of one of your characters named Flotsam or Jetsam.)',
    });
    expect(extractPayoffs(discard, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'discard', amount: 2 },
        names: ['Flotsam', 'Jetsam'],
      },
    ]);
    const typed = card({
      keywords: ['Shift'],
      text: 'Shift: Discard a song card (You may discard a song card to play this on top of one of your characters named Ursula.)',
    });
    expect(extractPayoffs(typed, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'discard', amount: 1, cardType: 'song' },
        names: ['Ursula'],
      },
    ]);
    const inkDrops = card({
      keywords: ['Shift'],
      text: 'Shift Remove 2 ink drops (You may remove 2 ink drops to play this on top of one of your characters named Baymax.)',
    });
    expect(extractPayoffs(inkDrops, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'inkDrops', amount: 2 },
        names: ['Baymax'],
      },
    ]);
  });

  it('extracts MIMICRY and ADVANCED MIMICRY wildcards', () => {
    const mimicry = card({
      text: 'MIMICRY You may play any character with Shift on this character as if this character had any name.',
    });
    expect(extractPayoffs(mimicry, rules, vocab)).toEqual([
      { kind: 'mimicry', advanced: false },
    ]);
    const advanced = card({
      text: 'ADVANCED MIMICRY You can shift any character on top of this character. (This includes all Shift variants.)',
    });
    expect(extractPayoffs(advanced, rules, vocab)).toEqual([
      { kind: 'mimicry', advanced: true },
    ]);
  });
});

describe('effect-text payoff extraction', () => {
  it('extracts mutual named references and keyword grants, not shift reminder targets', () => {
    const flotsam = card({
      name: 'Flotsam',
      fullName: 'Flotsam - Ursula’s Spy',
      text: 'Your characters named Jetsam gain Rush. Whenever this character quests, your Villain characters gain Resist.',
    });
    expect(extractPayoffs(flotsam, rules, vocab)).toEqual([
      { kind: 'named', name: 'Jetsam' },
      { kind: 'classification', classification: 'Villain' },
      { kind: 'keywordGrant', keyword: 'Rush' },
      { kind: 'keywordGrant', keyword: 'Resist' },
    ]);
  });

  it('drops named references to unknown names', () => {
    const noise = card({
      text: 'If you have a character named Not A Card in play, gain 1 lore.',
    });
    expect(extractPayoffs(noise, rules, vocab)).toEqual([]);
  });

  it('extracts sing payoffs with the minimum cost, marking Sing Together (rule 8.12)', () => {
    const song = card({
      text: '(A character with cost 2 or more can ⟳ to sing this song for free.) Draw a card.',
    });
    expect(extractPayoffs(song, rules, vocab)).toEqual([
      { kind: 'sing', minCost: 2 },
    ]);
    const together = card({
      text: "(Any number of your or your teammates' characters with total cost 9 or more may ⟳ to sing this song for free.)",
    });
    expect(extractPayoffs(together, rules, vocab)).toEqual([
      { kind: 'sing', minCost: 9, together: true },
    ]);
  });
});

describe('needsReview flagging', () => {
  it('flags shift-like text without a parseable payoff', () => {
    // a future set's variant the patterns do not know: no typed payoff may be
    // emitted — the card must land in needsReview instead
    const future = card({
      keywords: ['Quantum Shift'],
      text: 'Quantum Shift 3 ⬡ (You may pay 3 ⬡ to play this on top of one of your characters in a parallel universe.)',
    });
    const payoffs = extractPayoffs(future, rules, vocab);
    expect(payoffs).toEqual([]);
    expect(isUnparseableShiftText({ ...future, payoffs })).toBe(true);
    // a nonstandard reminder on a standard keyword still parses (the
    // parenthetical is optional reminder text, rule 8.10.8.1)
    const oddReminder = card({
      keywords: ['Shift'],
      text: 'Shift 3 (You may pay 3 ⬡ to play this on top of a card you do not control.)',
    });
    expect(extractPayoffs(oddReminder, rules, vocab)).toEqual([
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'ink', amount: 3 },
        names: ['Test'],
      },
    ]);
  });

  it('does not flag trigger texts that merely mention Shift', () => {
    const trigger = card({
      text: 'SQUEAK Whenever you play a Floodborn character, if you used Shift to play them, each opponent discards a card.',
    });
    expect(isUnparseableShiftText({ ...trigger, payoffs: [] })).toBe(false);
  });

  it('does not flag cards whose payoffs parsed', () => {
    const hiro = card({
      keywords: ['Shift'],
      text: 'Shift 5 (You may pay 5 ⬡ to play this on top of one of your characters named Hiro Hamada.)',
    });
    expect(
      isUnparseableShiftText({
        ...hiro,
        payoffs: extractPayoffs(hiro, rules, vocab),
      }),
    ).toBe(false);
  });
});

describe('dual-name target resolution (rule 5.2.6.1)', () => {
  const sulleyBoo = card({
    name: 'Sulley & Boo',
    fullName: 'Sulley & Boo - Scare Buddies',
    text: '',
  });
  const sulley = card({
    name: 'Sulley',
    fullName: 'Sulley - Gentle Giant',
    text: '',
  });

  it('a dual-named character satisfies each component name', () => {
    expect(cardSatisfiesName(sulleyBoo, 'Sulley')).toBe(true);
    expect(cardSatisfiesName(sulleyBoo, 'Boo')).toBe(true);
  });

  it('a compound target matches only the compound card, not the component card', () => {
    expect(cardSatisfiesName(sulleyBoo, 'Sulley & Boo')).toBe(true);
    expect(cardSatisfiesName(sulley, 'Sulley & Boo')).toBe(false);
  });

  it('full names and unrelated names do not match', () => {
    expect(cardSatisfiesName(sulleyBoo, 'Sulley & Boo - Scare Buddies')).toBe(
      true,
    );
    expect(cardSatisfiesName(sulleyBoo, 'Randall')).toBe(false);
  });
});
