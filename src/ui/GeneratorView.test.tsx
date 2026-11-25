/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, DeckState } from '../data/types';
import { validateDeck } from '../rules/engine';
import { useApp } from '../state';
import {
  byIdMap,
  fillPool,
  HUNNY_SAGE_EFFECT,
  makeCard,
} from '../test/fixtures';
import { GeneratorView } from './GeneratorView';

vi.mock('../state', () => ({ useApp: vi.fn() }));
vi.mock('../meta/infer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../meta/infer')>()),
  loadMetaModel: vi.fn(async () => null), // deterministic-only: no artifact in the test env
}));

const mockedUseApp = vi.mocked(useApp);

const AMBER: Card[] = fillPool(['Amber'], 30, 10, 100);
const RUBY: Card[] = fillPool(['Ruby'], 30, 10, 200);
const catalog = [...AMBER, ...RUBY];

const emptyDeck: DeckState = {
  title: 'T',
  inks: [],
  format: 'core',
  cards: {},
};
const replaceDeck = vi.fn<(deck: DeckState) => void>();

const renderView = (deck: DeckState = emptyDeck): ReturnType<typeof render> => {
  mockedUseApp.mockReturnValue({
    cards: catalog,
    sets: [
      { code: '1', number: 1, name: 'The First Chapter', type: 'expansion' },
    ],
    deck,
    replaceDeck,
  } as unknown as ReturnType<typeof useApp>);
  return render(<GeneratorView onGenerated={() => {}} />);
};

const renderWithCards = (
  cards: Card[],
  deck: DeckState = emptyDeck,
): ReturnType<typeof render> => {
  mockedUseApp.mockReturnValue({
    cards,
    sets: [
      { code: '1', number: 1, name: 'The First Chapter', type: 'expansion' },
    ],
    deck,
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
    expect(screen.getByTestId('ink-mode-hint').textContent).toContain(
      'Auto — inks emerge from your cards',
    );
  });

  it('shows only the two generation paths (starter + polish removed)', () => {
    renderView();
    expect(screen.queryByLabelText(/Goldfish polish/)).toBeNull();
    expect(screen.queryByText('Start from an archetype')).toBeNull();
    expect(screen.queryByLabelText('Archetype starter deck')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Open starter deck' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Open + fill to 60' }),
    ).toBeNull();
    // the two kept paths are present
    expect(screen.getByLabelText(/Complete my current deck/)).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Generate 60-card deck (auto inks)' }),
    ).toBeDefined();
  });

  it('generates without inks and the deck derives its inks', () => {
    renderView();
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate 60-card deck (auto inks)' }),
    );
    expect(replaceDeck).toHaveBeenCalledTimes(1);
    const generated = replaceDeck.mock.calls[0]![0] as DeckState;
    expect(Object.values(generated.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(generated, byIdMap(catalog))).toEqual([]);
    expect(generated.inks.length).toBeGreaterThanOrEqual(1);
    expect(generated.inks.length).toBeLessThanOrEqual(2);
  });

  it('generates a legal deck and responds to seed changes', () => {
    renderView();
    toggleInk('Amber');
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate 60-card deck' }),
    );
    expect(replaceDeck).toHaveBeenCalledTimes(1);
    const first = replaceDeck.mock.calls[0]![0] as DeckState;
    expect(Object.values(first.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(first, byIdMap(catalog))).toEqual([]);

    // same seed → identical deck (deterministic)
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate 60-card deck' }),
    );
    const again = replaceDeck.mock.calls[1]![0] as DeckState;
    expect(again.cards).toEqual(first.cards);

    // new seed → different deck
    fireEvent.click(screen.getByRole('button', { name: 'New seed' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate 60-card deck' }),
    );
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

  it('completes the current cards when the toggle is on', () => {
    const partial: DeckState = {
      title: 'Mine',
      inks: ['Amber'],
      format: 'core',
      cards: { 100: 4 },
    };
    renderView(partial);
    fireEvent.click(screen.getByLabelText(/Complete my current deck/));
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate 60-card deck (auto inks)' }),
    );
    expect(replaceDeck).toHaveBeenCalledTimes(1);
    const generated = replaceDeck.mock.calls[0]![0] as DeckState;
    expect(generated.title).toBe('Mine');
    expect(generated.cards[100]).toBe(4); // partial cards kept unchanged
    expect(Object.values(generated.cards).reduce((s, c) => s + c, 0)).toBe(60);
    expect(validateDeck(generated, byIdMap(catalog))).toEqual([]);
  });

  it('shows franchise unique counts in the dropdown', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Franchises/ }));
    expect(screen.getByText('Test Story (80)')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Franchises/ }));
    toggleInk('Amber');
    fireEvent.click(screen.getByRole('button', { name: /Franchises/ }));
    expect(screen.getByText('Test Story (40)')).toBeDefined();
  });

  it('reflects Hunny Sage ink exemptions in franchise counts', () => {
    const source = makeCard({
      id: 3032,
      name: 'Christopher Robin',
      version: 'Hunny Sage',
      inks: ['Amethyst', 'Sapphire'],
      franchise: 'Pooh',
      type: 'Character',
      subtypes: ['Hunny'],
      deckRuleEffects: [HUNNY_SAGE_EFFECT],
    });
    const sameInk = makeCard({
      id: 3033,
      name: 'Pooh',
      inks: ['Amethyst'],
      franchise: 'Pooh',
      type: 'Character',
      subtypes: ['Hunny'],
    });
    const offInk = makeCard({
      id: 3034,
      name: 'Tigger',
      inks: ['Amber'],
      franchise: 'Pooh',
      type: 'Character',
      subtypes: ['Hunny'],
    });
    const nonHunny = makeCard({
      id: 3035,
      name: 'Rabbit',
      inks: ['Amber'],
      franchise: 'Pooh',
      type: 'Character',
      subtypes: ['Storyborn'],
    });
    renderWithCards([source, sameInk, offInk, nonHunny]);

    toggleInk('Amethyst');
    toggleInk('Sapphire');
    fireEvent.click(screen.getByRole('button', { name: /Franchises/ }));
    expect(screen.getByText('Pooh (3)')).toBeDefined();
  });
});
