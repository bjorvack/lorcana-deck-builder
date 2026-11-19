import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Card, DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { curveConsistency } from './curve';
import { computeFingerprint } from './fingerprint';
import { simulateRace } from './goldfish';
import { openingHandQuality } from './hand';
import { shiftTargetName, tempoEffects } from './tempo';

describe('tempo effects', () => {
  it('skips conditional self discounts (v1 scope)', () => {
    const lefou = makeCard({
      name: 'LeFou',
      version: 'Bumbler',
      cost: 2,
      text: 'LOYAL If you have a character named Gaston in play, you pay 1 ⬡ less to play this character.',
    });
    expect(tempoEffects(lefou).selfDiscount).toBe(0);
  });

  it('extracts conditional discounts with their target', () => {
    const lefou = makeCard({
      name: 'LeFou',
      version: 'Bumbler',
      cost: 2,
      text: 'LOYAL If you have a character named Gaston in play, you pay 1 ⬡ less to play this character.',
    });
    expect(tempoEffects(lefou).conditionalDiscount).toEqual({
      amount: 1,
      target: 'Gaston',
    });
    const slightly = makeCard({
      name: 'Slightly',
      version: 'Lost Boy',
      text: 'THE FOX If you have a character named Peter Pan in play, you pay 1 ⬡ less to play this character.',
    });
    expect(tempoEffects(slightly).conditionalDiscount).toEqual({
      amount: 1,
      target: 'Peter Pan',
    });
  });

  it('detects ramp, additional ink, ink drops and flexible inking', () => {
    const oja = makeCard({
      name: 'One Jump Ahead',
      type: 'Action',
      cost: 2,
      inkwell: false,
      text: 'Put the top card of your deck into your inkwell facedown and exerted.',
    });
    expect(tempoEffects(oja).rampOnPlay).toBe(true);

    const belle = makeCard({
      name: 'Belle',
      version: 'Strange but Special',
      text: 'READ A BOOK During your turn, you may ink an additional card.',
    });
    expect(tempoEffects(belle).additionalInkWhileInPlay).toBe(true);
    expect(tempoEffects(belle).additionalInkOnPlay).toBe(false);

    const sail = makeCard({
      name: 'Sail the Azurite Sea',
      type: 'Action',
      text: 'This turn, you may ink an additional card. Draw a card.',
    });
    expect(tempoEffects(sail).additionalInkOnPlay).toBe(true);
    expect(tempoEffects(sail).additionalInkWhileInPlay).toBe(false);

    const merlin = makeCard({
      name: 'Merlin',
      version: 'Bauble Expert',
      text: 'RAW MATERIAL When you play this character, if you have a character named Arthur in play, get 1 ink drop. (You may remove an ink drop to pay 1 ⬡.)',
    });
    expect(tempoEffects(merlin).inkDropsOnPlay).toBe(1);

    const quill = makeCard({
      name: 'Fishbone Quill',
      type: 'Item',
      text: 'GO AHEAD AND SIGN ⟳ — Put any card from your hand into your inkwell facedown.',
    });
    expect(tempoEffects(quill).flexibleInk).toBe(true);
    expect(tempoEffects(quill).rampOnPlay).toBe(false);
  });

  it('reads Singer values and Shift targets', () => {
    const ariel = makeCard({
      name: 'Ariel',
      version: 'Spectral Singer',
      keywords: ['Singer'],
      text: 'Singer 5 (This character exerted to sing a song with cost 5 or less for free.)',
    });
    expect(tempoEffects(ariel).singerValue).toBe(5);
    const elsa = makeCard({
      name: 'Elsa',
      version: 'Spirit of Winter',
      keywords: ['Shift'],
      text: 'Shift 6 (You may pay 6 ⬡ to play this on top of one of your characters named Elsa.)',
    });
    expect(shiftTargetName(elsa)).toBe('Elsa');
    expect(shiftTargetName(makeCard({ name: 'Plain', text: '' }))).toBeNull();
  });

  describe('against the real snapshot', {
    skip: !existsSync('public/data/cards.min.json'),
  }, () => {
    const db: Card[] = JSON.parse(
      readFileSync('public/data/cards.min.json', 'utf8'),
    ).cards;
    const byName = new Map(db.map((c) => [c.fullName, c]));
    const get = (n: string): Card => {
      const c = byName.get(n);
      if (!c) throw new Error(`missing card: ${n}`);
      return c;
    };

    it('classifies known cards correctly', () => {
      expect(tempoEffects(get('One Jump Ahead')).rampOnPlay).toBe(true);
      expect(tempoEffects(get('Fishbone Quill')).flexibleInk).toBe(true);
      expect(
        tempoEffects(get('Belle - Strange but Special'))
          .additionalInkWhileInPlay,
      ).toBe(true);
      // conditional discount: not modelled in v1
      expect(tempoEffects(get('LeFou - Bumbler')).selfDiscount).toBe(0);
      expect(tempoEffects(get('Ariel - Spectacular Singer')).singerValue).toBe(
        5,
      );
      expect(shiftTargetName(get('Elsa - Spirit of Winter'))).toBe('Elsa');
    });
  });
});

