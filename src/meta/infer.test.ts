import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import {
  BASIS_FUSED,
  BASIS_TEXT,
  buildTextFeatureVocab,
  type CardSuggestion,
  cardTextVector,
  deckTextVector,
  identifyArchetype,
  isStale,
  loadMetaModel,
  type MetaModel,
  parseMetaModel,
  relationVectors,
  SUGGESTION_LIMIT,
  snapshotDate,
  suggestCards,
} from './infer';
import { buildScoringContext, candidateComponents, deckVectors } from './score';

const model: MetaModel = {
  version: '2-fixture',
  dataThroughDate: '2026-11-10',
  capabilities: { relations: false, calibration: true },
  archetypes: [
    {
      id: 1,
      name: 'Steel Song',
      observedWinRate: 0.54,
      sampleSize: 120,
      centroid: { '1': 0.12, '2': 0.1 },
    },
    {
      id: 2,
      name: 'Ramp Leviathan',
      observedWinRate: 0.44,
      sampleSize: 80,
      centroid: { '9': 0.1 },
    },
  ],
  cardWeights: {},
};

/** little-endian Int16 + scale encoder matching the artifact format */
function embed(
  dim: number,
  raw: Record<number, number[]>,
): MetaModel['relations'] {
  const vectors: Record<string, { b64: string; scale: number }> = {};
  for (const [id, vec] of Object.entries(raw)) {
    const maxAbs = Math.max(...vec.map((v) => Math.abs(v)));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = Buffer.alloc(dim * 2);
    vec.forEach((v, d) => {
      buf.writeInt16LE(Math.round(v / scale), d * 2);
    });
    vectors[id] = { b64: buf.toString('base64'), scale };
  }
  return { dim, quantization: 'int16-le', vectors };
}

const byId = byIdMap([
  makeCard({ id: 1, name: 'Card One', cost: 3 }),
  makeCard({ id: 2, name: 'Card Two', cost: 4 }),
]);
const deck = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 30, 2: 30 },
} as const;

describe('meta inference', () => {
  it('matches the closest archetype by centroid similarity', () => {
    const m = identifyArchetype(deck as never, byId, model)!;
    expect(m.archetype.name).toBe('Steel Song');
    expect(m.similarity).toBeGreaterThan(0.9);
  });

  it('canonicalizes the deck vector to the newest print of a group', () => {
    const oldPrint = makeCard({ id: 1, name: 'Beast', version: 'Original' });
    const newPrint = {
      ...makeCard({ id: 77, name: 'Beast', version: 'Original' }),
      releasedAt: '2026-01-01',
    };
    const cards = [
      oldPrint,
      newPrint,
      makeCard({ id: 2, name: 'Card Two', cost: 4 }),
    ];
    const deck2 = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 1: 60 },
    } as const; // old print id
    const m: MetaModel = {
      ...model,
      archetypes: [
        {
          id: 1,
          name: 'Beast Deck',
          observedWinRate: 0.6,
          sampleSize: 10,
          centroid: { '77': 1 },
        },
      ],
    };
    const match = identifyArchetype(deck2 as never, byIdMap(cards), m, cards)!;
    expect(match.similarity).toBeCloseTo(1);
  });

  it('flags a model stale when its data predates the card snapshot', () => {
    expect(snapshotDate('2026-11-17T12:23:26.078Z')).toBe('2026-11-17');
    expect(isStale(model, '2026-11-17T00:00:00Z')).toBe(true);
    expect(isStale(model, '2026-11-10T00:00:00Z')).toBe(false);
    expect(
      isStale(
        { ...model, dataThroughDate: '2026-11-17' },
        '2026-11-17T00:00:00Z',
      ),
    ).toBe(false);
  });
});

