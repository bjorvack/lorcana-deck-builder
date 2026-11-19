import { describe, expect, it, vi } from 'vitest';
import { buildFullName, groupKey, mergeLorcast, normalizeAll, unknownDeckRuleText, type RawAllCards, type RawCard } from './normalize';
import { verifyMd5, type FetchResult } from './fetch';
import { parseArgs } from './pipeline';
import { tagCard, type TagRules } from './tag';
import type { Card } from '../src/data/types';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function rawCard(overrides: Partial<RawCard>): RawCard {
  return {
    id: 1,
    name: 'Test',
    color: 'Amber',
    cost: 3,
    type: 'Character',
    rarity: 'Common',
    number: 1,
    story: 'Frozen',
    ...overrides,
  };
}

function allCards(cards: RawCard[], sets: RawAllCards['sets'] = {}): FetchResult {
  return {
    allCards: { metadata: { generatedOn: 't', formatVersion: '2.3.0' }, sets, cards } satisfies RawAllCards,
    lorcastBySet: {},
    checksums: [{ file: 'allCards.json', ok: true }],
    lorcastFetched: false,
  };
}

describe('normalize', () => {
  it('maps dual-ink cards to an ink array and dual flag', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 1505, name: 'Anna', version: 'Ice Breaker', color: 'Amethyst-Sapphire', colors: ['Amethyst', 'Sapphire'] }),
    ]));
    const card = result.cards[0]!;
    expect(card.inks).toEqual(['Amethyst', 'Sapphire']);
    expect(card.isDualInk).toBe(true);
  });

  it('defaults copy limit to 4 and preserves 99 / unlimited exceptions', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 1 }),
      rawCard({ id: 2, name: 'Dalmatian Puppy', version: 'Tail Wagger', maxCopiesInDeck: 99 }),
      rawCard({ id: 3, name: 'Microbots', maxCopiesInDeck: null }),
    ]));
    expect(result.cards[0]!.maxCopies).toBe(4);
    expect(result.cards[1]!.maxCopies).toBe(99);
    expect(result.cards[2]!.maxCopies).toBe('unlimited');
  });

  it('derives inkability from card type when the field is absent and records the derivation', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 1, type: 'Character', inkwell: undefined }),
      rawCard({ id: 2, type: 'Action', inkwell: undefined }),
      rawCard({ id: 3, type: 'Location', inkwell: undefined }),
    ]));
    expect(result.cards.map((c) => c.inkwell)).toEqual([true, false, false]);
    expect(result.derivations).toHaveLength(3);
  });

  it('marks Quest-set cards as Core-illegal but Infinity-legal', () => {
    const result = normalizeAll(allCards([rawCard({ id: 1 })], { Q1: { code: 'Q1', name: 'Quest', type: 'quest' } }));
    result.cards[0]!.setCode = 'Q1';
    const card = normalizeAll(allCards([rawCard({ id: 1, setCode: 'Q1' })], { Q1: { code: 'Q1', name: 'Quest', type: 'quest' } })).cards[0]!;
    expect(card.setType).toBe('quest');
    expect(card.formats.core).toBe(false);
    expect(card.formats.infinity).toBe(true);
  });

  it('carries the ink-exemption deck-rule effect for Christopher Robin - Hunny Sage', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 3032, name: 'Christopher Robin', version: 'Hunny Sage', color: 'Amethyst-Sapphire', colors: ['Amethyst', 'Sapphire'], subtypes: ['Dreamborn', 'Hero', 'Hunny'], fullText: 'GATHER THE PARTY You can have other Hunny characters in your deck regardless of ink type.' }),
    ]));
    const card = result.cards[0]!;
    expect(card.deckRuleEffects).toHaveLength(1);
    expect(card.deckRuleEffects[0]).toMatchObject({ kind: 'inkExemption', targetSubtypes: ['Hunny'], targetTypes: ['Character'], exceptSelf: true });
    expect(result.needsReview).toHaveLength(0);
  });

  it('flags deck-rule phrasing that has neither an override nor a data field', () => {
    const flagged = rawCard({ id: 9, fullText: 'You can have any cards in your deck regardless of ink type.' });
    const explained = rawCard({ id: 10, fullText: 'You may have up to 99 copies of Dalmatian Puppy - Tail Wagger in your deck.', maxCopiesInDeck: 99 });
    expect(unknownDeckRuleText(flagged)).toBe(true);
    expect(unknownDeckRuleText(explained)).toBe(false);
    const result = normalizeAll(allCards([flagged, explained]));
    expect(result.needsReview).toEqual([{ cardId: 9, reason: 'deck-rule phrasing without a known effect' }]);
  });

  it('reports cards missing a franchise', () => {
    const result = normalizeAll(allCards([rawCard({ id: 1, story: undefined })]));
    expect(result.missingStory).toEqual([1]);
  });

  it('attaches typed payoffs for shift variants, named references and sing requirements', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 10, name: 'Hiro', version: 'Armor Designer', fullText: 'Shift 5 (You may pay 5 ⬡ to play this on top of one of your characters named Hiro.)', keywordAbilities: ['Shift'] }),
      rawCard({ id: 11, name: 'Fan', fullText: 'Whenever you play a character, if you have a character named Hiro in play, gain 1 lore.' }),
      rawCard({ id: 12, name: 'A Song', subtypes: ['Song'], fullText: '(A character with cost 4 or more can ⟳ to sing this song for free.)\nDraw 2 cards.' }),
    ]));
    const [hiro, fan, song] = result.cards;
    expect(hiro!.payoffs).toEqual([
      { kind: 'shift', variant: 'named', cost: { mode: 'ink', amount: 5 }, names: ['Hiro'] },
    ]);
    expect(fan!.payoffs).toEqual([{ kind: 'named', name: 'Hiro' }]);
    expect(song!.payoffs).toEqual([{ kind: 'sing', minCost: 4 }]);
  });

  it('applies payoff overrides for the audit’s special cases', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 3423, name: 'Baymax', version: 'Amped Up', keywordAbilities: ['Shift'], fullText: 'Shift Remove 2 ink drops\nSUPERCHARGE If you would get an ink drop, you may put the top card of your deck into your inkwell facedown and exerted instead.' }),
      rawCard({ id: 517, name: 'Morph', version: 'Space Goo', fullText: 'MIMICRY You may play any character with Shift on this character as if this character had any name.' }),
      rawCard({ id: 2513, name: 'Anna', version: 'Soothing Sister', fullText: 'UNUSUAL TRANSFORMATION If a card left a player\'s discard this turn, this card gains Shift 0 ⬡. (You may pay 0 ⬡ to play this on top of one of your characters named Anna.)' }),
    ]));
    const [baymax, morph, anna] = result.cards;
    expect(baymax!.payoffs).toEqual([
      { kind: 'shift', variant: 'named', cost: { mode: 'inkDrops', amount: 2 }, names: ['Baymax'] },
    ]);
    expect(morph!.payoffs).toEqual([{ kind: 'mimicry', advanced: false }]);
    expect(anna!.payoffs).toEqual([
      { kind: 'shift', variant: 'named', cost: { mode: 'ink', amount: 0 }, names: ['Anna'], conditional: true },
    ]);
    // overridden cards drop out of needsReview
    expect(result.needsReview.filter((n) => [3423, 517, 2513].includes(n.cardId))).toEqual([]);
  });

  it('flags unparseable shift-like text as needs-review', () => {
    const result = normalizeAll(allCards([
      rawCard({ id: 99, name: 'Future', version: 'Quantum Hero', keywordAbilities: ['Quantum Shift'], fullText: 'Quantum Shift 3 ⬡ (You may pay 3 ⬡ to play this on top of one of your characters in a parallel universe.)' }),
      rawCard({ id: 100, name: 'Normal', fullText: 'Banish chosen character of cost 3 or less.' }),
    ]));
    expect(result.needsReview).toEqual([
      { cardId: 99, reason: 'shift-like text without a parseable payoff' },
    ]);
    expect(result.cards.find((c) => c.id === 100)!.payoffs).toEqual([]);
  });

  it('groups copies across prints by normalized full name', () => {
    expect(groupKey('Te Kā - The Burning One')).toBe('te ka the burning one');
    expect(buildFullName(rawCard({ name: 'Elsa', version: 'Spirit of Winter' }))).toBe('Elsa - Spirit of Winter');
  });

  it('merges Lorcast prices by set + collector number + name', () => {
    const result = normalizeAll(allCards([rawCard({ id: 1, setCode: '1' })]));
    result.cards[0]!.collectorNumber = '1';
    mergeLorcast(result.cards, { '1': [{ name: 'Test', collector_number: '1', prices: { usd: '0.10', usd_foil: null } }] });
    expect(result.cards[0]!.prices).toEqual({ usd: '0.10', usdFoil: undefined });
  });
});

