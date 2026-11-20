/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import type { SnapshotMeta } from './data/types';
import { STORAGE_KEY } from './deck/codec';
import { makeCard } from './test/fixtures';

const meta: SnapshotMeta = {
  generatedOn: '2026-11-19T00:00:00Z',
  cardCount: 2,
  sources: { lorcanajson: {}, lorcast: { fetched: false } },
  tagRulesVersion: 1,
};
const snapshot = {
  cards: [
    makeCard({ id: 1, name: 'Aladdin' }),
    makeCard({ id: 2, name: 'Elsa' }),
  ],
  sets: [],
  meta,
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('App shell', () => {
  it('defaults to the Browse tab', async () => {
    render(<App snapshot={snapshot} />);
    const browse = await screen.findByRole('button', { name: 'Browse' });
    expect(browse.getAttribute('aria-current')).toBe('page');
  });

  it('follows hash navigation in both directions', async () => {
    window.history.replaceState(null, '', '/#/deck');
    render(<App snapshot={snapshot} />);
    const deckTab = await screen.findByRole('button', { name: /^Deck/ });
    expect(deckTab.getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: 'Generator' }));
    expect(window.location.hash).toBe('#/generate');
    expect(
      screen
        .getByRole('button', { name: 'Generator' })
        .getAttribute('aria-current'),
    ).toBe('page');

    window.location.hash = '#/browse';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(
      screen
        .getByRole('button', { name: 'Browse' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('shows the violation badge and card count for an illegal saved deck', async () => {
    // 5 copies of a 4-max card and below 60 cards: two violations
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        title: 'T',
        inks: ['Amber'],
        format: 'core',
        cards: { 1: 5 },
      }),
    );
    render(<App snapshot={snapshot} />);
    const deckBtn = await screen.findByRole('button', { name: /^Deck/ });
    // badge and count pill are plain spans inside the Deck nav button
    const pills = deckBtn.querySelectorAll('span');
    expect(pills[0]?.textContent).toBe('2');
    expect(pills[1]?.textContent).toBe('5');
  });
});
