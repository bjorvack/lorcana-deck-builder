import { describe, expect, it } from 'vitest';
import {
  BASIS_FUSED,
  BASIS_TEXT,
  KEYWORD_FEATURES,
  SUGGESTION_LIMIT,
  TAG_FEATURES,
  TEXT_FEATURE_DIM,
  cardTextVector,
  deckTextVector,
  identifyArchetype,
  isStale,
  metaAdjustedViability,
  parseMetaModel,
  relationVectors,
  snapshotDate,
  suggestCards,
  type CardSuggestion,
  type MetaModel,
} from './infer';
import { makeCard, byIdMap } from '../test/fixtures';
import type { Card } from '../data/types';

const model: MetaModel = {
  version: '2-fixture',
  dataThroughDate: '2026-11-10',
  capabilities: { relations: false, calibration: true },
  archetypes: [
    { id: 1, name: 'Steel Song', observedWinRate: 0.54, sampleSize: 120, centroid: { '1': 0.12, '2': 0.1 } },
    { id: 2, name: 'Ramp Leviathan', observedWinRate: 0.44, sampleSize: 80, centroid: { '9': 0.1 } },
  ],
  cardWeights: {},
};

/** little-endian Int16 + scale encoder matching the artifact format */
function embed(dim: number, raw: Record<number, number[]>): MetaModel['relations'] {
  const vectors: Record<string, { b64: string; scale: number }> = {};
  for (const [id, vec] of Object.entries(raw)) {
    const maxAbs = Math.max(...vec.map((v) => Math.abs(v)));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = Buffer.alloc(dim * 2);
    vec.forEach((v, d) => buf.writeInt16LE(Math.round(v / scale), d * 2));
    vectors[id] = { b64: buf.toString('base64'), scale };
  }
  return { dim, quantization: 'int16-le', vectors };
}

const byId = byIdMap([
  makeCard({ id: 1, name: 'Card One', cost: 3 }),
  makeCard({ id: 2, name: 'Card Two', cost: 4 }),
]);
const deck = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 30, 2: 30 } } as const;

