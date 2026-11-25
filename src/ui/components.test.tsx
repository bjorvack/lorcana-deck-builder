/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../data/types';
import { useApp } from '../state';
import { makeCard } from '../test/fixtures';
import { CardModal, CardTile } from './components';

vi.mock('../state', () => ({ useApp: vi.fn() }));
const mockedUseApp = vi.mocked(useApp);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CardTile image fallback', () => {
  it('falls back to the alt image when the thumb fails', () => {
    const card = makeCard({ id: 1 });
    card.images.alt = 'https://example.com/alt.png';
    render(<CardTile card={card} onOpen={() => {}} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://example.com/alt.png',
    );
  });

  it('shows the placeholder once every image candidate has failed', () => {
    const card = makeCard({ id: 1 });
    card.images.alt = 'https://example.com/alt.png';
    render(<CardTile card={card} onOpen={() => {}} />);
    fireEvent.error(screen.getByRole('img'));
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    // placeholder (new text node) + tile name
    expect(screen.getAllByText(card.fullName)).toHaveLength(2);
  });

  it('uses the alt image when no thumb exists', () => {
    const card = makeCard({ id: 1 });
    card.images.thumb = undefined;
    card.images.alt = 'https://example.com/alt.png';
    render(<CardTile card={card} onOpen={() => {}} />);
    expect(screen.getByRole('img').getAttribute('src')).toBe(
      'https://example.com/alt.png',
    );
  });

  it('shows supported format labels', () => {
    const card = makeCard({
      id: 1,
      formats: { core: true, infinity: false },
    });
    render(<CardTile card={card} onOpen={() => {}} />);
    expect(screen.getByText(/Set 1 · Common · Core/)).toBeDefined();
  });

  it('uses the provided formats prop over the card formats', () => {
    const card = makeCard({
      id: 1,
      formats: { core: true, infinity: false },
    });
    render(
      <CardTile
        card={card}
        onOpen={() => {}}
        formats={{ core: false, infinity: true }}
      />,
    );
    expect(screen.getByText(/Set 1 · Common · Infinity/)).toBeDefined();
    expect(screen.queryByText(/ · Core/)).toBeNull();
  });
});

const mockApp = (
  card: Card,
  overrides: Partial<ReturnType<typeof useApp>> = {},
) => {
  const cards = (overrides.cards as Card[] | undefined) ?? [card];
  const byId =
    (overrides.byId as Map<number, Card> | undefined) ??
    new Map(cards.map((c) => [c.id, c]));
  return {
    addCard: vi.fn(() => ({ status: 'added' }) as const),
    removeCard: vi.fn(),
    setCount: vi.fn(),
    swapCardVersion: vi.fn(() => ({ status: 'added' }) as const),
    deck: { title: '', inks: [], format: 'core', cards: {} },
    cards,
    byId,
    ...overrides,
  } as unknown as ReturnType<typeof useApp>;
};

describe('CardModal', () => {
  it('surfaces the gated-add refusal reason inline', () => {
    const card = makeCard({ id: 1 });
    mockedUseApp.mockReturnValue(
      mockApp(card, {
        addCard: vi.fn(
          () =>
            ({
              status: 'refused',
              reason: 'Copy limit reached (4/4 in deck)',
            }) as const,
        ),
      }),
    );
    render(<CardModal card={card} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to deck' }));
    expect(screen.getByText('Copy limit reached (4/4 in deck)')).toBeTruthy();
  });

  it('closes on Escape, backdrop click and the Close button', () => {
    const onClose = vi.fn();
    const card = makeCard({ id: 1 });
    mockedUseApp.mockReturnValue(mockApp(card));
    const { container } = render(<CardModal card={card} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('[role="presentation"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('has an always-visible ✕ that closes the dialog', () => {
    const onClose = vi.fn();
    const card = makeCard({ id: 1 });
    mockedUseApp.mockReturnValue(mockApp(card));
    render(<CardModal card={card} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close card details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the dialog on open', () => {
    const card = makeCard({ id: 1 });
    mockedUseApp.mockReturnValue(mockApp(card));
    render(<CardModal card={card} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('shows a version selector when multiple prints share the same full name', () => {
    const base = makeCard({ id: 1, name: 'Hero', setCode: '1' });
    const reprint = makeCard({
      id: 2,
      name: 'Hero',
      setCode: '2',
      releasedAt: '2024-06-01',
    });
    mockedUseApp.mockReturnValue(mockApp(base, { cards: [base, reprint] }));
    render(<CardModal card={base} onClose={() => {}} />);
    expect(screen.getByRole('combobox')).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBe(2);
  });

  it('calls addCard when adding the first copy and swapCardVersion to switch versions', () => {
    const base = makeCard({ id: 1, name: 'Hero', setCode: '1' });
    const reprint = makeCard({
      id: 2,
      name: 'Hero',
      setCode: '2',
      releasedAt: '2024-06-01',
    });
    const addCard = vi.fn(() => ({ status: 'added' }) as const);
    const swapCardVersion = vi.fn(() => ({ status: 'added' }) as const);
    mockedUseApp.mockReturnValue(
      mockApp(base, {
        cards: [base, reprint],
        deck: {
          title: '',
          inks: ['Amber'],
          format: 'core',
          cards: { [base.id]: 2 },
        },
        addCard,
        swapCardVersion,
      }),
    );
    render(<CardModal card={base} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: String(reprint.id) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this version' }));
    expect(swapCardVersion).toHaveBeenCalledWith(base.id, reprint.id);
  });

  it('increments and decrements copies of the selected version', () => {
    const card = makeCard({ id: 1 });
    const addCard = vi.fn(() => ({ status: 'added' }) as const);
    const setCount = vi.fn();
    mockedUseApp.mockReturnValue(
      mockApp(card, {
        deck: {
          title: '',
          inks: ['Amber'],
          format: 'core',
          cards: { [card.id]: 2 },
        },
        addCard,
        setCount,
      }),
    );
    render(<CardModal card={card} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add one copy' }));
    expect(addCard).toHaveBeenCalledWith(card.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove one copy' }));
    expect(setCount).toHaveBeenCalledWith(card.id, 1);
  });
});
