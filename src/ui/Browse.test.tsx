/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, DeckState } from '../data/types';
import { useApp } from '../state';
import { byIdMap, makeCard } from '../test/fixtures';
import { Browse } from './Browse';

vi.mock('../state', () => ({ useApp: vi.fn() }));
vi.mock('../meta/infer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../meta/infer')>()),
  loadMetaModel: vi.fn(async () => null), // no artifact: text-only scoring + snapshot-derived hints
}));

const mockedUseApp = vi.mocked(useApp);

const fillers: Card[] = Array.from(
  { length: 12 },
  (_, i) => makeCard({ id: 100 + i, name: `Filler ${i}`, inks: ['Amber'] }), // off-ink for the Ruby deck → never suggested
);
const hiro = makeCard({ id: 2, name: 'Hiro - Armor Designer', inks: ['Ruby'] });
const shiftCard: Card = {
  ...makeCard({
    id: 10,
    name: 'Hiro - Band Leader',
    inks: ['Ruby'],
    keywords: ['Shift'],
  }),
  payoffs: [
    {
      kind: 'shift',
      variant: 'named',
      cost: { mode: 'ink', amount: 3 },
      names: ['Hiro'],
    },
  ],
} as Card;
const catalog = [shiftCard, hiro, ...fillers];

const renderBrowse = (deck: DeckState): void => {
  mockedUseApp.mockReturnValue({
    cards: catalog,
    deck,
    addCard: vi.fn(() => ({ status: 'added' }) as const),
    byId: byIdMap(catalog),
  } as unknown as ReturnType<typeof useApp>);
  render(<Browse />);
};

describe('browse suggestion strip (card-first)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('is collapsed by default and hidden with an empty deck', () => {
    renderBrowse({ title: 'T', inks: [], format: 'core', cards: {} });
    expect(screen.queryByTestId('browse-suggestions-toggle')).toBeNull();
  });

  it('shows the toggle with a non-empty deck and payoff hints work without an artifact', () => {
    renderBrowse({
      title: 'T',
      inks: ['Ruby'],
      format: 'core',
      cards: { 10: 4, 100: 26 },
    });
    fireEvent.click(screen.getByTestId('browse-suggestions-toggle'));
    const rows = screen.getAllByTestId('suggestion-row');
    expect(rows.length).toBeGreaterThan(0);
    // the shift card's target (Hiro - Armor Designer) is in the deck → hint
    const hinted = screen.queryByTestId('suggestion-hint');
    expect(hinted).not.toBeNull();
    expect(hinted!.textContent).toContain(
      'completes the Shift target for Hiro',
    );
  });
});