describe('artifact loading (per-capability handling)', () => {
  const relations = embed(2, { 1: [1, 0], 2: [0.9, 0.1], 3: [0, 1] });
  const full = {
    version: '2',
    dataThroughDate: '2026-11-10',
    cardSchemaVersion: 1,
    capabilities: { relations: true, calibration: true },
    archetypes: model.archetypes,
    cardWeights: {},
    relations,
  };
  const strip = (
    m: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> => {
    const copy = { ...m };
    delete copy[key];
    return copy;
  };

  it('accepts a full artifact and a stale-but-valid one', () => {
    expect(parseMetaModel(full)).not.toBeNull();
    const stale = { ...full, dataThroughDate: '2026-01-01' };
    const parsed = parseMetaModel(stale);
    expect(parsed).not.toBeNull();
    expect(parsed!.dataThroughDate).toBe('2026-01-01');
  });

  it('accepts relations-only and calibration-only artifacts', () => {
    const relationsOnly = {
      ...strip(full as Record<string, unknown>, 'archetypes'),
      cardWeights: undefined,
      capabilities: { relations: true, calibration: false },
    };
    const parsed = parseMetaModel(relationsOnly);
    expect(parsed!.capabilities).toEqual({
      relations: true,
      calibration: false,
      interactions: false,
    });
    expect(parsed!.archetypes).toBeUndefined();
    expect(parsed!.relations).toBeDefined();

    const calibrationOnly = {
      ...strip(full as Record<string, unknown>, 'relations'),
      capabilities: { relations: false, calibration: true },
    };
    const parsed2 = parseMetaModel(calibrationOnly);
    expect(parsed2!.capabilities).toEqual({
      relations: false,
      calibration: true,
      interactions: false,
    });
    expect(parsed2!.relations).toBeUndefined();
    expect(parsed2!.archetypes).toBeDefined();
  });

  it('rejects malformed or capability-less artifacts', () => {
    expect(parseMetaModel(null)).toBeNull();
    expect(parseMetaModel({})).toBeNull();
    expect(
      parseMetaModel({
        ...strip(full as Record<string, unknown>, 'capabilities'),
      }),
    ).toBeNull();
    const neither = {
      ...full,
      capabilities: { relations: false, calibration: false },
    };
    expect(parseMetaModel(neither)).toBeNull();
    expect(parseMetaModel({ ...full, dataThroughDate: 'November' })).toBeNull();
  });

  it('degrades a corrupt capability payload instead of rejecting the artifact', () => {
    // relations payload missing: calibration survives
    const relationsWithoutPayload = { ...full, relations: undefined };
    const parsed = parseMetaModel(relationsWithoutPayload);
    expect(parsed).not.toBeNull();
    expect(parsed!.capabilities).toEqual({
      relations: false,
      calibration: true,
      interactions: false,
    });
    expect(parsed!.archetypes).toBeDefined();
    expect(parsed!.relations).toBeUndefined();

    // archetypes missing: relations survive
    const calibrationWithoutArchetypes = strip(
      full as Record<string, unknown>,
      'archetypes',
    );
    const parsed2 = parseMetaModel(calibrationWithoutArchetypes);
    expect(parsed2).not.toBeNull();
    expect(parsed2!.capabilities).toEqual({
      relations: true,
      calibration: false,
      interactions: false,
    });
    expect(parsed2!.relations).toBeDefined();

    // both payloads unusable: nothing left to ship
    const bothCorrupt = {
      ...strip(full as Record<string, unknown>, 'archetypes'),
      relations: undefined,
    };
    expect(parseMetaModel(bothCorrupt)).toBeNull();
  });
});

describe('interactions capability parsing', () => {
  const payload = {
    version: '1',
    scale: 166.7,
    partners: {
      1971: [
        [119, 185],
        [70, 147],
      ],
      61: [[70, 147]],
    },
  };
  const full = {
    version: '2',
    dataThroughDate: '2026-11-10',
    cardSchemaVersion: 1,
    capabilities: { relations: true, calibration: true },
    archetypes: [],
    cardWeights: {},
    relations: {
      dim: 2,
      quantization: 'int16-le',
      vectors: { 1971: { b64: Buffer.alloc(4).toString('base64'), scale: 1 } },
    },
  };
  // relations stay enabled: a corrupt interactions payload must degrade only
  // itself, never sink the artifact's other capabilities
  const interactionsModel = (interactions: unknown): unknown => ({
    ...full,
    capabilities: { relations: true, calibration: false, interactions: true },
    interactions,
  });

  it('parses a valid partner table', () => {
    const parsed = parseMetaModel(interactionsModel(payload));
    expect(parsed).not.toBeNull();
    expect(parsed!.capabilities.interactions).toBe(true);
    expect(parsed!.interactions!.scale).toBeCloseTo(166.7, 3);
    expect(parsed!.interactions!.partners['1971']).toEqual([
      [119, 185],
      [70, 147],
    ]);
  });

  it('degrades a corrupt table instead of rejecting the artifact', () => {
    for (const corrupt of [
      { version: '2', scale: 1, partners: {} },
      { version: '1', scale: -1, partners: {} },
      { version: '1', scale: 1, partners: { 1: [[5]] } },
      { version: '1', scale: 1, partners: { 1: [[5, 300]] } },
      'not-a-table',
    ]) {
      const parsed = parseMetaModel(interactionsModel(corrupt));
      expect(parsed).not.toBeNull();
      expect(parsed!.capabilities.interactions).toBe(false);
      expect(parsed!.interactions).toBeUndefined();
    }
  });

  it('accepts an interactions-only artifact', () => {
    const parsed = parseMetaModel({
      ...full,
      capabilities: {
        relations: false,
        calibration: false,
        interactions: true,
      },
      interactions: payload,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.capabilities.relations).toBe(false);
    expect(parsed!.capabilities.calibration).toBe(false);
    expect(parsed!.capabilities.interactions).toBe(true);
    expect(parsed!.interactions!.partners['61']).toEqual([[70, 147]]);
  });

  it('parses pre-interactions artifacts unchanged', () => {
    const parsed = parseMetaModel(full);
    expect(parsed!.capabilities.interactions).toBe(false);
    expect(parsed!.interactions).toBeUndefined();
  });
});

describe('relation embedding decoding', () => {
  it('round-trips Int16 LE + scale vectors', () => {
    const m: MetaModel = {
      ...model,
      capabilities: { relations: true, calibration: false },
      relations: embed(3, { 1: [1, -0.5, 0.25], 2: [0.1, 0.2, 0.3] }),
    };
    const vectors = relationVectors(m);
    expect(vectors.size).toBe(2);
    expect(vectors.get(1)![0]).toBeCloseTo(1);
    expect(vectors.get(1)![1]).toBeCloseTo(-0.5);
    expect(vectors.get(1)![2]).toBeCloseTo(0.25);
    // memoized per artifact
    expect(relationVectors(m)).toBe(vectors);
  });

  it('returns an empty space without the relations capability', () => {
    expect(relationVectors(model).size).toBe(0);
  });
});

describe('text-feature vectors', () => {
  it('derive the vocabulary from the card data — new sets extend the space', () => {
    const card = makeCard({
      keywords: ['Evasive', 'Floodborn Shift', 'Contract'], // Contract: hypothetical future keyword
      text: 'banish',
      tags: [{ tag: 'removal', by: 'rule' }],
      subtypes: ['Storyborn', 'Hero', 'Pirate'],
      franchise: 'Mickey and Friends',
    });
    const vocab = buildTextFeatureVocab([card]);
    // shift family collapses; the new keyword is picked up from data alone
    expect(vocab.keywords).toEqual(['Contract', 'Evasive', 'Shift']);
    expect(vocab.classifications).toEqual(['Hero', 'Pirate', 'Storyborn']);
    expect(vocab.franchises).toEqual(['Mickey and Friends']);
    expect(vocab.dim).toBe(
      vocab.keywords.length +
        vocab.tags.length +
        vocab.classifications.length +
        vocab.franchises.length +
        vocab.types.length +
        4 +
        6 +
        3,
    );
  });

  it('have a stable dimension and unit norm', () => {
    const card = makeCard({
      keywords: ['Evasive', 'Floodborn Shift'],
      text: 'banish',
      tags: [{ tag: 'removal', by: 'rule' }],
    });
    const vocab = buildTextFeatureVocab([card]);
    const v = cardTextVector(card, vocab);
    expect(v.length).toBe(vocab.dim);
    const norm = Math.sqrt([...v].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    const evasive = vocab.keywords.indexOf('Evasive');
    const shift = vocab.keywords.indexOf('Shift');
    expect(v[evasive]).toBeGreaterThan(0);
    expect(v[shift]).toBeGreaterThan(0); // shift family collapses to one dimension
    expect(
      v[vocab.keywords.length + vocab.tags.indexOf('removal')],
    ).toBeGreaterThan(0);
  });

  it('light the classification and franchise blocks from card subtypes', () => {
    const pirate = makeCard({
      subtypes: ['Storyborn', 'Hero', 'Pirate'],
      franchise: 'Peter Pan',
    });
    const vocab = buildTextFeatureVocab([pirate]);
    const classificationOffset = vocab.keywords.length + vocab.tags.length;
    const franchiseOffset = classificationOffset + vocab.classifications.length;
    const v = cardTextVector(pirate, vocab);
    expect(
      v[classificationOffset + vocab.classifications.indexOf('Pirate')],
    ).toBeGreaterThan(0);
    expect(
      v[classificationOffset + vocab.classifications.indexOf('Storyborn')],
    ).toBeGreaterThan(0);
    expect(
      v[franchiseOffset + vocab.franchises.indexOf('Peter Pan')],
    ).toBeGreaterThan(0);
    // rare subtypes are features too — the vocabulary is whatever the data has
    const rare = makeCard({
      subtypes: ['Idle Breezer'],
      strength: 1,
      willpower: 1,
      lore: 1,
    });
    const rareVocab = buildTextFeatureVocab([rare]);
    expect(rareVocab.classifications).toEqual(['Idle Breezer']);
  });

  it('are identical for unchanged content and immediate for new cards', () => {
    const a = makeCard({
      id: 1,
      keywords: ['Rush'],
      strength: 3,
      willpower: 5,
      lore: 2,
    });
    const b = makeCard({
      id: 999,
      keywords: ['Rush'],
      strength: 3,
      willpower: 5,
      lore: 2,
    });
    const vocab = buildTextFeatureVocab([a, b]);
    expect([...cardTextVector(a, vocab)]).toEqual([
      ...cardTextVector(b, vocab),
    ]);
    expect(cardTextVector(a, vocab)).toBe(cardTextVector(a, vocab)); // memoized per vocab
    const fresh = makeCard({ id: 5001, name: 'Brand New Set Card' });
    expect(cardTextVector(fresh, vocab).length).toBe(vocab.dim);
  });

  it('build a count-weighted normalized deck vector', () => {
    const cards = [
      makeCard({ id: 1, keywords: ['Rush'] }),
      makeCard({ id: 2, keywords: ['Ward'] }),
    ];
    const d1 = deckTextVector(
      { title: 'T', inks: [], format: 'core', cards: { 1: 60 } } as never,
      byIdMap(cards),
    );
    const mixed = deckTextVector(
      {
        title: 'T',
        inks: [],
        format: 'core',
        cards: { 1: 30, 2: 30 },
      } as never,
      byIdMap(cards),
    );
    expect(d1).not.toBeNull();
    expect(mixed).not.toBeNull();
    expect([...d1!]).not.toEqual([...mixed!]);
    expect(Math.sqrt([...mixed!].reduce((s, x) => s + x * x, 0))).toBeCloseTo(
      1,
      5,
    );
  });
});

describe('suggestCards', () => {
  const amberCard = (
    id: number,
    name: string,
    over: Partial<Card> = {},
  ): Card => makeCard({ id, name, inks: ['Amber'], ...over });

  const cards: Card[] = [
    amberCard(1, 'Deck Member A'),
    amberCard(2, 'Deck Member B'),
    amberCard(3, 'Relational Fit'), // strong relation sim
    amberCard(4, 'Textual Fit', { keywords: ['Rush'] }),
    amberCard(5, 'Same Name Other Print'),
    amberCard(6, 'Off Ink', { inks: ['Ruby'] }),
    amberCard(7, 'Format Illegal', {
      formats: { core: false, infinity: true },
    }),
    amberCard(8, 'Owned Other Print'), // same groupKey as card 5 → owned via 5? no: separate group
  ];
  // card 5 and 8 share a group (reprint pair) — deck owns card 5, so 8 must be excluded
  cards[7] = makeCard({
    id: 8,
    name: 'Deck Member A',
    version: 'Reprint',
    inks: ['Amber'],
  });
  cards[4] = makeCard({
    id: 5,
    name: 'Deck Member A',
    version: 'Original',
    inks: ['Amber'],
  });

  const deck2 = {
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards: { 1: 30, 2: 30 },
  } as const;

  const relationsModel = (rel: Record<number, number[]>): MetaModel => ({
    ...model,
    capabilities: { relations: true, calibration: true },
    relations: embed(2, rel),
  });

  it('excludes owned (any print), off-ink, and format-illegal cards', () => {
    const m = relationsModel({
      1: [1, 0],
      2: [1, 0],
      3: [1, 0],
      4: [0.8, 0.2],
    });
    const suggestions = suggestCards(deck2 as never, cards, m);
    const names = suggestions.map((s) => s.card.fullName);
    expect(names).not.toContain('Deck Member A'); // owned incl. its reprint
    expect(names).not.toContain('Deck Member B');
    expect(names).not.toContain('Off Ink');
    expect(names).not.toContain('Format Illegal');
  });

  it('ranks by fused score and labels the affinity basis', () => {
    const m = relationsModel({
      1: [1, 0],
      2: [1, 0],
      3: [1, 0], // relation-perfect
      4: [0, 1], // text-different
    });
    const suggestions = suggestCards(deck2 as never, cards, m);
    const byName = (n: string): CardSuggestion =>
      suggestions.find((s) => s.card.name === n)!;
    const relational = byName('Relational Fit');
    const textual = byName('Textual Fit');
    expect(relational.basis).toBe(BASIS_FUSED);
    expect(relational.score).toBeCloseTo(
      0.6 * relational.relationSim! + 0.4 * relational.textSim,
      4,
    );
    expect(textual.basis).toBe(BASIS_FUSED); // has a relation vector too
    // deterministic ranking across calls
    expect(suggestCards(deck2 as never, cards, m)).toEqual(suggestions);
    expect(suggestions.length).toBeLessThanOrEqual(SUGGESTION_LIMIT);
  });

  it('falls back to text-only ranking without relation embeddings', () => {
    const textOnly: MetaModel = {
      ...model,
      capabilities: { relations: false, calibration: true },
      relations: undefined,
    };
    const suggestions = suggestCards(deck2 as never, cards, textOnly);
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s.basis).toBe(BASIS_TEXT);
      expect(s.relationSim).toBeNull();
      expect(s.score).toBe(s.textSim);
    }
  });

  it('returns a text-only basis for candidates outside the relation space', () => {
    // candidate 4 has no relation vector → ranked on text alone even with relations present
    const m = relationsModel({ 1: [1, 0], 2: [1, 0], 3: [0.9, 0.1] });
    const suggestions = suggestCards(deck2 as never, cards, m);
    const textual = suggestions.find((s) => s.card.name === 'Textual Fit');
    if (textual) {
      expect(textual.relationSim).toBeNull();
      expect(textual.basis).toBe(BASIS_TEXT);
    }
  });

  it('resolves deck cards to canonical ids before relation lookup', () => {
    // the deck holds an old print (id 300) of Deck Member A; relation vectors
    // key on canonical ids, so the deck-side lookup must resolve 300 → 1
    const oldPrint = makeCard({ id: 300, name: 'Deck Member A' });
    const deckOldPrint = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 300: 30, 2: 30 },
    } as never;
    const m = relationsModel({ 1: [1, 0], 2: [1, 0], 3: [1, 0] });
    const suggestions = suggestCards(deckOldPrint, [...cards, oldPrint], m);
    const relational = suggestions.find(
      (s) => s.card.name === 'Relational Fit',
    );
    expect(relational).toBeDefined();
    expect(relational!.relationSim).not.toBeNull();
    expect(relational!.basis).toBe(BASIS_FUSED);
  });

  it('respects the top-8 limit', () => {
    const many: Card[] = Array.from({ length: 30 }, (_, i) =>
      amberCard(100 + i, `Filler ${i}`),
    );
    const m = relationsModel({ 1: [1, 0], 2: [1, 0] });
    const suggestions = suggestCards(
      deck2 as never,
      [cards[0]!, cards[1]!, ...many],
      m,
    );
    expect(suggestions).toHaveLength(SUGGESTION_LIMIT);
  });

  it('produces identical score components from the shared scoring module (panel = generator path)', () => {
    const m = relationsModel({ 1: [1, 0], 2: [1, 0], 3: [1, 0], 4: [0, 1] });
    const suggestions = suggestCards(deck2 as never, cards, m);
    expect(suggestions.length).toBeGreaterThan(0);

    // the generator's per-iteration path: same context, same vectors, same components
    const ctx = buildScoringContext(cards, m);
    const vectors = deckVectors(deck2 as never, ctx);
    for (const s of suggestions.slice(0, 4)) {
      const { relationSim, textSim } = candidateComponents(
        s.card,
        ctx,
        vectors,
      );
      if (s.relationSim === null) expect(relationSim).toBeNull();
      else expect(relationSim).toBeCloseTo(s.relationSim, 4);
      expect(textSim).toBeCloseTo(s.textSim, 4);
    }
  });
});

