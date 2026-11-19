import { describe, expect, it } from 'vitest';
import type { DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { matchupEstimates, simulateRace } from './goldfish';

const mk = (cards: Record<number, number>): DeckState => ({
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards,
});

describe('lore-race fidelity', () => {
  it('a character that sang does not also quest that turn', () => {
    // two decks with identical costs/inkability and identical shuffles: in A
    // dry characters can sing songs, in B they can only quest. With singing
    // exerting the singer, A must quest no more than B on every turn — and
    // strictly less overall, because songs do get sung.
    const quester = makeCard({
      id: 1,
      name: 'Quester',
      cost: 2,
      lore: 3,
      willpower: 99,
      inkwell: true,
    });
    const song = makeCard({
      id: 2,
      name: 'Tune',
      cost: 2,
      isSong: true,
      type: 'Action',
      inkwell: true,
    });
    const blank = makeCard({
      id: 3,
      name: 'Blank',
      cost: 2,
      type: 'Action',
      inkwell: true,
    });
    const byId = byIdMap([quester, song, blank]);
    const opts = { trials: 800, seed: 11, maxTurns: 6 };
    const singing = simulateRace(mk({ 1: 30, 2: 30 }), byId, 'control', opts)!;
    const questOnly = simulateRace(
      mk({ 1: 30, 3: 30 }),
      byId,
      'control',
      opts,
    )!;
    for (let t = 0; t < 6; t++) {
      expect(singing.loreByTurn[t]!).toBeLessThanOrEqual(
        questOnly.loreByTurn[t]! + 1e-9,
      );
    }
    const sum = (r: typeof singing): number =>
      r.loreByTurn.reduce((s, l) => s + l, 0);
    expect(sum(singing)).toBeLessThan(sum(questOnly));
  });

  it('characters without the inkwell icon still quest', () => {
    // 555 characters lack the inkwell icon; it gates inking only, so these
    // characters must produce lore once played
    const hades = makeCard({
      id: 1,
      name: 'Hades',
      cost: 1,
      lore: 2,
      willpower: 99,
      inkwell: false,
    });
    const ink = makeCard({
      id: 2,
      name: 'Ink',
      cost: 1,
      type: 'Action',
      inkwell: true,
    });
    const race = simulateRace(
      mk({ 1: 40, 2: 20 }),
      byIdMap([hades, ink]),
      'aggressive',
      {
        trials: 500,
        seed: 5,
        maxTurns: 6,
      },
    )!;
    expect(race.loreByTurn.slice(0, 4).some((l) => l > 0)).toBe(true);
  });

  it('matchupEstimates returns null when no deck card resolves to the catalog', () => {
    // stale ids in saved storage used to crash the non-null assertion
    expect(matchupEstimates(mk({ 9999: 60 }), new Map())).toBeNull();
    const valid = makeCard({ id: 1, cost: 1 });
    expect(
      matchupEstimates(mk({ 1: 60 }), byIdMap([valid]), { trials: 10 }),
    ).toHaveLength(3);
  });
});
