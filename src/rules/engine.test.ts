import { describe, expect, it } from 'vitest';
import { MIN_DECK_SIZE, canAddCard, validateDeck } from './engine';
import { HUNNY_SAGE_EFFECT, byIdMap, fillPool, makeCard } from '../test/fixtures';
import type { Card, DeckState } from '../data/types';

const AMBER: Card[] = fillPool(['Amber'], 30, 10, 100);
const RUBY: Card[] = fillPool(['Ruby'], 30, 10, 200);
// rule-scenario cards must be part of the catalog or the engine drops them as unknown ids
const specials: Card[] = [
  makeCard({ id: 500, name: 'Puppy', maxCopies: 99 }),
  makeCard({ id: 501, name: 'Bots', maxCopies: 'unlimited' }),
  makeCard({ id: 600, name: 'Belle', version: 'Mechanic', rarity: 'Rare' }),
  makeCard({ id: 601, name: 'Belle', version: 'Mechanic', rarity: 'Special' }),
  makeCard({ id: 700, inks: ['Amber', 'Ruby'] }),
  makeCard({ id: 800, setCode: 'Q1', setType: 'quest', formats: { core: false, infinity: true } }),
  makeCard({ id: 900, formats: { core: false, infinity: false } }),
  makeCard({ id: 901, formats: { core: false, infinity: true } }),
  makeCard({ id: 3032, name: 'Christopher Robin', version: 'Hunny Sage', inks: ['Amethyst', 'Sapphire'], deckRuleEffects: [HUNNY_SAGE_EFFECT] }),
  makeCard({ id: 3100, name: 'Pooh', version: 'Hunny Bank', inks: ['Emerald'], subtypes: ['Dreamborn', 'Hero', 'Hunny'] }),
  makeCard({ id: 3101, name: 'Hunny Jar', type: 'Item', subtypes: ['Hunny'], inkwell: false, inks: ['Emerald'] }),
];
const catalog = [...AMBER, ...RUBY, ...specials];

function deck(partial: Partial<DeckState> & { cards: Record<number, number> }): DeckState {
  return { title: 'T', inks: ['Amber'], format: 'core', ...partial };
}

const violationsFor = (d: DeckState): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const v of validateDeck(d, byIdMap(catalog))) {
    map.set(v.rule, [...(map.get(v.rule) ?? []), v.message]);
  }
  return map;
};