describe('artifact versions (D6 tolerance)', () => {
  const base = {
    dataThroughDate: '2026-11-10',
    cardSchemaVersion: 1,
    capabilities: { relations: true, calibration: false },
    relations: embed(2, { 1: [1, 0] }),
  };

  it('parses a version-2 artifact without popularity maps (neutral weighting)', () => {
    const parsed = parseMetaModel({ ...base, version: '2' });
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe('2');
    expect(parsed!.playrate).toBeUndefined();
    expect(parsed!.typicalCopies).toBeUndefined();
  });

  it('parses a version-3 artifact with playrate and typical-copies maps', () => {
    const parsed = parseMetaModel({
      ...base,
      version: '3',
      playrate: { 1: 128, 2: 0 },
      typicalCopies: { 1: 4, 2: 2 },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.playrate).toEqual({ 1: 128, 2: 0 });
    expect(parsed!.typicalCopies).toEqual({ 1: 4, 2: 2 });
  });

  it('rejects non-object popularity maps', () => {
    expect(
      parseMetaModel({ ...base, version: '3', playrate: 'nope' }),
    ).toBeNull();
    expect(
      parseMetaModel({ ...base, version: '3', typicalCopies: 5 }),
    ).toBeNull();
  });
});

describe('loadMetaModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const validArtifact = {
    version: '3',
    dataThroughDate: '2026-11-10',
    capabilities: { relations: true, calibration: false },
    relations: {
      dim: 1,
      quantization: 'int16-le',
      vectors: { 1: { b64: 'AA==', scale: 1 } },
    },
  };

  it('returns null when the artifact is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false })),
    );
    expect(await loadMetaModel()).toBeNull();
  });

  it('parses a valid artifact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => validArtifact })),
    );
    expect((await loadMetaModel())?.version).toBe('3');
  });

  it('returns null on network errors and invalid payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadMetaModel()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ nope: true }) })),
    );
    expect(await loadMetaModel()).toBeNull();
  });
});