describe('curve consistency v2', () => {
  const mk = (cards: Record<number, number>): DeckState => ({
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards,
  });
  const byId = byIdMap([
    makeCard({ id: 1, cost: 1 }),
    makeCard({ id: 2, cost: 2 }),
    makeCard({ id: 3, cost: 3 }),
    makeCard({ id: 4, cost: 3, inkwell: false, type: 'Action' }),
  ]);

  it('keeps existing behaviours: healthy deck, skips, empty deck, determinism', () => {
    const c = curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId)!;
    expect(c.byTurn[1]!).toBeGreaterThan(0.9);
    expect(c.byTurn[2]!).toBeGreaterThan(0.85);
    expect(c.expectedInk[1]).toBeCloseTo(1, 1);
    const skip = curveConsistency(mk({ 2: 60 }), byId)!;
    expect(skip.byTurn[1]).toBeNull();
    expect(skip.onCurveThrough).toBe(1);
    expect(curveConsistency(mk({}), byId)).toBeNull();
    expect(
      curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId, {
        trials: 500,
        seed: 7,
      }),
    ).toEqual(
      curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId, {
        trials: 500,
        seed: 7,
      }),
    );
  });

  it('sings a big song via a low-cost Singer, ahead of the ink curve', () => {
    const song = makeCard({
      id: 10,
      name: 'Big Song',
      cost: 5,
      isSong: true,
      inkwell: false,
      type: 'Action',
    });
    const singer = makeCard({
      id: 11,
      name: 'Ariel',
      version: 'Spectacular Singer',
      cost: 3,
      keywords: ['Singer'],
      text: 'Singer 5 (This character exerted to sing a song with cost 5 or less for free.)',
    });
    const plain = makeCard({
      id: 12,
      name: 'Ariel',
      version: 'Ordinary',
      cost: 3,
    });
    const base = byIdMap([song, singer, makeCard({ id: 1, cost: 1 })]);
    const withSinger = curveConsistency(mk({ 1: 30, 11: 26, 10: 4 }), base)!;
    const withoutSinger = curveConsistency(
      mk({ 1: 30, 12: 26, 10: 4 }),
      byIdMap([song, plain, makeCard({ id: 1, cost: 1 })]),
    )!;
    // ink reaches only 4 by turn 4 — the cost-5 song is only playable when sung
    expect(withSinger.singsByTurn[4]!).toBeGreaterThan(0.1);
    expect(withoutSinger.singsByTurn[4]!).toBe(0);
    // sung songs are ahead-of-curve plays: the song leaves the hand before turn 5
    expect(withSinger.byTurn[5]!).toBeLessThan(withoutSinger.byTurn[5]!);
  });

  it('ramp grows the inkwell beyond one card per turn', () => {
    const ramp = makeCard({
      id: 12,
      name: 'Ramp',
      type: 'Action',
      inkwell: false,
      cost: 2,
      text: 'Put the top card of your deck into your inkwell facedown and exerted.',
    });
    const ids = byIdMap([makeCard({ id: 1, cost: 1 }), ramp]);
    const withRamp = curveConsistency(mk({ 1: 52, 12: 8 }), ids)!;
    const without = curveConsistency(
      mk({ 1: 60 }),
      byIdMap([makeCard({ id: 1, cost: 1 })]),
    )!;
    expect(withRamp.expectedInk[5]!).toBeGreaterThan(without.expectedInk[5]!);
  });

  it('applies conditional discounts only with the named character on board', () => {
    const lefou = makeCard({
      id: 20,
      name: 'LeFou',
      version: 'Bumbler',
      cost: 3,
      text: 'If you have a character named Gaston in play, you pay 1 ⬡ less to play this character.',
    });
    const gaston = makeCard({
      id: 21,
      name: 'Gaston',
      version: 'Poser',
      cost: 3,
    });
    const other = makeCard({ id: 22, name: 'Not Gaston', cost: 3 });
    const ids = byIdMap([makeCard({ id: 1, cost: 1 }), lefou, gaston, other]);
    // with Gaston: LeFou is on-curve at turn 3 (2 ink + discount)
    const withTarget = curveConsistency(mk({ 1: 24, 21: 30, 20: 6 }), ids)!;
    // without Gaston: LeFou needs the full 3 ink — still turn 3, but the deck competes for it
    const withoutTarget = curveConsistency(mk({ 1: 24, 22: 30, 20: 6 }), ids)!;
    // the discounted version plays LeFou more reliably: fewer 3-cost misses at turn 3
    expect(withTarget.byTurn[3]!).toBeGreaterThanOrEqual(
      withoutTarget.byTurn[3]!,
    );
  });

  it('models on-the-play first-draw skip', () => {
    const play = curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId, {
      onThePlay: true,
      trials: 5000,
    })!;
    const draw = curveConsistency(mk({ 1: 20, 2: 20, 3: 15, 4: 5 }), byId, {
      onThePlay: false,
      trials: 5000,
    })!;
    expect(draw.byTurn[1]!).toBeGreaterThanOrEqual(play.byTurn[1]!);
  });
});

