/** League store/seeding/promotion tests — synthetic decks, no engine imports. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../prng';
import {
  type BaselineDeck,
  baselineProblems,
  candidateId,
  cardListDistance,
  deckSignature,
  type League,
  loadLeague,
  type MemberKind,
  promote,
  randomLegalDeck,
  saveLeague,
  seedLeague,
} from './league';

// ---- synthetic legal pool: 40 identities, max 3 copies each, single ink ----
const legalByIdentity = new Map<
  number,
  { maxCopies: number; inks: string[] }
>();
for (let id = 100; id < 140; id++) {
  legalByIdentity.set(id, {
    maxCopies: 3,
    inks: [id % 2 === 0 ? 'ruby' : 'sapphire'],
  });
}

const mkDeck = (pairs: Array<[number, number]>): Record<string, number> => {
  const cards: Record<string, number> = {};
  let total = 0;
  for (const [id, count] of pairs) {
    cards[String(id)] = count;
    total += count;
  }
  if (total !== 60) throw new Error(`test deck must total 60 (got ${total})`);
  return cards;
};

const seq = (start: number, end: number): Array<[number, number]> =>
  Array.from(
    { length: end - start + 1 },
    (_, i) => [start + i, 3] as [number, number],
  );

// 60-card fixtures, pairwise far apart (distance ≥ 30)
const deckLow = mkDeck(seq(100, 119));
const deckHigh = mkDeck(seq(120, 139));
const deckEven = mkDeck(seq(100, 138).filter(([id]) => id % 2 === 0));
const deckOdd = mkDeck(seq(101, 139).filter(([id]) => id % 2 === 1));
const deckFar = mkDeck([...seq(100, 109), ...seq(130, 139)]);
// 2 copies away from deckLow
const deckNear = mkDeck([...seq(101, 119), [100, 2], [120, 1]]);
// illegal: 59 cards (below the 60-card minimum) / identity outside the pool
const deck59: Record<string, number> = {};
for (const [id, count] of seq(101, 119)) deck59[String(id)] = count;
deck59['100'] = 2; // 57 + 2 = 59 cards — deliberately illegal
const deckGhost = mkDeck([...seq(102, 119), [100, 2], [101, 2], [999, 2]]);

const inksOf = (deck: Record<string, number>): string[] => {
  const inks = new Set<string>();
  for (const id of Object.keys(deck)) {
    for (const ink of legalByIdentity.get(Number(id))?.inks ?? [])
      inks.add(ink);
  }
  return [...inks].sort();
};

const asBaseline = (deck: Record<string, number>): BaselineDeck => ({
  cards: deck,
  inks: inksOf(deck),
});

const seedBase = (): Parameters<typeof seedLeague>[0] => ({
  realDecks: [
    { cards: deckLow, origin: 'corpus:topdeck:E1:2026-01-01' },
    { cards: deckHigh, origin: 'corpus:dotgg:E2:2026-01-02' },
  ],
  randomCount: 2,
  smartCount: 1,
  seed: 20261121,
  engineCommit: 'abcdef1234567890',
  legalByIdentity,
  generateRandom: () => null,
  generateSmart: () => null,
});

describe('deckSignature / candidateId', () => {
  it('pins the evolve/evolve-mutation hashing convention', () => {
    expect(deckSignature({ 7: 4, 3: 56 })).toBe('00000988');
    expect(deckSignature({ 1: 60 })).toBe('00000043');
    expect(deckSignature(deckLow)).toBe(deckSignature({ ...deckLow }));
    expect(deckSignature(deckLow)).not.toBe(deckSignature(deckHigh));
  });

  it('builds kind-prefixed ids with an optional occurrence suffix', () => {
    expect(candidateId('real', 'abc12345')).toBe('real:abc12345');
    expect(candidateId('selfplay', 'abc12345', 2)).toBe('selfplay:abc12345-2');
  });
});

describe('cardListDistance', () => {
  it('measures the symmetric difference over identity counts', () => {
    expect(cardListDistance(deckLow, deckLow)).toBe(0);
    expect(cardListDistance(deckNear, deckLow)).toBe(2);
    expect(cardListDistance(deckEven, deckOdd)).toBe(120);
    expect(cardListDistance({ 1: 3 }, {})).toBe(3);
  });
});

describe('seedLeague', () => {
  it('seeds real decks as kind "real" members and baselines alongside', () => {
    let randomCalls = 0;
    const opts = seedBase();
    opts.generateRandom = (): BaselineDeck | null =>
      [asBaseline(deckEven), asBaseline(deckOdd)][randomCalls++] ?? null;
    opts.generateSmart = () => asBaseline(deckFar);

    const { league, dropped } = seedLeague(opts);
    expect(dropped).toEqual({});
    expect(league.format).toBe('core');
    expect(league.engineCommit).toBe('abcdef1234567890');
    expect(league.members).toHaveLength(5);

    const byKind: Record<MemberKind, number> = {
      real: 0,
      'baseline-random': 0,
      'baseline-smart': 0,
      selfplay: 0,
    };
    for (const member of league.members) byKind[member.kind]++;
    expect(byKind).toEqual({
      real: 2,
      'baseline-random': 2,
      'baseline-smart': 1,
      selfplay: 0,
    });

    // real decks appear ONLY as kind 'real' members, verbatim as provided
    const realMembers = league.members.filter((m) => m.kind === 'real');
    expect(realMembers.map((m) => m.deck)).toEqual([deckLow, deckHigh]);
    expect(realMembers.map((m) => m.origin)).toEqual([
      'corpus:topdeck:E1:2026-01-01',
      'corpus:dotgg:E2:2026-01-02',
    ]);
    // and no baseline shares a real deck's signature (dedupe guarantee)
    const realSigs = new Set(realMembers.map((m) => deckSignature(m.deck)));
    for (const member of league.members) {
      if (member.kind !== 'real') {
        expect(realSigs.has(deckSignature(member.deck))).toBe(false);
      }
    }

    // uniform starting shares
    const totalShare = league.members.reduce((sum, m) => sum + m.share, 0);
    expect(totalShare).toBeCloseTo(1);
    for (const member of league.members) expect(member.share).toBeCloseTo(0.2);
  });

  it('drops duplicate and illegal baseline decks, counting the reasons', () => {
    const opts = seedBase();
    opts.realDecks = [{ cards: deckLow, origin: 'corpus:test:E1' }];
    opts.randomCount = 2;
    let randomCalls = 0;
    opts.generateRandom = (): BaselineDeck | null =>
      [asBaseline(deck59), asBaseline(deckGhost), asBaseline(deckEven)][
        randomCalls++
      ] ?? null;
    const { league, dropped } = seedLeague(opts);
    expect(league.members).toHaveLength(2); // 1 real + 1 admitted random
    expect(Object.keys(dropped)).toContain(
      'baseline-random-illegal:card-count-59',
    );
    expect(Object.keys(dropped)).toContain(
      'baseline-random-illegal:illegal-identity-999',
    );
  });

  it('drops real decks with a wrong card count', () => {
    const opts = seedBase();
    opts.realDecks = [{ cards: { 100: 59 }, origin: 'corpus:bad:E0' }];
    opts.randomCount = 0;
    opts.smartCount = 0;
    const { league, dropped } = seedLeague(opts);
    expect(league.members).toHaveLength(0);
    expect(dropped).toEqual({ 'real-card-count-59': 1 });
  });

  it('never skips the legality gate: legalByIdentity is required for baselines', () => {
    const opts = seedBase();
    opts.legalByIdentity = undefined;
    expect(() => seedLeague(opts)).toThrowError(
      'legality gate cannot be skipped',
    );
  });

  it('requires a smart generator when smart decks are requested', () => {
    const opts = seedBase();
    opts.generateSmart = undefined;
    expect(() => seedLeague(opts)).toThrowError('generateSmart is required');
  });
});

describe('baseline decks are legal by construction', () => {
  it('randomLegalDeck draws only from the legal pool and passes the gate', () => {
    for (const seed of [1, 42, 20261121]) {
      const deck = randomLegalDeck(legalByIdentity, mulberry32(seed));
      expect(deck).not.toBeNull();
      expect(baselineProblems(deck!, legalByIdentity)).toEqual([]);
    }
  });
});

describe('league file round-trip', () => {
  it('save → load reproduces the league byte-for-byte', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'league-'));
    const { league } = seedLeague(seedBase());
    const filePath = await saveLeague(league, dir);
    expect(path.basename(filePath)).toBe('league-abcdef12.json');
    const loaded = await loadLeague(filePath);
    expect(loaded).toEqual(league);
  });

  it('rejects malformed league files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'league-'));
    const filePath = path.join(dir, 'league-bad00000.json');
    await writeFile(filePath, '{"format":"core"}\n');
    await expect(loadLeague(filePath)).rejects.toThrowError(
      'not a valid league file',
    );
  });
});

describe('promote', () => {
  const baseLeague = (): League => {
    let randomCalls = 0;
    const { league } = seedLeague({
      realDecks: [
        { cards: deckLow, origin: 'corpus:test:E1' },
        { cards: deckHigh, origin: 'corpus:test:E2' },
      ],
      randomCount: 1,
      smartCount: 1,
      seed: 7,
      engineCommit: 'abcdef12',
      legalByIdentity,
      generateRandom: (): BaselineDeck | null =>
        [asBaseline(deckEven)][randomCalls++] ?? null,
      generateSmart: () => asBaseline(deckOdd),
    });
    return league;
  };

  it('adds the winner as a selfplay member and rebalances shares', () => {
    const league = baseLeague();
    expect(league.members).toHaveLength(4);
    const result = promote(league, deckFar, 0.7, {
      origin: 'mapelites:g42',
    });
    expect(result.promoted).toBe(true);
    expect(result.league.members).toHaveLength(5);
    const added = result.league.members.at(-1)!;
    expect(added.kind).toBe('selfplay');
    expect(added.id).toBe(`selfplay:${deckSignature(deckFar)}`);
    expect(added.share).toBeCloseTo(1 / 5);
    expect(added.score).toBe(0.7);
    expect(added.origin).toBe('mapelites:g42');
    // incumbents scaled by 4/5: 0.25 → 0.2, shares still sum to 1
    for (const member of result.league.members.slice(0, 4)) {
      expect(member.share).toBeCloseTo(0.2);
    }
    const totalShare = result.league.members.reduce((s, m) => s + m.share, 0);
    expect(totalShare).toBeCloseTo(1);
  });

  it('rejects a near-duplicate of an existing member', () => {
    const league = baseLeague();
    const result = promote(league, deckNear, 0.9);
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('near-duplicate');
    expect(result.distance).toBe(2);
    expect(result.nearestId).toBe(`real:${deckSignature(deckLow)}`);
    // league returned unchanged
    expect(result.league).toBe(league);
    expect(result.league.members).toHaveLength(4);
  });

  it('rejects exact duplicates (distance 0) even with threshold 0', () => {
    const league = baseLeague();
    const result = promote(league, deckLow, 0.9, { distanceThreshold: 0 });
    expect(result.promoted).toBe(false);
    expect(result.distance).toBe(0);
  });

  it('honours a lowered threshold and a custom share', () => {
    const league = baseLeague();
    const result = promote(league, deckNear, 0.8, {
      distanceThreshold: 1,
      share: 0.5,
    });
    expect(result.promoted).toBe(true);
    const added = result.league.members.at(-1)!;
    expect(added.share).toBe(0.5);
    for (const member of result.league.members.slice(0, 4)) {
      expect(member.share).toBeCloseTo(0.125);
    }
  });
});
