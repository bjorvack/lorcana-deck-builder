import { describe, expect, it } from 'vitest';
import type { DeckState, Ink } from '../data/types';
import { byIdMap, makeCard } from '../test/fixtures';
import { applyVersionSwap } from './version';

const deck = (inks: Ink[], cards: Record<number, number> = {}): DeckState => ({
  title: 'T',
  inks,
  format: 'core',
  cards,
});

describe('applyVersionSwap', () => {
  it('is a no-op when the ids are the same', () => {
    const card = makeCard({ id: 1 });
    const start = deck(['Amber'], { 1: 2 });
    const { deck: next, result } = applyVersionSwap(
      start,
      1,
      1,
      byIdMap([card]),
    );
    expect(result).toEqual({ status: 'added' });
    expect(next).toEqual(start);
  });

  it('returns unknown when the target print is missing', () => {
    const from = makeCard({ id: 1 });
    const start = deck(['Amber'], { 1: 2 });
    const { deck: next, result } = applyVersionSwap(
      start,
      1,
      2,
      byIdMap([from]),
    );
    expect(result).toEqual({ status: 'unknown' });
    expect(next).toEqual(start);
  });

  it('refuses to swap prints that are not the same card', () => {
    const from = makeCard({ id: 1, name: 'A' });
    const to = makeCard({ id: 2, name: 'B' });
    const start = deck(['Amber'], { 1: 2 });
    const { deck: next, result } = applyVersionSwap(
      start,
      1,
      2,
      byIdMap([from, to]),
    );
    expect(result).toEqual({ status: 'refused', reason: 'Not the same card' });
    expect(next).toEqual(start);
  });

  it('is a no-op when there are no copies to swap', () => {
    const from = makeCard({ id: 1 });
    const to = makeCard({ id: 2, name: 'Test Card' });
    const start = deck(['Amber'], { 1: 0 });
    const { deck: next, result } = applyVersionSwap(
      start,
      1,
      2,
      byIdMap([from, to]),
    );
    expect(result).toEqual({ status: 'added' });
    expect(next).toEqual(start);
  });

  it('moves all copies to the target print', () => {
    const from = makeCard({ id: 1 });
    const to = makeCard({ id: 2, name: 'Test Card', setCode: '2' });
    const start = deck(['Amber'], { 1: 3 });
    const { deck: next, result } = applyVersionSwap(
      start,
      1,
      2,
      byIdMap([from, to]),
    );
    expect(result).toEqual({ status: 'added' });
    expect(next.cards[1]).toBeUndefined();
    expect(next.cards[2]).toBe(3);
  });

  it('returns the original deck when the target cannot be added', () => {
    const from = makeCard({ id: 1 });
    const to = makeCard({ id: 2, name: 'Test Card', inks: ['Sapphire'] });
    const start = deck(['Amber', 'Ruby'], { 1: 2 });
    const { deck: next, result } = applyVersionSwap(
      start,
      1,
      2,
      byIdMap([from, to]),
    );
    expect(result.status).toBe('refused');
    expect(next).toEqual(start);
  });
});