describe('opening hand quality', () => {
  const mk = (cards: Record<number, number>): DeckState => ({
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards,
  });
  const byId = byIdMap([
    makeCard({ id: 1, cost: 1 }),
    makeCard({ id: 6, cost: 6, inkwell: false, type: 'Action' }),
  ]);

  it('rates a healthy deck near certain and a dead deck near zero', () => {
    const good = openingHandQuality(mk({ 1: 60 }), byId)!;
    expect(good.keepableRate).toBeGreaterThan(0.95);
    const dead = openingHandQuality(mk({ 6: 60 }), byId)!;
    expect(dead.keepableRate).toBeLessThan(0.05);
    expect(dead.alteredShare).toBeGreaterThan(0.9);
  });

  it('is deterministic', () => {
    expect(
      openingHandQuality(mk({ 1: 40, 6: 20 }), byId, { trials: 500, seed: 3 }),
    ).toEqual(
      openingHandQuality(mk({ 1: 40, 6: 20 }), byId, { trials: 500, seed: 3 }),
    );
  });
});

describe('fingerprint', () => {
  const mk = (cards: Record<number, number>): DeckState => ({
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards,
  });
  const enabler = makeCard({
    id: 2,
    name: 'Christopher Robin - Joining the Fun',
    cost: 2,
    deckRuleEffects: [
      {
        kind: 'inkExemption',
        sourceCardId: 2,
        targetTypes: ['Character'],
        targetSubtypes: ['Hunny'],
        exceptSelf: true,
        note: 'GATHER THE PARTY',
      },
    ],
  });
  const shiftCard = makeCard({
    id: 3,
    name: 'Elsa',
    version: 'Spirit of Winter',
    keywords: ['Shift'],
    text: 'Shift 6 (You may pay 6 ⬡ to play this on top of one of your characters named Elsa.)',
  });
  const elsaBase = makeCard({ id: 4, name: 'Elsa', version: 'Snow Queen' });
  const byId = byIdMap([
    makeCard({ id: 1, cost: 1 }),
    enabler,
    shiftCard,
    elsaBase,
    makeCard({
      id: 5,
      cost: 4,
      inkwell: false,
      type: 'Action',
      tags: [{ tag: 'removal', by: 'rule' as const }],
    }),
  ]);

  it('composes a versioned fingerprint with closed-form redundancy', () => {
    const fp = computeFingerprint(mk({ 1: 44, 2: 4, 3: 4, 4: 4, 5: 4 }), byId)!;
    expect(fp.version).toBe(1);
    // seen by turn 2 on the play = 8 cards: P(≥1 of 4) = 1 - C(56,8)/C(60,8)
    const entry = fp.redundancy.find((r) => r.copies === 4)!;
    expect(entry.playableTurn).toBe(2);
    expect(entry.probability).toBeCloseTo(
      1 -
        (56 * 55 * 54 * 53 * 52 * 51 * 50 * 49) /
          (60 * 59 * 58 * 57 * 56 * 55 * 54 * 53),
      4,
    );
    expect(fp.interaction.removal).toBe(4);
    expect(fp.shiftCoverage).toEqual([
      { card: shiftCard.fullName, copies: 4, shiftable: true },
    ]);
  });

  it('flags Shift cards without a same-name target', () => {
    const fp = computeFingerprint(mk({ 1: 50, 3: 4, 5: 6 }), byId)!;
    expect(fp.shiftCoverage).toEqual([
      { card: shiftCard.fullName, copies: 4, shiftable: false },
    ]);
  });

  it('reports singer coverage per song cost band', () => {
    const song = makeCard({
      id: 10,
      name: 'Song',
      cost: 3,
      isSong: true,
      inkwell: false,
      type: 'Action',
    });
    const ids = byIdMap([
      makeCard({ id: 1, cost: 1 }),
      makeCard({ id: 2, cost: 5 }),
      song,
    ]);
    const fp = computeFingerprint(mk({ 1: 40, 2: 16, 10: 4 }), ids)!;
    // only the cost-5 characters can sing a cost-3 song
    expect(fp.singerCoverage).toEqual([{ songCost: 3, songs: 4, singers: 16 }]);
    expect(fp.redundancy).toEqual([]);
  });

  it('is null for an empty deck', () => {
    expect(computeFingerprint(mk({}), byId)).toBeNull();
  });
});

