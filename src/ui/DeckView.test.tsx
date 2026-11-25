/** @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, DeckState } from '../data/types';
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
// the engine winrate run is not under test here (its own test file covers it)
vi.mock('../stats/engine-winrate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stats/engine-winrate')>()),
  estimateEngineWinrate: vi.fn(async () => null),
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
function Harness({
  deck: initial = baseDeck,
}: {
  deck?: DeckState;
}): ReactNode {
  const [deck, setDeck] = useState(initial);
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
    swapCardVersion: vi.fn(),
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

  it('copies the live share URL to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    window.history.replaceState(null, '', '/?d=abc123#/deck');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    expect(
      await screen.findByText('Share link copied to clipboard.'),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(window.location.href);
  });

  it('offers the native share sheet when the Web Share API is available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', {
      value: share,
      configurable: true,
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    window.history.replaceState(null, '', '/?d=abc123#/deck');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({
        title: 'A',
        url: window.location.href,
      }),
    );
    // the sheet was handled: no clipboard write, no export box
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText('Share link copied to clipboard.')).toBeNull();
    delete (navigator as unknown as { share?: unknown }).share;
  });

  it('a dismissed share sheet is not an error and offers no fallback', async () => {
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException('user aborted', 'AbortError'));
    Object.defineProperty(navigator, 'share', {
      value: share,
      configurable: true,
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect(screen.queryByText(/copy the share link below/)).toBeNull();
    delete (navigator as unknown as { share?: unknown }).share;
  });

  it('shows the link in the export box when the clipboard fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    window.history.replaceState(null, '', '/?d=abc123#/deck');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }));
    expect(
      await screen.findByText(
        'Clipboard unavailable — copy the share link below.',
      ),
    ).toBeTruthy();
    expect(
      (document.querySelector('textarea') as HTMLTextAreaElement).value,
    ).toContain('?d=abc123');
  });
});

describe('DeckView mobile and empty states', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens the card modal when a deck row name is tapped', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Aladdin' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Aladdin');
  });

  it('shows a start-building panel instead of zeroed stats for an empty deck', () => {
    render(
      <Harness deck={{ title: 'A', inks: [], format: 'core', cards: {} }} />,
    );
    expect(screen.getByText('Start building')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Open the generator' }),
    ).toBeTruthy();
    expect(screen.queryByText('Ink curve')).toBeNull();
  });

  it('shows the stats grid once the deck has cards', () => {
    render(<Harness />);
    expect(screen.getByText('Ink curve')).toBeTruthy();
    expect(screen.queryByText('Start building')).toBeNull();
  });

  it('switches the card-insights tabs', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Tags' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Rarity' }));
    expect(screen.getByRole('heading', { name: 'Rarity' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Tags' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Franchises' }));
    expect(screen.getByRole('heading', { name: 'Franchises' })).toBeTruthy();
  });
});

const renderDeckWithCards = (cards: Card[], deck: DeckState): void => {
  mockedUseApp.mockReturnValue({
    cards,
    byId: byIdMap(cards),
    sets: [],
    deck,
    meta: null,
    setTitle: vi.fn(),
    setCount: vi.fn(),
    setInks: vi.fn(),
    setFormat: vi.fn(),
    removeCard: vi.fn(),
    swapCardVersion: vi.fn(),
    replaceDeck: replaceDeckMock,
    addCard: vi.fn(),
  } as unknown as ReturnType<typeof useApp>);
  render(<DeckView />);
};

describe('DeckView franchise availability', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the unique full-name pool beside each franchise in deck stats', () => {
    const cards: Card[] = [
      makeCard({
        id: 1,
        name: 'Amber Pooh',
        inks: ['Amber'],
        franchise: 'Pooh',
      }),
      makeCard({
        id: 2,
        name: 'Amber Other',
        inks: ['Amber'],
        franchise: 'Other',
      }),
      makeCard({ id: 3, name: 'Ruby Pooh', inks: ['Ruby'], franchise: 'Pooh' }),
    ];
    const deck: DeckState = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 1: 2, 2: 1 },
    };
    renderDeckWithCards(cards, deck);
    fireEvent.click(screen.getByRole('tab', { name: 'Franchises' }));
    expect(screen.getByText('Pooh (1)')).toBeDefined();
    expect(screen.getByText('Other (1)')).toBeDefined();
    expect(
      screen.getByText(
        "Unique cards available in this deck's format and inks.",
      ),
    ).toBeDefined();
  });
});

describe('DeckView engine winrate placement', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const legalDeck: DeckState = {
    title: 'Legal',
    inks: ['Amber'],
    format: 'core',
    cards: Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [100 + i, 4]),
    ),
  };
  const legalCatalog = Array.from({ length: 15 }, (_, i) =>
    makeCard({ id: 100 + i, name: `Member ${i}`, inks: ['Amber'] }),
  );

  it('renders the engine winrate section above the validity check for a legal deck', () => {
    mockedUseApp.mockReturnValue({
      cards: legalCatalog,
      byId: byIdMap(legalCatalog),
      deck: legalDeck,
      meta: null,
      setTitle: vi.fn(),
      setCount: vi.fn(),
      setInks: vi.fn(),
      setFormat: vi.fn(),
      removeCard: vi.fn(),
      swapCardVersion: vi.fn(),
      replaceDeck: vi.fn(),
      addCard: vi.fn(),
    } as unknown as ReturnType<typeof useApp>);
    render(<DeckView />);
    const winrate = screen.getByTestId('winrate-section');
    const validation = screen.getByText('Validation').closest('section')!;
    // the winrate section precedes the validity check in the deck page's aside
    expect(
      winrate.compareDocumentPosition(validation) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText('✓ Legal 60-card deck')).toBeTruthy();
    // the section renders with no meta-model surface at all
    expect(screen.queryByTestId('meta-unavailable')).toBeNull();
  });

  it('hides the engine winrate section while the deck is incomplete', () => {
    render(<Harness />);
    expect(screen.queryByTestId('winrate-section')).toBeNull();
    expect(screen.getByText(/4\/60 cards/)).toBeTruthy();
  });
});

describe('DeckView total price', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the sum of selected print prices under Validation', () => {
    const cards: Card[] = [
      makeCard({
        id: 1,
        name: 'Priced Card',
        inks: ['Amber'],
        prices: { usd: '1.50' },
      }),
    ];
    const deck: DeckState = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 1: 2 },
    };
    renderDeckWithCards(cards, deck);
    expect(screen.getByText('TCGplayer total: $3.00')).toBeTruthy();
  });

  it('shows a partial total when some prints lack prices', () => {
    const cards: Card[] = [
      makeCard({
        id: 1,
        name: 'Priced Card',
        inks: ['Amber'],
        prices: { usd: '1.00' },
      }),
      makeCard({
        id: 2,
        name: 'Priceless Card',
        inks: ['Amber'],
      }),
    ];
    const deck: DeckState = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 1: 1, 2: 1 },
    };
    renderDeckWithCards(cards, deck);
    expect(screen.getByText(/~\$1\.00/)).toBeTruthy();
    expect(screen.getByText(/1 cards missing prices/)).toBeTruthy();
  });
});
