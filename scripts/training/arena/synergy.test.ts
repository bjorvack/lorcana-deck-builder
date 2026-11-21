import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import type { TrainRow } from '../model-types';
import {
  type SynergyCapabilityInput,
  synergyCapability,
} from '../synergy-capability';
import { aggregateMatchup, pairList, pairSeedBase } from './batch';
import { buildPanel, deckSignature } from './panel';
import type { GameRecord } from './play';

/** minimal card list: only the fields the miner/panel touch */
const card = (id: number, name: string): Card =>
  ({
    id,
    name,
    fullName: name,
    groupKey: name.toLowerCase(),
    inks: ['Amber'],
    cost: 1,
    inkwell: true,
    type: 'Character',
    isDualInk: false,
    isSong: false,
    franchise: 'Test',
    setCode: '1',
    setName: 'Test Set',
    setNumber: 0,
    setType: 'expansion',
    rarity: 'Common',
    maxCopies: 25,
    subtypes: [],
    keywords: [],
    tags: [],
    text: '',
    deckRuleEffects: [],
    formats: { core: true, infinity: true },
  }) as unknown as Card;

const questCard = (id: number, name: string): Card =>
  ({
    ...card(id, name),
    formats: { core: false, infinity: true },
  }) as unknown as Card;

const row = (
  eventId: string,
  counts: Record<number, number>,
  winRate: number,
  date = '2026-10-01',
): TrainRow =>
  ({
    source: 'test',
    eventId,
    date,
    vec: new Map(Object.entries(counts).map(([id, c]) => [Number(id), c / 60])),
    counts: new Map(Object.entries(counts).map(([id, c]) => [Number(id), c])),
    winRate,
    topCut: false,
    playerCount: 32,
    standing: null,
  }) as unknown as TrainRow;

/**
 * Planted corpus: cards 1+2 are a strong synergy pair in *winning* decks;
 * cards 3 and 4 are popular fillers that avoid the pair. On the holdout the
 * planted pair keeps appearing in winning decks → the gate must pass and the
 * pair must rank top. In the failure variant the holdout splits the pair →
 * the gate must reject.
 */
function plantedCorpus(): { input: SynergyCapabilityInput; cards: Card[] } {
  const cards = [
    card(1, 'Alpha'),
    card(2, 'Beta'),
    card(3, 'Filler A'),
    card(4, 'Filler B'),
  ];
  const train: TrainRow[] = [];
  const holdout: TrainRow[] = [];
  for (let i = 0; i < 40; i++) {
    train.push(row(`t-syn-${i}`, { 1: 3, 2: 3, 3: 4 }, 0.85));
    train.push(row(`t-filler-${i}`, { 3: 4, 4: 4 }, 0.4));
  }
  for (let i = 0; i < 20; i++) {
    holdout.push(row(`h-syn-${i}`, { 1: 3, 2: 3, 3: 4 }, 0.85));
    holdout.push(row(`h-filler-${i}`, { 3: 4, 4: 4 }, 0.4));
  }
  return { input: { rows: train, holdout, cards }, cards };
}