describe('lore-race goldfish', () => {
  const mk = (cards: Record<number, number>): DeckState => ({
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards,
  });
  const oneDrop = (id: number, evasive = false, wil = 2): Card =>
    makeCard({
      id,
      cost: 1,
      strength: 1,
      willpower: wil,
      lore: 1,
      keywords: evasive ? ['Evasive'] : [],
    });
  const ids = byIdMap([oneDrop(1), oneDrop(2, true), oneDrop(3, false, 2)]);

  it('quests only from dry characters — no lore on turn 1', () => {
    const r = simulateRace(mk({ 1: 60 }), ids, 'aggressive', {
      trials: 200,
      seed: 1,
      maxTurns: 3,
    })!;
    expect(r.loreByTurn[0]).toBe(0); // turn 1: characters are drying
    expect(r.loreByTurn[1]).toBeGreaterThan(0); // turn 2: first quests
  });

  it('a cheap deck races past the control baseline more often than the aggressive one', () => {
    const vsControl = simulateRace(mk({ 1: 30, 3: 30 }), ids, 'control', {
      trials: 1000,
      seed: 2,
    })!;
    const vsAggro = simulateRace(mk({ 1: 30, 3: 30 }), ids, 'aggressive', {
      trials: 1000,
      seed: 2,
    })!;
    expect(vsControl.winRate).toBeGreaterThan(vsAggro.winRate);
  });

  it('evasive questers survive challenges that would kill grounded ones', () => {
    const grounded = simulateRace(
      mk({ 1: 30, 3: 30 }),
      byIdMap([oneDrop(1), oneDrop(3)]),
      'aggressive',
      { trials: 2000, seed: 3 },
    )!;
    const evasive = simulateRace(
      mk({ 1: 30, 2: 30 }),
      byIdMap([oneDrop(1), oneDrop(2, true)]),
      'aggressive',
      { trials: 2000, seed: 3 },
    )!;
    expect(evasive.winRate).toBeGreaterThan(grounded.winRate);
  });

  it('ward boards shrug off the control baseline targeted removal', () => {
    const bare = byIdMap([makeCard({ id: 1, cost: 1, lore: 2 })]);
    const warded = byIdMap([
      makeCard({ id: 1, cost: 1, lore: 2, keywords: ['Ward'] }),
    ]);
    const plain = simulateRace(mk({ 1: 60 }), bare, 'control', {
      trials: 2000,
      seed: 4,
    })!;
    const wardedRun = simulateRace(mk({ 1: 60 }), warded, 'control', {
      trials: 2000,
      seed: 4,
    })!;
    expect(wardedRun.winRate).toBeGreaterThan(plain.winRate);
  });

  it('locations pay automatic lore every turn', () => {
    const loc = makeCard({
      id: 5,
      name: 'Loc',
      type: 'Location',
      cost: 2,
      inkwell: true,
      lore: 2,
    });
    const withLoc = simulateRace(
      mk({ 1: 50, 5: 10 }),
      byIdMap([oneDrop(1), loc]),
      'aggressive',
      { trials: 1000, seed: 5, maxTurns: 5 },
    )!;
    const without = simulateRace(
      mk({ 1: 60 }),
      byIdMap([oneDrop(1)]),
      'aggressive',
      { trials: 1000, seed: 5, maxTurns: 5 },
    )!;
    expect(withLoc.loreByTurn[3]).toBeGreaterThan(without.loreByTurn[3]!);
  });

  it('ending your turn with an empty library loses', () => {
    const r = simulateRace(mk({ 1: 5 }), byIdMap([oneDrop(1)]), 'control', {
      trials: 200,
      seed: 6,
    })!;
    expect(r.winRate).toBe(0);
  });

  it('is deterministic and null for an empty deck', () => {
    expect(
      simulateRace(mk({ 1: 60 }), byIdMap([oneDrop(1)]), 'midrange', {
        trials: 300,
        seed: 7,
      }),
    ).toEqual(
      simulateRace(mk({ 1: 60 }), byIdMap([oneDrop(1)]), 'midrange', {
        trials: 300,
        seed: 7,
      }),
    );
    expect(simulateRace(mk({}), byIdMap([oneDrop(1)]), 'midrange')).toBeNull();
  });
});