describe('tagging', () => {
  const rules: TagRules = {
    version: 1,
    gameplayTags: [
      { tag: 'removal', include: ['banish chosen'], exclude: [] },
      { tag: 'draw', include: ['\\bdraw(s)? (a|one|two|three|\\d+|that many|up to|your)\\b', '\\bdraw a card\\b'], exclude: ["can'?t draw"] },
    ],
  };

  it('tags gameplay functions from text patterns', () => {
    const card = { text: 'Deal 1 damage: Banish chosen character.', keywords: ['Evasive'], tags: [] } as unknown as Card;
    const tags = tagCard(card, rules);
    expect(tags).toContainEqual({ tag: 'removal', by: 'rule' });
    expect(tags).toContainEqual({ tag: 'evasive', by: 'rule' });
  });

  it('respects exclude patterns (negations do not tag)', () => {
    const card = { text: 'Each opponent can\'t draw a card during their next turn.', keywords: [], tags: [] } as unknown as Card;
    expect(tagCard(card, rules).map((t) => t.tag)).not.toContain('draw');
  });
});

describe('pipeline cli', () => {
  it('defaults to running both steps', () => {
    expect(parseArgs([])).toBe('all');
    expect(parseArgs(['--step', 'fetch'])).toBe('fetch');
    expect(parseArgs(['--step', 'build'])).toBe('build');
    expect(() => parseArgs(['--step', 'nope'])).toThrow();
  });
});

describe('fetch verification', () => {
  it('verifies md5 checksums against the published digest', async () => {
    const dir = path.join(tmpdir(), `ldb-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'x.json');
    const content = JSON.stringify({ hello: 'world' });
    await writeFile(file, content);
    const digest = createHash('md5').update(content).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${digest}\n`, { status: 200 })));
    const ok = await verifyMd5(file, 'https://example.com/x.json.md5');
    expect(ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('falls back to lorcanajson-only when Lorcast is unreachable', async () => {
    const body = JSON.stringify({ metadata: {}, sets: {}, cards: [] });
    const digest = createHash('md5').update(body).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('lorcast')) throw new Error('ECONNREFUSED');
      if (String(url).endsWith('.md5')) return new Response(`${digest}\n`, { status: 200 });
      return new Response(body, { status: 200 });
    }));
    const { fetchAll } = await import('./fetch');
    const result = await fetchAll(path.join(tmpdir(), `ldb-f-${Date.now()}`));
    expect(result.lorcastFetched).toBe(false);
    expect(result.checksums[0]?.ok).toBe(true);
    vi.unstubAllGlobals();
  });
});
