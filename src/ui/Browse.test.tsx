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

describe('browse filtering and pagination', () => {
  const alpha = Array.from({ length: 70 }, (_, i) =>
    makeCard({ id: 1000 + i, name: `Alpha ${i}`, inks: ['Amber'] }),
  );
  const beta = Array.from({ length: 5 }, (_, i) =>
    makeCard({ id: 2000 + i, name: `Beta ${i}`, inks: ['Ruby'] }),
  );
  const bigCatalog = [...alpha, ...beta];
  const tileCount = (): number => document.querySelectorAll('.tile').length;
  const resultCount = (): string =>
    document.querySelector('.resultcount')?.textContent ?? '';

  const renderBig = (): void => {
    mockedUseApp.mockReturnValue({
      cards: bigCatalog,
      deck: { title: 'T', inks: [], format: 'core', cards: {} },
      addCard: vi.fn(),
      byId: byIdMap(bigCatalog),
    } as unknown as ReturnType<typeof useApp>);
    render(<Browse />);
  };

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('combines ink and free-text filters', () => {
    renderBig();
    expect(resultCount()).toBe('75 cards');
    fireEvent.change(screen.getByPlaceholderText('Search name or text…'), {
      target: { value: 'Alpha' },
    });
    expect(resultCount()).toBe('70 cards');
    fireEvent.click(screen.getByRole('button', { name: 'Ruby' }));
    expect(resultCount()).toBe('0 cards');
    fireEvent.change(screen.getByPlaceholderText('Search name or text…'), {
      target: { value: '' },
    });
    expect(resultCount()).toBe('5 cards');
    expect(tileCount()).toBe(5);
  });

  it('reveals the next page on Show more and resets pagination on filter change', () => {
    renderBig();
    expect(tileCount()).toBe(60);
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more' }));
    expect(tileCount()).toBe(75);
    fireEvent.change(screen.getByPlaceholderText('Search name or text…'), {
      target: { value: 'Alpha 1' },
    });
    // Alpha 1 + Alpha 10..19 = 11 matches, back to a single page
    expect(tileCount()).toBe(11);
    expect(screen.queryByRole('button', { name: /Show .* more/ })).toBeNull();
  });
});

describe('browse filter drawer (mobile)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('toggles the select group and counts active filters', () => {
    mockedUseApp.mockReturnValue({
      cards: catalog,
      deck: { title: 'T', inks: [], format: 'core', cards: {} },
      addCard: vi.fn(),
      byId: byIdMap(catalog),
    } as unknown as ReturnType<typeof useApp>);
    render(<Browse />);
    const toggle = screen.getByRole('button', { name: 'Filters' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // the fixture catalog's only franchise
    fireEvent.change(screen.getByDisplayValue('All franchises'), {
      target: { value: 'Test Story' },
    });
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    expect(
      screen
        .getByRole('button', { name: /Filters/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });
});