describe('fingerprint axes', () => {
  const mk = (cards: Record<number, number>): DeckState => ({
    title: 'T',
    inks: ['Amber'],
    format: 'core',
    cards,
  });
  const oneDrop = (id: number, lore = 1): Card =>
    makeCard({ id, cost: 1, lore });
  const bigDrop = (id: number): Card => makeCard({ id, cost: 6, lore: 3 });
  const interactionCard = (id: number): Card =>
    makeCard({
      id,
      cost: 3,
      inkwell: false,
      type: 'Action',
      tags: [{ tag: 'removal', by: 'rule' as const }],
    });

  it('an aggro curve scores higher Tempo than a top-heavy curve', () => {
    const byId = byIdMap([oneDrop(1), bigDrop(2)]);
    const aggro = computeFingerprint(mk({ 1: 56, 2: 4 }), byId)!;
    const heavy = computeFingerprint(mk({ 1: 16, 2: 44 }), byId)!;
    expect(aggro.axes.Tempo).toBeGreaterThan(heavy.axes.Tempo);
    expect(heavy.axes.Reach).toBeGreaterThan(aggro.axes.Reach);
  });

  it('interaction density saturates at ten copies', () => {
    const byId = byIdMap([oneDrop(1), interactionCard(2)]);
    const fp = computeFingerprint(mk({ 1: 50, 2: 10 }), byId)!;
    expect(fp.axes.Interaction).toBe(100);
  });

  it('is deterministic and empty-deck null', () => {
    const byId = byIdMap([oneDrop(1)]);
    expect(computeFingerprint(mk({ 1: 60 }), byId)).toEqual(
      computeFingerprint(mk({ 1: 60 }), byId),
    );
    expect(computeFingerprint(mk({}), byId)).toBeNull();
  });
});
