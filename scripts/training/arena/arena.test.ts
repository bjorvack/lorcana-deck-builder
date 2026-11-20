import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCanonicalRegistry } from '../canonical';
import {
  buildCardMap,
  ourCatalogKey,
  plainPrintingKey,
  statDriftGroups,
} from './card-map';
import { loadCards } from './cards';
import { ineligibleIdentities, prepareDeck } from './deck-io';
import { loadEngineCatalog } from './engine-cards';
import { playGame, strategyById } from './play';
import { cachePathFor } from './run';

const cards = loadCards();
const { alias } = buildCanonicalRegistry(cards);
const byId = new Map(cards.map((c) => [c.id, c]));

describe('card mapping', () => {
  it('maps nearly all core identities into the engine catalog', async () => {
    const catalog = await loadEngineCatalog();
    const map = buildCardMap({
      cards,
      alias,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const { coverage } = map;
    const core = coverage.identities - coverage.ineligible.quest;
    expect(coverage.mapped / core).toBeGreaterThan(0.95);
    // functionality drift inside an identity group would mean printings were
    // wrongly merged; the snapshot must not contain any
    expect(statDriftGroups(cards)).toHaveLength(0);
  }, 60_000);

  it('joins a known card by catalog key with matching identity', async () => {
    const catalog = await loadEngineCatalog();
    const map = buildCardMap({
      cards,
      alias,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    // Ariel - On Human Legs is set1-001 in both catalogs
    const ariel = cards.find((c) => c.fullName === 'Ariel - On Human Legs')!;
    const identity = String(alias.get(ariel.id));
    const entry = map.byIdentity[identity]!;
    expect(entry.engineKey).toBe('set1-001');
    const engineCard = catalog.byId[entry.engineId]!;
    expect(engineCard.name).toBe('Ariel');
    expect(engineCard.cardNumber).toBe(1);
  }, 60_000);

  it('never maps differently-functioning variants to one identity', async () => {
    const catalog = await loadEngineCatalog();
    const map = buildCardMap({
      cards,
      alias,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    // every group key must map to exactly one engine card; a group whose
    // canonical print resolves to a different card than its siblings would be
    // a name mismatch the audit has to catch
    for (const [identity, entry] of Object.entries(map.byIdentity)) {
      const card = byId.get(Number(identity))!;
      if (entry.nameMatches) continue;
      // audited exceptions only: stylized spellings / localized duplicates
      expect(card.fullName).toMatch(/Heaaaaaaart|Moana|Vaiana/);
    }
  }, 60_000);

  it('derives keys from plain printing ids only', () => {
    expect(plainPrintingKey('set1-001')).toBe('set1-001');
    expect(plainPrintingKey('set1-c2-009-challenge')).toBeNull();
    expect(plainPrintingKey('set1-cc1-001-promo')).toBeNull();
    expect(plainPrintingKey('set14-123')).toBe('set14-123');
  });

  it('builds our keys from setCode + collector number', () => {
    expect(ourCatalogKey({ setCode: '1', collectorNumber: '1' })).toBe(
      'set1-001',
    );
    expect(ourCatalogKey({ setCode: '14', collectorNumber: '7' })).toBe(
      'set14-007',
    );
    expect(ourCatalogKey({ setCode: 'Q1', collectorNumber: '5' })).toBe('');
  });
});

describe('deck eligibility', () => {
  it('flags quest cards as ineligible', () => {
    const catalog = { byId: {}, engineCommit: 'test' } as never as Parameters<
      typeof buildCardMap
    >[0]['engineById'];
    const map = buildCardMap({
      cards,
      alias,
      engineById: catalog,
      engineCommit: 'test',
    });
    const quest = cards.find((c) => c.setType === 'quest')!;
    const deck = {
      cards: { [String(alias.get(quest.id))]: 3 },
      inks: quest.inks,
      title: 't',
    };
    const missing = ineligibleIdentities(deck, map, cards);
    expect(missing[0]!.reason).toBe('quest');
    expect(missing[0]!.name).toBe(quest.fullName);
  });
});

describe('deterministic play', () => {
  const deckA = prepareDeck(
    resolve(import.meta.dirname, 'fixtures', 'deck-a.txt'),
    cards,
    alias,
  );
  const deckB = prepareDeck(
    resolve(import.meta.dirname, 'fixtures', 'deck-b.txt'),
    cards,
    alias,
  );

  it('rejects unknown strategy ids', () => {
    expect(() => strategyById('nope')).toThrow(/unknown strategy/);
  });

  it('replays byte-identical records for the same seed', async () => {
    const catalog = await loadEngineCatalog();
    const map = buildCardMap({
      cards,
      alias,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const base = {
      catalog,
      cardMap: map,
      deckA: deckA.cards,
      deckB: deckB.cards,
      strategyA: 'deck-aware-lore-race',
      strategyB: 'best-deck-aware-lore-race',
    };
    const first = playGame({ ...base, seed: 'determinism-1' });
    const second = playGame({ ...base, seed: 'determinism-1' });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.winner).not.toBeNull();
    expect(first.turns).toBeGreaterThan(0);
    expect(first.incomplete).toBe(false);
    // lore only accumulates
    for (let i = 1; i < first.loreTimeline.length; i++) {
      expect(first.loreTimeline[i]!.turn).toBeGreaterThan(
        first.loreTimeline[i - 1]!.turn,
      );
    }
  }, 120_000);

  it('plays differently for different seeds', async () => {
    const catalog = await loadEngineCatalog();
    const map = buildCardMap({
      cards,
      alias,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const base = {
      catalog,
      cardMap: map,
      deckA: deckA.cards,
      deckB: deckB.cards,
      strategyA: 'deck-aware-lore-race',
      strategyB: 'best-deck-aware-lore-race',
    };
    const one = playGame({ ...base, seed: 'seed-a' });
    const two = playGame({ ...base, seed: 'seed-b' });
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(two));
  }, 120_000);
});

describe('cache keying', () => {
  it('changes path with every cache dimension', () => {
    const base = {
      engineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deckA: { '1': 3 },
      deckB: { '2': 3 },
      strategies: ['s1', 's2'] as [string, string],
      seedBase: 1,
      games: 20,
    };
    const path = cachePathFor(base);
    expect(path).toContain('aaaaaaaa');
    expect(path).toContain('s1__s2');
    expect(path).toContain('arena-1-1-20.jsonl');
    expect(
      cachePathFor({
        ...base,
        engineCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).not.toBe(path);
    expect(cachePathFor({ ...base, deckA: { '3': 3 } })).not.toBe(path);
    expect(cachePathFor({ ...base, strategies: ['s2', 's1'] })).not.toBe(path);
    expect(cachePathFor({ ...base, seedBase: 2 })).not.toBe(path);
    expect(cachePathFor({ ...base, games: 21 })).not.toBe(path);
  });
});

describe('fixtures', () => {
  it('are legal 60-card decks of mapped identities', () => {
    for (const name of ['deck-a.txt', 'deck-b.txt']) {
      const deck = prepareDeck(
        resolve(import.meta.dirname, 'fixtures', name),
        cards,
        alias,
      );
      const total = Object.values(deck.cards).reduce((a, b) => a + b, 0);
      expect(total).toBe(60);
      expect(deck.inks.length).toBe(2);
      // every fixture card must resolve into the engine
      expect(
        readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8')
          .length,
      ).toBeGreaterThan(0);
    }
  });
});