describe('meta inference', () => {
  it('matches the closest archetype by centroid similarity', () => {
    const m = identifyArchetype(deck as never, byId, model)!;
    expect(m.archetype.name).toBe('Steel Song');
    expect(m.similarity).toBeGreaterThan(0.9);
  });

  it('canonicalizes the deck vector to the newest print of a group', () => {
    const oldPrint = makeCard({ id: 1, name: 'Beast', version: 'Original' });
    const newPrint = { ...makeCard({ id: 77, name: 'Beast', version: 'Original' }), releasedAt: '2026-01-01' };
    const cards = [oldPrint, newPrint, makeCard({ id: 2, name: 'Card Two', cost: 4 })];
    const deck2 = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 60 } } as const; // old print id
    const m: MetaModel = {
      ...model,
      archetypes: [{ id: 1, name: 'Beast Deck', observedWinRate: 0.6, sampleSize: 10, centroid: { '77': 1 } }],
    };
    const match = identifyArchetype(deck2 as never, byIdMap(cards), m, cards)!;
    expect(match.similarity).toBeCloseTo(1);
  });

  it('decomposes viability into sim strength and meta alignment', () => {
    const fp = {
      version: 1,
      axes: { Tempo: 60, Consistency: 60, Resilience: 40, Interaction: 40, Reach: 40 },
    } as never;
    const v = metaAdjustedViability(fp as never, deck as never, byId, model);
    // sim: .3*60 + .25*60 + .2*40 + .15*40 + .1*40 = 51
    expect(v.simStrength).toBe(51);
    // alignment: (0.54 - 0.5) * 2 * similarity * 50 > 0
    expect(v.metaAlignment).toBeGreaterThan(0);
    expect(v.total).toBe(Math.max(0, Math.min(100, v.simStrength + v.metaAlignment)));
  });

  it('scores viability without archetypes when the calibration gate failed', () => {
    const fp = { version: 1, axes: { Tempo: 60, Consistency: 60, Resilience: 40, Interaction: 40, Reach: 40 } } as never;
    const relationsOnly: MetaModel = { ...model, capabilities: { relations: true, calibration: false }, archetypes: undefined };
    const v = metaAdjustedViability(fp as never, deck as never, byId, relationsOnly);
    expect(v.match).toBeNull();
    expect(v.metaAlignment).toBe(0);
    expect(v.simStrength).toBe(51);
  });

  it('flags a model stale when its data predates the card snapshot', () => {
    expect(snapshotDate('2026-11-17T12:23:26.078Z')).toBe('2026-11-17');
    expect(isStale(model, '2026-11-17T00:00:00Z')).toBe(true);
    expect(isStale(model, '2026-11-10T00:00:00Z')).toBe(false);
    expect(isStale({ ...model, dataThroughDate: '2026-11-17' }, '2026-11-17T00:00:00Z')).toBe(false);
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
  const strip = (m: Record<string, unknown>, key: string): Record<string, unknown> => {
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
    expect(parsed!.capabilities).toEqual({ relations: true, calibration: false });
    expect(parsed!.archetypes).toBeUndefined();
    expect(parsed!.relations).toBeDefined();

    const calibrationOnly = { ...strip(full as Record<string, unknown>, 'relations'), capabilities: { relations: false, calibration: true } };
    const parsed2 = parseMetaModel(calibrationOnly);
    expect(parsed2!.capabilities).toEqual({ relations: false, calibration: true });
    expect(parsed2!.relations).toBeUndefined();
    expect(parsed2!.archetypes).toBeDefined();
  });

  it('rejects malformed or capability-less artifacts', () => {
    expect(parseMetaModel(null)).toBeNull();
    expect(parseMetaModel({})).toBeNull();
    expect(parseMetaModel({ ...strip(full as Record<string, unknown>, 'capabilities') })).toBeNull();
    const neither = { ...full, capabilities: { relations: false, calibration: false } };
    expect(parseMetaModel(neither)).toBeNull();
    const relationsWithoutPayload = { ...full, relations: undefined };
    expect(parseMetaModel(relationsWithoutPayload)).toBeNull();
    const calibrationWithoutArchetypes = strip(full as Record<string, unknown>, 'archetypes');
    expect(parseMetaModel(calibrationWithoutArchetypes)).toBeNull();
    expect(parseMetaModel({ ...full, dataThroughDate: 'November' })).toBeNull();
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
  it('have a stable dimension and unit norm', () => {
    expect(TEXT_FEATURE_DIM).toBe(KEYWORD_FEATURES.length + TAG_FEATURES.length + 4 + 4 + 6 + 3);
    const card = makeCard({ keywords: ['Evasive', 'Floodborn Shift'], text: 'banish', tags: [{ tag: 'removal', by: 'rule' }] });
    const v = cardTextVector(card);
    expect(v.length).toBe(TEXT_FEATURE_DIM);
    const norm = Math.sqrt([...v].reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    const evasive = KEYWORD_FEATURES.indexOf('Evasive');
    const shift = KEYWORD_FEATURES.indexOf('Shift');
    expect(v[evasive]).toBeGreaterThan(0);
    expect(v[shift]).toBeGreaterThan(0); // shift family collapses to one dimension
    expect(v[KEYWORD_FEATURES.length + TAG_FEATURES.indexOf('removal')]).toBeGreaterThan(0);
  });

  it('are identical for unchanged content and immediate for new cards', () => {
    const a = makeCard({ id: 1, keywords: ['Rush'], strength: 3, willpower: 5, lore: 2 });
    const b = makeCard({ id: 999, keywords: ['Rush'], strength: 3, willpower: 5, lore: 2 });
    expect([...cardTextVector(a)]).toEqual([...cardTextVector(b)]);
    expect(cardTextVector(a)).toBe(cardTextVector(a)); // memoized per card object
    const fresh = makeCard({ id: 5001, name: 'Brand New Set Card' });
    expect(cardTextVector(fresh).length).toBe(TEXT_FEATURE_DIM);
  });

  it('build a count-weighted normalized deck vector', () => {
    const cards = [makeCard({ id: 1, keywords: ['Rush'] }), makeCard({ id: 2, keywords: ['Ward'] })];
    const d1 = deckTextVector({ title: 'T', inks: [], format: 'core', cards: { 1: 60 } } as never, byIdMap(cards));
    const mixed = deckTextVector({ title: 'T', inks: [], format: 'core', cards: { 1: 30, 2: 30 } } as never, byIdMap(cards));
    expect(d1).not.toBeNull();
    expect(mixed).not.toBeNull();
    expect([...d1!]).not.toEqual([...mixed!]);
    expect(Math.sqrt([...mixed!].reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5);
  });
});

describe('suggestCards', () => {
  const amberCard = (id: number, name: string, over: Partial<Card> = {}): Card =>
    makeCard({ id, name, inks: ['Amber'], ...over });

  const cards: Card[] = [
    amberCard(1, 'Deck Member A'),
    amberCard(2, 'Deck Member B'),
    amberCard(3, 'Relational Fit'), // strong relation sim
    amberCard(4, 'Textual Fit', { keywords: ['Rush'] }),
    amberCard(5, 'Same Name Other Print'),
    amberCard(6, 'Off Ink', { inks: ['Ruby'] }),
    amberCard(7, 'Format Illegal', { formats: { core: false, infinity: true } }),
    amberCard(8, 'Owned Other Print'), // same groupKey as card 5 → owned via 5? no: separate group
  ];
  // card 5 and 8 share a group (reprint pair) — deck owns card 5, so 8 must be excluded
  cards[7] = makeCard({ id: 8, name: 'Deck Member A', version: 'Reprint', inks: ['Amber'] });
  cards[4] = makeCard({ id: 5, name: 'Deck Member A', version: 'Original', inks: ['Amber'] });

  const deck2 = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 30, 2: 30 } } as const;

  const relationsModel = (rel: Record<number, number[]>): MetaModel => ({
    ...model,
    capabilities: { relations: true, calibration: true },
    relations: embed(2, rel),
  });

  it('excludes owned (any print), off-ink, and format-illegal cards', () => {
    const m = relationsModel({ 1: [1, 0], 2: [1, 0], 3: [1, 0], 4: [0.8, 0.2] });
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
    const byName = (n: string): CardSuggestion => suggestions.find((s) => s.card.name === n)!;
    const relational = byName('Relational Fit');
    const textual = byName('Textual Fit');
    expect(relational.basis).toBe(BASIS_FUSED);
    expect(relational.score).toBeCloseTo(0.6 * relational.relationSim! + 0.4 * relational.textSim, 4);
    expect(textual.basis).toBe(BASIS_FUSED); // has a relation vector too
    // deterministic ranking across calls
    expect(suggestCards(deck2 as never, cards, m)).toEqual(suggestions);
    expect(suggestions.length).toBeLessThanOrEqual(SUGGESTION_LIMIT);
  });

  it('falls back to text-only ranking without relation embeddings', () => {
    const textOnly: MetaModel = { ...model, capabilities: { relations: false, calibration: true }, relations: undefined };
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
    const deckOldPrint = { title: 'T', inks: ['Amber'], format: 'core', cards: { 300: 30, 2: 30 } } as never;
    const m = relationsModel({ 1: [1, 0], 2: [1, 0], 3: [1, 0] });
    const suggestions = suggestCards(deckOldPrint, [...cards, oldPrint], m);
    const relational = suggestions.find((s) => s.card.name === 'Relational Fit');
    expect(relational).toBeDefined();
    expect(relational!.relationSim).not.toBeNull();
    expect(relational!.basis).toBe(BASIS_FUSED);
  });

  it('respects the top-8 limit', () => {
    const many: Card[] = Array.from({ length: 30 }, (_, i) => amberCard(100 + i, `Filler ${i}`));
    const m = relationsModel({ 1: [1, 0], 2: [1, 0] });
    const suggestions = suggestCards(deck2 as never, [cards[0]!, cards[1]!, ...many], m);
    expect(suggestions).toHaveLength(SUGGESTION_LIMIT);
  });
});
