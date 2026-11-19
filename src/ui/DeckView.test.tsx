/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeckState } from '../data/types';
import { useApp } from '../state';
import { curveConsistency } from '../stats/curve';
import { computeStats } from '../stats/stats';
import { byIdMap, makeCard } from '../test/fixtures';
import { DeckView } from './DeckView';

vi.mock('../state', () => ({ useApp: vi.fn() }));
vi.mock('../stats/curve', () => ({ curveConsistency: vi.fn(() => null) }));
vi.mock('../stats/fingerprint', () => ({
  computeFingerprintCached: vi.fn(() => null),
}));
vi.mock('../stats/stats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stats/stats')>();
  return { ...actual, computeStats: vi.fn(actual.computeStats) };
});
vi.mock('../meta/infer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../meta/infer')>()),
  loadMetaModel: vi.fn(async () => null),
}));

const mockedUseApp = vi.mocked(useApp);
const catalog = [makeCard({ id: 1, name: 'Aladdin' })];
const byId = byIdMap(catalog);
const baseDeck: DeckState = {
  title: 'A',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 4 },
};

/** real state updates through the view's own handlers, no direct rerender tricks */
function Harness(): ReactNode {
  const [deck, setDeck] = useState(baseDeck);
  mockedUseApp.mockReturnValue({
    cards: catalog,
    byId,
    deck,
    meta: null,
    setTitle: (title: string) => setDeck((d) => ({ ...d, title })),
    setCount: (id: number, count: number) =>
      setDeck((d) => ({ ...d, cards: { ...d.cards, [id]: count } })),
    setInks: vi.fn(),
    setFormat: vi.fn(),
    removeCard: vi.fn(),
    replaceDeck: vi.fn(),
    addCard: vi.fn(),
  } as unknown as ReturnType<typeof useApp>);
  return <DeckView />;
}

describe('DeckView render performance', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not re-run the curve simulation or stats on title-only edits', () => {
    render(<Harness />);
    expect(vi.mocked(curveConsistency)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(computeStats)).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByDisplayValue('A'), {
      target: { value: 'Renamed deck' },
    });
    expect(screen.getByDisplayValue('Renamed deck')).toBeTruthy();
    // used to re-run 20k Monte Carlo trials + full stats per keystroke
    expect(vi.mocked(curveConsistency)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(computeStats)).toHaveBeenCalledTimes(1);
  });

  it('re-runs the simulation and stats when deck cards change', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    expect(vi.mocked(curveConsistency)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(computeStats)).toHaveBeenCalledTimes(2);
  });
});
