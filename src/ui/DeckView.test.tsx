/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const addCardMock = vi.fn();
const replaceDeckMock = vi.fn();
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
    replaceDeck: replaceDeckMock,
    addCard: (id: number) => {
      const result = addCardMock(id);
      if (result?.status === 'added') {
        setDeck((d) => ({
          ...d,
          cards: { ...d.cards, [id]: (d.cards[id] ?? 0) + 1 },
        }));
      }
      return result;
    },
  } as unknown as ReturnType<typeof useApp>);
  return <DeckView />;
}

beforeEach(() => {
  addCardMock.mockReturnValue({ status: 'added' });
});

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
    fireEvent.click(
      screen.getByRole('button', { name: 'Add one copy of Aladdin' }),
    );
    expect(vi.mocked(curveConsistency)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(computeStats)).toHaveBeenCalledTimes(2);
  });
});

describe('DeckView core loop', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('gates row + through the single add path and clears the refusal on success', () => {
    addCardMock.mockReturnValue({
      status: 'refused',
      reason: 'Copy limit reached (4/4 in deck)',
    });
    render(<Harness />);
    const addButton = screen.getByRole('button', {
      name: 'Add one copy of Aladdin',
    });
    fireEvent.click(addButton);
    expect(screen.getByText('Copy limit reached (4/4 in deck)')).toBeTruthy();
    addCardMock.mockReturnValue({ status: 'added' });
    fireEvent.click(addButton);
    expect(screen.queryByText('Copy limit reached (4/4 in deck)')).toBeNull();
  });

  it('imports text, preserving title and reporting unmatched lines', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.change(document.querySelector('textarea')!, {
      target: { value: '4x Aladdin\n2x Nonexistent Card' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import text' }));
    expect(replaceDeckMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'A',
        inks: ['Amber'],
        cards: { 1: 4 },
      }),
    );
    expect(
      screen.getByText(
        /Imported with 1 unmatched line\(s\): 2x Nonexistent Card/,
      ),
    ).toBeTruthy();
  });

  it('copies the encoded share URL to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    expect(
      await screen.findByText('Share link copied to clipboard.'),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('?d='));
    expect(writeText.mock.calls[0]![0]).toContain('#/deck');
  });

  it('shows the link in the export box when the clipboard fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    expect(
      await screen.findByText(
        'Clipboard unavailable — copy the share link below.',
      ),
    ).toBeTruthy();
    expect(
      (document.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toContain('?d=');
  });
});
