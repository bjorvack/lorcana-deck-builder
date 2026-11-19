/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { GeneratorView } from './GeneratorView';
import { useApp } from '../state';
import { fillPool, byIdMap } from '../test/fixtures';
import { validateDeck } from '../rules/engine';
import type { Card, DeckState } from '../data/types';

vi.mock('../state', () => ({ useApp: vi.fn() }));
vi.mock('../meta/infer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../meta/infer')>()),
  loadMetaModel: vi.fn(async () => null), // deterministic-only: no artifact in the test env
}));

const mockedUseApp = vi.mocked(useApp);

const AMBER: Card[] = fillPool(['Amber'], 30, 10, 100);
const RUBY: Card[] = fillPool(['Ruby'], 30, 10, 200);
const catalog = [...AMBER, ...RUBY];

const emptyDeck: DeckState = { title: 'T', inks: [], format: 'core', cards: {} };
const replaceDeck = vi.fn<(deck: DeckState) => void>();

const renderView = (): ReturnType<typeof render> => {
  mockedUseApp.mockReturnValue({
    cards: catalog,
    sets: [{ code: '1', number: 1, name: 'The First Chapter', type: 'expansion' }],
    deck: emptyDeck,
    replaceDeck,
  } as unknown as ReturnType<typeof useApp>);
  return render(<GeneratorView onGenerated={() => {}} />);
};

const toggleInk = (ink: string): void => {
  fireEvent.click(screen.getByRole('button', { name: ink }));
};

describe('generator view (slider + seed)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders with the slider at the middle default and a seed input', () => {
    renderView();
    const slider = screen.getByLabelText('Novelty slider') as HTMLInputElement;
    expect(slider.value).toBe('0.5');
    expect(screen.getByLabelText('Generation seed')).toBeDefined();
    expect(screen.getByLabelText(/Goldfish polish/)).toBeDefined();
  });

  it('generates a legal deck and responds to seed changes', () => {
    renderView();
    toggleInk('Amber');
    fireEvent.click(screen.getByRole('button', { name: 'Generate 60-card deck' }));
    expect(replaceDeck).toHaveBeenCalledTimes(1);
    const first = replaceDeck.mock.calls[0]![0] as DeckState;
    expect(Object.values(first.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(first, byIdMap(catalog))).toEqual([]);

    // same seed → identical deck (deterministic)
    fireEvent.click(screen.getByRole('button', { name: 'Generate 60-card deck' }));
    const again = replaceDeck.mock.calls[1]![0] as DeckState;
    expect(again.cards).toEqual(first.cards);

    // new seed → different deck
    fireEvent.click(screen.getByRole('button', { name: 'New seed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate 60-card deck' }));
    const changed = replaceDeck.mock.calls[2]![0] as DeckState;
    expect(changed.cards).not.toEqual(first.cards);
  });

  it('responds to slider changes (novel vs meta label)', () => {
    renderView();
    const slider = screen.getByLabelText('Novelty slider') as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '1' } });
    expect(screen.getByText('Novel')).toBeDefined();
    fireEvent.change(slider, { target: { value: '0' } });
    expect(screen.getByText('Meta')).toBeDefined();
  });
});