describe('synergy capability', () => {
  it('discovers the planted pair and passes the temporal gate', () => {
    const { interactions } = synergyCapability(plantedCorpus().input);
    expect(interactions.metrics.passed).toBe(true);
    const partners = interactions.partners.partners['1'] ?? [];
    expect(partners[0]?.[0]).toBe(2);
    expect(interactions.metrics.pairs).toBeGreaterThan(0);
  }, 30_000);

  it('rejects when the signal does not generalize to the holdout', () => {
    const { input, cards } = plantedCorpus();
    // holdout: the pair never appears together — anti-correlated
    const holdout: TrainRow[] = [];
    for (let i = 0; i < 20; i++) {
      holdout.push(row(`h-a-${i}`, { 1: 3, 3: 4 }, 0.85));
      holdout.push(row(`h-b-${i}`, { 2: 3, 4: 4 }, 0.85));
    }
    const { interactions } = synergyCapability({ ...input, holdout, cards });
    expect(interactions.metrics.passed).toBe(false);
    expect(Object.keys(interactions.partners.partners)).toHaveLength(0);
  }, 30_000);

  it('is deterministic for the same corpus and seed', () => {
    const { input } = plantedCorpus();
    const a = synergyCapability(input).interactions;
    const b = synergyCapability(input).interactions;
    expect(JSON.stringify(a.partners)).toBe(JSON.stringify(b.partners));
    expect(JSON.stringify(a.metrics)).toBe(JSON.stringify(b.metrics));
  }, 30_000);

  it('requires unweighted support before calling something synergy', () => {
    const cards = [card(1, 'Alpha'), card(2, 'Beta'), card(3, 'Filler')];
    // the pair co-occurs once with a huge win rate — thin support must keep
    // it out of the partner table
    const rows = [
      row('t-hot', { 1: 3, 2: 3 }, 1),
      ...Array.from({ length: 30 }, (_, i) =>
        row(`t-${i}`, { 1: 3, 3: 4, 2: 1 }, 0.5),
      ),
    ];
    const holdout = Array.from({ length: 10 }, (_, i) =>
      row(`h-${i}`, { 1: 3, 2: 3, 3: 4 }, 0.9),
    );
    const { interactions } = synergyCapability({ rows, holdout, cards });
    const partners = interactions.partners.partners['1'] ?? [];
    expect(partners.some(([id]) => id === 2)).toBe(false);
  }, 30_000);
});

describe('panel building', () => {
  const cards = [
    card(1, 'Alpha'),
    card(2, 'Beta'),
    card(3, 'Filler'),
    questCard(4, 'Quest Only'),
  ];
  // a deck of 20 Alpha + 20 Beta + 20 Filler = 60, legal; the quest card
  // variant is not core legal
  const legalCounts = { 1: 20, 2: 20, 3: 20 };
  const questCounts = { 4: 20, 1: 20, 3: 20 };

  it('keeps legal decks, drops non-core ones, dedupes by signature', () => {
    const rows = [
      row('e1-a', legalCounts, 0.9, '2026-10-01'),
      row('e1-b', legalCounts, 0.5, '2026-10-01'),
      row('e2-a', legalCounts, 0.7, '2026-10-02'),
      row('e2-quest', questCounts, 0.95, '2026-10-02'),
    ];
    const result = buildPanel(rows, cards, { size: 4, eraDays: 365 });
    expect(result.decks).toHaveLength(1);
    expect(result.droppedReasons['not-core-legal']).toBe(1);
    // e1-a, e1-b and e2-a are the same list: two re-entries dedupe away
    expect(result.droppedReasons.duplicate).toBe(2);
    expect(result.decks[0]!.winRate).toBe(0.9);
  });

  it('signatures are content-based, not order-based', () => {
    expect(deckSignature({ 1: 3, 2: 4 })).toBe(deckSignature({ 2: 4, 1: 3 }));
    expect(deckSignature({ 1: 3, 2: 4 })).not.toBe(
      deckSignature({ 1: 4, 2: 3 }),
    );
  });
});

describe('matchup batch aggregation', () => {
  it('counts seats and incomplete games', () => {
    const rec = (winner: string | null, incomplete = false): GameRecord =>
      ({
        seed: 'x',
        winner,
        incomplete,
        turns: 10,
        actions: 10,
        fallbacks: { passTurn: 0, concede: 0 },
        loreTimeline: [],
        engineCommit: 'e',
        firstPlayer: 'p1',
        decks: { p1: {}, p2: {} },
        strategies: { p1: 's', p2: 's' },
      }) as unknown as GameRecord;
    const row = aggregateMatchup('a.txt', 'b.txt', [
      rec('p1'),
      rec('p2'),
      rec('p2'),
      rec(null, true),
    ]);
    expect(row).toEqual({
      a: 'a.txt',
      b: 'b.txt',
      games: 4,
      winsA: 1,
      winsB: 2,
      incomplete: 1,
    });
  });

  it('lists every unordered pair once', () => {
    expect(pairList(4)).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    // per-pair seed bases never overlap
    const bases = pairList(12).map((_, i) => pairSeedBase(1000, i));
    expect(new Set(bases).size).toBe(bases.length);
  });
});
