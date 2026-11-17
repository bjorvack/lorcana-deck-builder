import type { Card, CardType, DeckRuleEffect, Ink } from '../data/types';

let nextId = 1;

export interface FixtureCardOverrides {
  id?: number;
  name?: string;
  version?: string;
  inks?: Ink[];
  cost?: number;
  inkwell?: boolean;
  type?: CardType;
  subtypes?: string[];
  franchise?: string;
  rarity?: string;
  maxCopies?: number | 'unlimited';
  strength?: number;
  willpower?: number;
  lore?: number;
  text?: string;
  keywords?: string[];
  setCode?: string;
  setName?: string;
  setType?: 'expansion' | 'quest';
  formats?: { core?: boolean; infinity?: boolean };
  tags?: { tag: string; by: 'rule' | 'manual' }[];
  deckRuleEffects?: DeckRuleEffect[];
}

export function makeCard(overrides: FixtureCardOverrides = {}): Card {
  const id = overrides.id ?? nextId++;
  const name = overrides.name ?? 'Test Card';
  const version = overrides.version;
  const fullName = version ? `${name} - ${version}` : name;
  const inks = overrides.inks ?? ['Amber'];
  return {
    id,
    name,
    version,
    fullName,
    groupKey: fullName.toLowerCase(),
    inks,
    isDualInk: inks.length === 2,
    cost: overrides.cost ?? 3,
    inkwell: overrides.inkwell ?? (overrides.type ?? 'Character') !== 'Action',
    type: overrides.type ?? 'Character',
    subtypes: overrides.subtypes ?? [],
    isSong: (overrides.subtypes ?? []).includes('Song'),
    franchise: overrides.franchise ?? 'Test Story',
    setCode: overrides.setCode ?? '1',
    setName: overrides.setName ?? 'The First Chapter',
    setNumber: 1,
    setType: overrides.setType ?? 'expansion',
    rarity: overrides.rarity ?? 'Common',
    maxCopies: overrides.maxCopies ?? 4,
    strength: overrides.strength ?? 2,
    willpower: overrides.willpower ?? 3,
    lore: overrides.lore ?? 1,
    text: overrides.text ?? '',
    keywords: overrides.keywords ?? [],
    tags: overrides.tags ?? [],
    deckRuleEffects: overrides.deckRuleEffects ?? [],
    images: { thumb: `https://example.com/${id}.png` },
    formats: { core: true, infinity: true, ...overrides.formats },
  };
}

export const HUNNY_SAGE_EFFECT: DeckRuleEffect = {
  kind: 'inkExemption',
  sourceCardId: 3032,
  targetTypes: ['Character'],
  targetSubtypes: ['Hunny'],
  exceptSelf: true,
  note: 'GATHER THE PARTY',
};

export function byIdMap(cards: Card[]): Map<number, Card> {
  return new Map(cards.map((c) => [c.id, c]));
}

/** build a fill pool: nInkable inkable + nNot uninkable cards spread over the given inks */
export function fillPool(inks: Ink[], nInkable: number, nNot: number, startId = 1000): Card[] {
  const cards: Card[] = [];
  for (let i = 0; i < nInkable; i++) {
    cards.push(makeCard({ id: startId + i, name: `Inkable ${startId}-${i}`, inks: [inks[i % inks.length]!], cost: (i % 6) + 1, inkwell: true }));
  }
  const nonInkableTypes = ['Action', 'Action', 'Location'] as const;
  for (let i = 0; i < nNot; i++) {
    cards.push(makeCard({ id: startId + 500 + i, name: `Sparkly ${startId}-${i}`, inks: [inks[i % inks.length]!], cost: (i % 6) + 1, inkwell: false, type: nonInkableTypes[i % nonInkableTypes.length] }));
  }
  return cards;
}