describe('deck rules', () => {
  it('fails below 60 cards naming the count', () => {
    const cards = Object.fromEntries(AMBER.slice(0, 20).map((c) => [c.id, 3])); // 59? 20*3=60 minus last... build exactly 59
    cards[AMBER[0]!.id] = 2;
    const v = violationsFor(deck({ cards }));
    expect(v.get('card-count')?.[0]).toContain('59/60');
  });

  it('passes a legal 60-card deck', () => {
    const cards = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    expect(violationsFor(deck({ cards })).size).toBe(0);
  });

  it('fails 5 copies of a default-limit card', () => {
    const card = AMBER[0]!;
    const cards: Record<number, number> = { [card.id]: 5 };
    for (let i = 1; i < 12; i++) cards[AMBER[i]!.id] = 5;
    // 12 cards * 5 = 60 total
    const v = violationsFor(deck({ cards }));
    expect(v.get('copy-limit')?.[0]).toContain('5 copies of Inkable 100-0');
    expect(v.get('copy-limit')?.[0]).toContain('limit 4');
  });

  it('honors 99-copy and unlimited exceptions', () => {
    const d99 = catalog.find((c) => c.id === 500)!;
    const unlim = catalog.find((c) => c.id === 501)!;
    const filler = Object.fromEntries(AMBER.slice(0, 10).map((c) => [c.id, 4])); // 40
    const d = deck({ cards: { ...filler, [d99.id]: 15, [unlim.id]: 10 } });
    expect(violationsFor(d).get('copy-limit')).toBeUndefined();
  });

  it('groups copies across prints of the same full name', () => {
    const normal = catalog.find((c) => c.id === 600)!;
    const special = catalog.find((c) => c.id === 601)!;
    const filler = Object.fromEntries(AMBER.slice(0, 12).map((c) => [c.id, 5])); // 60
    const d = deck({ cards: { ...filler, [normal.id]: 2, [special.id]: 3 } });
    expect(violationsFor(d).get('copy-limit')?.some((m) => m.includes('5 copies of Belle - Mechanic'))).toBe(true);
  });

  it('accepts a dual-ink card when both inks are declared', () => {
    const dual = makeCard({ id: 700, inks: ['Amber', 'Ruby'] });
    const filler = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    const d = deck({ inks: ['Amber', 'Ruby'], cards: { ...filler, [dual.id]: 1 } });
    expect(violationsFor(d).get('dual-ink')).toBeUndefined();
  });

  it('rejects a dual-ink card when only one ink is declared', () => {
    const dual = makeCard({ id: 700, inks: ['Amber', 'Ruby'] });
    const filler = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    const d = deck({ inks: ['Amber', 'Steel'], cards: { ...filler, [dual.id]: 1 } });
    expect(violationsFor(d).get('dual-ink')?.[0]).toContain('both inks');
  });

  it('rejects Quest-set cards in Core but allows them in Infinity', () => {
    const quest = makeCard({ id: 800, setCode: 'Q1', setType: 'quest', formats: { core: false, infinity: true } });
    const filler = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    const coreDeck = deck({ cards: { ...filler, [quest.id]: 1 } });
    expect(violationsFor(coreDeck).get('format')?.[0]).toContain('Quest set');
    const infinityDeck = deck({ format: 'infinity', cards: { ...filler, [quest.id]: 1 } });
    expect(violationsFor(infinityDeck).get('format')).toBeUndefined();
  });

  it('rejects banned and rotated cards per format', () => {
    const banned = makeCard({ id: 900, formats: { core: false, infinity: false } });
    const rotated = makeCard({ id: 901, formats: { core: false, infinity: true } });
    const filler = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    const d = deck({ format: 'infinity', cards: { ...filler, [banned.id]: 1, [rotated.id]: 1 } });
    expect(violationsFor(d).get('format')?.[0]).toContain('banned in Infinity');
    const dCore = deck({ cards: { ...filler, [rotated.id]: 1 } });
    expect(violationsFor(dCore).get('format')?.[0]).toContain('not legal in Core');
  });

  it('reports off-ink cards', () => {
    const ruby = RUBY[0]!;
    const filler = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    const d = deck({ cards: { ...filler, [ruby.id]: 1 } });
    expect(violationsFor(d).get('off-ink')?.[0]).toContain('outside the declared inks');
  });

  it('lists multiple violations together', () => {
    const d = deck({ cards: { [AMBER[0]!.id]: 5, [RUBY[0]!.id]: 2 } });
    const v = violationsFor(d);
    expect(v.has('card-count')).toBe(true);
    expect(v.has('copy-limit')).toBe(true);
    expect(v.has('off-ink')).toBe(true);
  });

  it('honors the Hunny ink exemption from Christopher Robin - Hunny Sage', () => {
    const sage = makeCard({ id: 3032, name: 'Christopher Robin', version: 'Hunny Sage', inks: ['Amethyst', 'Sapphire'], deckRuleEffects: [HUNNY_SAGE_EFFECT] });
    const hunny = makeCard({ id: 3100, name: 'Pooh', version: 'Hunny Bank', inks: ['Emerald'], subtypes: ['Dreamborn', 'Hero', 'Hunny'] });
    const hunnyItem = makeCard({ id: 3101, name: 'Hunny Jar', type: 'Item', subtypes: ['Hunny'], inkwell: false });
    const filler = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));

    const withSage = deck({ inks: ['Amber', 'Sapphire'], cards: { ...filler, [sage.id]: 1, [hunny.id]: 2 } });
    expect(violationsFor(withSage).get('off-ink')).toBeUndefined();

    const withoutSage = deck({ inks: ['Amber', 'Sapphire'], cards: { ...filler, [hunny.id]: 2 } });
    expect(violationsFor(withoutSage).get('off-ink')?.[0]).toContain('Pooh');

    const itemNotExempt = deck({ inks: ['Amber', 'Sapphire'], cards: { ...filler, [sage.id]: 1, [hunnyItem.id]: 1 } });
    expect(violationsFor(itemNotExempt).get('off-ink')?.[0]).toContain('Hunny Jar');

    const sageNeedsBothInks = deck({ inks: ['Amber', 'Ruby'], cards: { ...filler, [sage.id]: 1 } });
    expect(violationsFor(sageNeedsBothInks).get('dual-ink')?.[0]).toContain('Christopher Robin');
  });

  it('has no card-count violation at 60 cards', () => {
    const cards = Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4]));
    const d = deck({ cards });
    expect(validateDeck(d, byIdMap(catalog)).filter((v) => v.rule === 'card-count')).toHaveLength(0);
    expect(MIN_DECK_SIZE).toBe(60);
  });

  describe('canAddCard', () => {
    const byId = byIdMap(catalog);
    const legal = deck({ cards: Object.fromEntries(AMBER.slice(0, 15).map((c) => [c.id, 4])) });

    it('accepts a legal card', () => {
      expect(canAddCard(legal, AMBER[20]!, byId)).toEqual({ ok: true }); // inkable, not yet in the deck
    });

    it('rejects cards at their copy limit, including across prints', () => {
      const four = deck({ cards: { [AMBER[0]!.id]: 4 } });
      expect(canAddCard(four, AMBER[0]!, byId).ok).toBe(false);
      const crossPrint = makeCard({ id: 610, name: 'Belle', version: 'Mechanic' });
      const mixed = deck({ cards: { 600: 2, 601: 2 } });
      expect(canAddCard(mixed, crossPrint, byId).ok).toBe(false);
    });

    it('rejects off-ink and dual-ink mismatches', () => {
      expect(canAddCard(legal, RUBY[0]!, byId).ok).toBe(false);
      expect(canAddCard(legal, catalog.find((c) => c.id === 700)!, byId).ok).toBe(false); // Amber/Ruby dual, only Amber declared
    });

    it('rejects format-illegal cards', () => {
      expect(canAddCard(legal, catalog.find((c) => c.id === 800)!, byId).ok).toBe(false); // quest, core deck
    });

    it('honors the Hunny exemption when Christopher Robin is present', () => {
      const pooh = catalog.find((c) => c.id === 3100)!;
      expect(canAddCard(legal, pooh, byId).ok).toBe(false);
      const withSage = deck({ cards: { [3032]: 1 } });
      expect(canAddCard(withSage, pooh, byId).ok).toBe(true);
    });

    it('rejects when no inks are declared', () => {
      expect(canAddCard(deck({ inks: [], cards: {} }), AMBER[0]!, byId).ok).toBe(false);
    });
  });
});
