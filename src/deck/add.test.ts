import { describe, expect, it } from 'vitest';
import type { DeckState } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { applyAdd } from './add';

const deck = (
  inks: ('Amber' | 'Ruby' | 'Sapphire')[],
  cards: Record<number, number> = {},
): DeckState => ({
  title: 'T',
  inks,
  format: 'core',
  cards,
});

describe('applyAdd — the single add path (card-first creation)', () => {
  it('auto-declares the first ink from the card', () => {
    const ruby = makeCard({ id: 1, name: 'Ruby Card', inks: ['Ruby'] });
    const { deck: next, result } = applyAdd(
      deck([], {}),
      ruby,
      byIdMap([ruby]),
    );
    expect(result).toEqual({ status: 'added' });
    expect(next.inks).toEqual(['Ruby']);
    expect(next.cards[1]).toBe(1);
  });

  it('emerges the second ink from a card that needs it', () => {
    const ruby = makeCard({ id: 1, name: 'Ruby Card', inks: ['Ruby'] });
    const sapphire = makeCard({
      id: 2,
      name: 'Sapphire Card',
      inks: ['Sapphire'],
    });
    const byId = byIdMap([ruby, sapphire]);
    const start = deck(['Ruby'], { 1: 4 });
    const { deck: next, result } = applyAdd(start, sapphire, byId);
    expect(result).toEqual({ status: 'added' });
    expect(next.inks).toEqual(['Ruby', 'Sapphire']);
  });

  it('auto-declares both inks of a dual-ink card', () => {
    const dual = makeCard({
      id: 3,
      name: 'Dual Card',
      inks: ['Amber', 'Ruby'],
    });
    const { deck: next, result } = applyAdd(
      deck([], {}),
      dual,
      byIdMap([dual]),
    );
    expect(result).toEqual({ status: 'added' });
    expect(next.inks).toEqual(['Amber', 'Ruby']);
  });

  it('refuses a third ink with the off-ink reason, identically everywhere', () => {
    const amber = makeCard({ id: 4, name: 'Amber Card', inks: ['Amber'] });
    const byId = byIdMap([amber]);
    const { deck: next, result } = applyAdd(
      deck(['Ruby', 'Sapphire'], {}),
      amber,
      byId,
    );
    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain(
      'outside the declared inks',
    );
    expect(next.inks).toEqual(['Ruby', 'Sapphire']);
    expect(next.cards[4]).toBeUndefined();
  });

  it('refuses beyond the copy limit with the engine reason', () => {
    const ruby = makeCard({ id: 1, name: 'Ruby Card', inks: ['Ruby'] });
    const byId = byIdMap([ruby]);
    const { deck: next, result } = applyAdd(
      deck(['Ruby'], { 1: 4 }),
      ruby,
      byId,
    );
    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain(
      'Copy limit reached',
    );
    expect(next.cards[1]).toBe(4);
  });

  it('adds every copy up to the limit (1st through 4th)', () => {
    const ruby = makeCard({ id: 1, name: 'Ruby Card', inks: ['Ruby'] });
    const byId = byIdMap([ruby]);
    let current = deck(['Ruby'], {});
    for (let n = 1; n <= 4; n++) {
      const { deck: next, result } = applyAdd(current, ruby, byId);
      expect(result).toEqual({ status: 'added' });
      expect(next.cards[1]).toBe(n);
      current = next;
    }
    const { result } = applyAdd(current, ruby, byId);
    expect(result.status).toBe('refused');
  });

  it('shares the copy budget across prints of the same full name', () => {
    const normal = makeCard({ id: 600, name: 'Belle', version: 'Mechanic' });
    const special = makeCard({ id: 601, name: 'Belle', version: 'Mechanic' });
    const byId = byIdMap([normal, special]);
    // 3 copies of one print: the fourth copy of the other print is legal
    const { result: fourth } = applyAdd(
      deck(['Amber'], { 600: 3 }),
      special,
      byId,
    );
    expect(fourth).toEqual({ status: 'added' });
    const { result: fifth } = applyAdd(
      deck(['Amber'], { 600: 2, 601: 2 }),
      special,
      byId,
    );
    expect(fifth.status).toBe('refused');
  });

  it('refuses an unlimited print when a limited sibling already caps the group', () => {
    const limited = makeCard({ id: 700, name: 'Bots', maxCopies: 4 });
    const unlimited = makeCard({
      id: 701,
      name: 'Bots',
      maxCopies: 'unlimited',
    });
    const byId = byIdMap([limited, unlimited]);
    // 4 limited copies in the deck: the unlimited reprint may not exceed them
    const { result } = applyAdd(deck(['Amber'], { 700: 4 }), unlimited, byId);
    expect(result.status).toBe('refused');
    const { result: withinLimit } = applyAdd(
      deck(['Amber'], { 700: 3 }),
      unlimited,
      byId,
    );
    expect(withinLimit).toEqual({ status: 'added' });
  });

  it('refuses an out-of-format card', () => {
    const quest = makeCard({
      id: 5,
      name: 'Quest Card',
      setType: 'quest',
      formats: { core: false, infinity: true },
    });
    const { result } = applyAdd(deck([], {}), quest, byIdMap([quest]));
    expect(result.status).toBe('refused');
    expect((result as { reason: string }).reason).toContain(
      'not tournament-legal',
    );
  });
});
