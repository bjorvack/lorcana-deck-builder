import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCanonicalRegistry } from '../canonical';
import {
  buildCardMap,
  type CardMap,
  normalizedName,
  ourCatalogKey,
  plainPrintingKey,
  statDriftGroups,
} from './card-map';
import { loadCards } from './cards';
import { ineligibleIdentities, prepareDeck } from './deck-io';
import { type EngineCatalog, loadEngineCatalog } from './engine-cards';
import { firstPlayerFor, playGame, strategyById } from './play';
import { cachePathFor, readCachedRecords } from './run';

const cards = loadCards();
const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
const byId = new Map(cards.map((c) => [c.id, c]));

async function buildMap(): Promise<{
  map: CardMap;
  catalog: EngineCatalog;
}> {
  const catalog = await loadEngineCatalog();
  const map = buildCardMap({
    cards,
    alias,
    canonicalByGroup,
    engineById: catalog.byId,
    engineCommit: catalog.engineCommit,
  });
  return { map, catalog };
}

describe('card mapping', () => {
  it('maps nearly all core identities into the engine catalog', async () => {
    const { map } = await buildMap();
    const { coverage } = map;
    const core = coverage.identities - coverage.ineligible.quest;
    expect(coverage.mapped / core).toBeGreaterThan(0.95);
    // functionality drift inside an identity group would mean printings were
    // wrongly merged; the snapshot must not contain any
    expect(statDriftGroups(cards)).toHaveLength(0);
  }, 60_000);

  it('never maps an identity to a differently-named engine card', async () => {
    const { map, catalog } = await buildMap();
    for (const [identity, entry] of Object.entries(map.byIdentity)) {
      const ours = byId.get(Number(identity))!;
      const engine = catalog.byId[entry.engineId]!;
      const same =
        normalizedName(
          `${engine.name}|${(engine as { version?: string }).version ?? ''}`,
        ) === normalizedName(`${ours.name}|${ours.version ?? ''}`);
      // the only sanctioned exception: EU-localized names upstream ships as
      // their own card defs (Vaiana = Moana)
      expect(
        same ||
          /Vaiana → Moana|Moana → Vaiana/.test(`${ours.name} → ${engine.name}`),
      ).toBe(true);
    }
  }, 60_000);

  it('resolves the set7-026 collision by name, not collector number', async () => {
    const { map, catalog } = await buildMap();
    // our snapshot numbers Moana, Vaiana AND Calhoun "set7/26"; the engine's
    // set7-026 is Calhoun — Moana/Vaiana must not inherit his card
    const moana = cards.find(
      (c) => c.fullName === 'Moana - Adventurer of Land and Sea',
    )!;
    const calhoun = cards.find(
      (c) => c.fullName === 'Calhoun - Courageous Rescuer',
    )!;
    const moanaEntry = map.byIdentity[String(alias.get(moana.id))]!;
    const calhounEntry = map.byIdentity[String(alias.get(calhoun.id))]!;
    expect(moanaEntry.engineId).not.toBe(calhounEntry.engineId);
    expect((catalog.byId[moanaEntry.engineId] as { name: string }).name).toBe(
      'Moana',
    );
    expect((catalog.byId[calhounEntry.engineId] as { name: string }).name).toBe(
      'Calhoun',
    );
    expect(moanaEntry.via).toBe('name');
  }, 60_000);

  it('maps EU-localized Vaiana to its own engine card', async () => {
    const { map, catalog } = await buildMap();
    const vaiana = cards.find(
      (c) => c.fullName === 'Vaiana - Adventurer of Land and Sea',
    )!;
    const entry = map.byIdentity[String(alias.get(vaiana.id))]!;
    expect((catalog.byId[entry.engineId] as { name: string }).name).toBe(
      'Vaiana',
    );
  }, 60_000);

  it('maps engine-gap cards once the vendor carries them (Dalmatian Puppy)', async () => {
    const { map } = await buildMap();
    const dalmatian = cards.find(
      (c) => c.fullName === 'Dalmatian Puppy - Tail Wagger',
    )!;
    const entry = map.byIdentity[String(alias.get(dalmatian.id))]!;
    expect(entry.engineId).toBe('kvV');
    expect(entry.engineKey).toBe('set8-038');
  }, 60_000);

  it('matches stylized spellings across punctuation (Has Set My Heaaaaaaart…)', async () => {
    const { map } = await buildMap();
    const song = cards.find((c) => c.fullName.includes('Heaaaaaaart'))!;
    const entry = map.byIdentity[String(alias.get(song.id))]!;
    expect(entry.via).toBe('key');
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

  it('normalizes typography and punctuation in names', () => {
    expect(normalizedName('Ursula’s Cauldron')).toBe(
      normalizedName("Ursula's Cauldron"),
    );
    expect(normalizedName('Has Set My Heaaaaaaart . . .')).toBe(
      normalizedName('Has Set My Heaaaaaaart...'),
    );
  });
});

describe('deck eligibility', () => {
  it('flags quest cards as ineligible', async () => {
    const { map } = await buildMap();
    const quest = cards.find((c) => c.setType === 'quest')!;
    const deck = {
      cards: { [String(alias.get(quest.id))]: 3 },
      inks: quest.inks,
      title: 't',
    };
    const missing = ineligibleIdentities(deck, map, cards);
    expect(missing[0]!.reason).toBe('quest');
    expect(missing[0]!.name).toBe(quest.fullName);
  }, 60_000);
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
    const { map, catalog } = await buildMap();
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
    expect(first.firstPlayer).toMatch(/^p[12]$/);
    expect(first.turns).toBeGreaterThan(0);
    expect(first.incomplete).toBe(false);
    // lore only accumulates
    for (let i = 1; i < first.loreTimeline.length; i++) {
      expect(first.loreTimeline[i]!.turn).toBeGreaterThan(
        first.loreTimeline[i - 1]!.turn,
      );
    }
  }, 120_000);

  it('balances the first player across a seed range', () => {
    // the seed decides the seat: a fixed seed must keep its seat (and its
    // game), and a seed range must not give one deck the first move always
    expect(firstPlayerFor('same-seed')).toBe(firstPlayerFor('same-seed'));
    const seats = new Set<string>();
    for (let i = 0; i < 50; i++) seats.add(firstPlayerFor(`bulk-${i}`));
    expect(seats.size).toBe(2);
  });

  it('plays differently for different seeds', async () => {
    const { map, catalog } = await buildMap();
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

  it('records the seed base and pairs different decks on one stream', async () => {
    const { map, catalog } = await buildMap();
    const base = {
      catalog,
      cardMap: map,
      strategyA: 'deck-aware-lore-race',
      strategyB: 'best-deck-aware-lore-race',
    };
    const candidate = playGame({
      ...base,
      deckA: deckA.cards,
      deckB: deckB.cards,
      seed: '77-0',
      seedBase: 77,
    });
    // the explicit seed base is accepted end to end and recorded
    expect(candidate.seedBase).toBe(77);
    expect(candidate.seed).toBe('77-0');
    expect(candidate.firstPlayer).toBe(firstPlayerFor('77-0'));
    // identical request → byte-identical record (same first player, same
    // lore timeline): the seed base fixes the whole shuffle stream
    const replay = playGame({
      ...base,
      deckA: deckA.cards,
      deckB: deckB.cards,
      seed: '77-0',
      seedBase: 77,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(candidate));
    expect(replay.loreTimeline).toEqual(candidate.loreTimeline);
    // two different decks on the same seed base — the mirrored assignment a
    // paired schedule uses — share the seat decision and the recorded base;
    // the seeded shuffle stream is the same, applied to each deck's own cards
    const twin = playGame({
      ...base,
      deckA: deckB.cards,
      deckB: deckA.cards,
      seed: '77-0',
      seedBase: 77,
    });
    expect(twin.seedBase).toBe(77);
    expect(twin.firstPlayer).toBe(candidate.firstPlayer);
  }, 120_000);
});

describe('cache keying', () => {
  it('changes path with every cache dimension', () => {
    const base = {
      engineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mapFormat: 2,
      deckA: { '1': 3 },
      deckB: { '2': 3 },
      strategies: ['s1', 's2'] as [string, string],
      seedBase: 1,
      games: 20,
    };
    const path = cachePathFor(base);
    expect(path).toContain('aaaaaaaa');
    expect(path).toContain('s1__s2');
    expect(path).toContain('arena-2-1-20.jsonl');
    expect(
      cachePathFor({
        ...base,
        engineCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).not.toBe(path);
    expect(cachePathFor({ ...base, deckA: { '3': 3 } })).not.toBe(path);
    expect(cachePathFor({ ...base, mapFormat: 3 })).not.toBe(path);
    expect(cachePathFor({ ...base, strategies: ['s2', 's1'] })).not.toBe(path);
    expect(cachePathFor({ ...base, seedBase: 2 })).not.toBe(path);
    expect(cachePathFor({ ...base, games: 21 })).not.toBe(path);
  });

  it('reuses one cache file for identical paired requests', () => {
    const base = {
      engineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mapFormat: 2,
      deckA: { '1': 3 },
      deckB: { '2': 3 },
      strategies: ['s1', 's2'] as [string, string],
      seedBase: 77,
      games: 20,
    };
    // an explicit seed base is accepted end to end: identical requests —
    // e.g. a deck and its mutation against the same opponent — resolve to
    // the same file and reuse its records
    expect(cachePathFor(base)).toBe(cachePathFor({ ...base }));
    expect(cachePathFor(base)).toContain('arena-2-77-20.jsonl');
    // an engine-commit change is a new era: no reuse
    expect(
      cachePathFor({
        ...base,
        engineCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    ).not.toBe(cachePathFor(base));
  });

  it('serves cached records only from complete files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arena-cache-'));
    try {
      const path = join(dir, 'arena-2-77-2.jsonl');
      // missing file: miss
      expect(readCachedRecords(path, 2)).toBeNull();
      writeFileSync(path, '{"seed":"77-0"}\n{"seed":"77-1"}\n');
      const cached = readCachedRecords(path, 2);
      expect(cached?.map((r) => r.seed)).toEqual(['77-0', '77-1']);
      // a short (partial) file is not a hit — callers replay and rewrite it
      expect(readCachedRecords(path, 3)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fixtures', () => {
  it('are legal 60-card decks of mapped identities', () => {
    for (const name of ['deck-a.txt', 'deck-b.txt']) {
      // prepareDeck throws on unmatched names; a successful parse plus these
      // invariants is the whole contract
      const deck = prepareDeck(
        resolve(import.meta.dirname, 'fixtures', name),
        cards,
        alias,
      );
      const total = Object.values(deck.cards).reduce((a, b) => a + b, 0);
      expect(total).toBe(60);
      expect(deck.inks.length).toBe(2);
    }
  });
});
