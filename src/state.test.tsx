/** @vitest-environment jsdom */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSnapshot } from './data/load';
import type { DeckState, SnapshotMeta } from './data/types';
import { encodeDeck, STORAGE_KEY } from './deck/codec';
import { AppProvider, useApp } from './state';
import { makeCard } from './test/fixtures';

vi.mock('./data/load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./data/load')>()),
  loadSnapshot: vi.fn(),
}));

const meta: SnapshotMeta = {
  generatedOn: '2026-11-19T00:00:00Z',
  cardCount: 1,
  sources: { lorcanajson: {}, lorcast: { fetched: false } },
  tagRulesVersion: 1,
};
const snapshot = {
  cards: [makeCard({ id: 1, name: 'Aladdin', version: 'Heroic Outlaw' })],
  sets: [],
  meta,
};

const saved: DeckState = {
  title: 'Saved deck',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 2 },
};
const shared: DeckState = {
  title: 'Shared deck',
  inks: ['Ruby'],
  format: 'infinity',
  cards: { 1: 3 },
};

let current: ReturnType<typeof useApp>;
function Probe(): ReactNode {
  current = useApp();
  return null;
}
const renderApp = (): void => {
  render(
    <AppProvider>
      <Probe />
    </AppProvider>,
  );
};
const ready = async (): Promise<void> => {
  await waitFor(() => expect(current.status).toBe('ready'));
};

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.mocked(loadSnapshot).mockResolvedValue(snapshot);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('state restore and persistence', () => {
  it('a shared URL wins over localStorage, then the param is stripped', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    window.history.replaceState(null, '', `/?d=${encodeDeck(shared)}`);
    renderApp();
    await ready();
    expect(current.deck.title).toBe('Shared deck');
    expect(current.deck.format).toBe('infinity');
    expect(window.location.search).toBe('');
  });

  it('edits after opening a shared link survive a reload', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    window.history.replaceState(null, '', `/?d=${encodeDeck(shared)}#/deck`);
    renderApp();
    await ready();
    act(() => current.setTitle('Edited title'));
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(persisted.title).toBe('Edited title');
    // reload: the shared param is gone, so localStorage is the source
    cleanup();
    renderApp();
    await ready();
    expect(current.deck.title).toBe('Edited title');
    expect(current.deck.cards).toEqual(shared.cards);
  });

  it('a corrupt share payload falls back to the saved deck', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    window.history.replaceState(null, '', '/?d=not-a-deck!!!');
    renderApp();
    await ready();
    expect(current.deck.title).toBe('Saved deck');
    expect(current.deck.cards).toEqual(saved.cards);
  });

  it('a storage write failure does not break adding cards', async () => {
    const spy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      });
    renderApp();
    await ready();
    act(() => {
      expect(current.addCard(1)).toEqual({ status: 'added' });
    });
    expect(current.deck.cards[1]).toBe(1);
    spy.mockRestore();
  });
});
