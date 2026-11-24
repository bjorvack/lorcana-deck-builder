/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card, DeckState } from '../data/types';
import type { Fingerprint } from '../stats/fingerprint';
import {
  deckSignature,
  estimateWinrate,
  type WinrateEstimate,
} from '../stats/winrate-estimate';
import { byIdMap, makeCard } from '../test/fixtures';
import { AnalysisPanel } from './AnalysisPanel';

// only the async runner is replaced: controllable promises let the tests
// resolve runs in a chosen order (deckSignature stays the real one)
vi.mock('../stats/winrate-estimate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../stats/winrate-estimate')>();
  return { ...actual, estimateWinrate: vi.fn() };
});
const estimateWinrateMock = vi.mocked(estimateWinrate);

const fingerprint = {
  version: 1,
  axes: {
    Tempo: 60,
    Consistency: 60,
    Resilience: 40,
    Interaction: 40,
    Reach: 40,
  },
  matchups: [],
  openingHand: { keepableRate: 0.9 },
  curve: { onCurveThrough: 4, seed: 1 },
} as unknown as Fingerprint;

const amber = (id: number, name: string): Card =>
  makeCard({ id, name, inks: ['Amber'] });
const cards = [amber(1, 'Deck Member'), amber(2, 'Second Member')];
const byId = byIdMap(cards);
const deckA: DeckState = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 30, 2: 30 },
};
const deckB: DeckState = { ...deckA, cards: { 1: 20, 2: 40 } };

const estimate = (winRate: number): WinrateEstimate => ({
  profileId: 'midrange',
  wins: Math.round(winRate * 2000),
  trials: 2000,
  winRate,
  ci: { low: winRate - 0.0218, high: winRate + 0.0214 },
});

/** promise with a manually triggered resolution, for abandoned-run ordering */
const deferred = (): {
  promise: Promise<WinrateEstimate | null>;
  resolve: (value: WinrateEstimate | null) => void;
} => {
  let resolve!: (value: WinrateEstimate | null) => void;
  const promise = new Promise<WinrateEstimate | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const renderPanel = (deck: DeckState): ReturnType<typeof render> =>
  render(<AnalysisPanel fingerprint={fingerprint} deck={deck} byId={byId} />);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('analysis panel winrate section', () => {
  it('renders the estimate with Wilson CI and trials after the run completes', async () => {
    estimateWinrateMock.mockResolvedValue(estimate(0.54));
    renderPanel(deckA);
    // estimating state first, no estimate yet
    expect(screen.getByTestId('winrate-estimating')).toBeDefined();
    expect(screen.queryByTestId('winrate-estimate')).toBeNull();
    const line = await screen.findByTestId('winrate-estimate');
    expect(line.textContent).toContain(
      'Simulated winrate vs midrange baseline',
    );
    expect(line.textContent).toContain('54%');
    expect(line.textContent).toContain('52–56%'); // Wilson 95% CI
    expect(line.textContent).toContain('2000 simulated games');
    expect(screen.queryByTestId('winrate-estimating')).toBeNull();
    // the run carries the abort token for deck-change cancellation
    expect(estimateWinrateMock).toHaveBeenCalledWith(
      deckA,
      byId,
      expect.objectContaining({ shouldAbort: expect.any(Function) }),
    );
  });

  it('is keyed by the deck signature — identical content keeps the run, changed content restarts it', async () => {
    estimateWinrateMock.mockResolvedValue(estimate(0.54));
    const { rerender } = renderPanel(deckA);
    await screen.findByTestId('winrate-estimate');
    // title-only edit: same signature, same calc-deck content projection
    rerender(
      <AnalysisPanel
        fingerprint={fingerprint}
        deck={{ ...deckA, title: 'Renamed' }}
        byId={byId}
      />,
    );
    expect(estimateWinrateMock).toHaveBeenCalledTimes(1);
    // content change: new signature → the run restarts
    rerender(
      <AnalysisPanel fingerprint={fingerprint} deck={deckB} byId={byId} />,
    );
    await vi.waitFor(() =>
      expect(estimateWinrateMock).toHaveBeenCalledTimes(2),
    );
    expect(estimateWinrateMock.mock.calls[1]![0]).toBe(deckB);
    expect(deckSignature(deckB)).not.toBe(deckSignature(deckA));
  });

  it('never renders an abandoned run when the deck changes mid-run', async () => {
    const first = deferred();
    estimateWinrateMock.mockReturnValueOnce(first.promise);
    const { rerender } = renderPanel(deckA);
    const second = deferred();
    estimateWinrateMock.mockReturnValueOnce(second.promise);
    // deck changes while run 1 is in flight → run 1 is abandoned
    rerender(
      <AnalysisPanel fingerprint={fingerprint} deck={deckB} byId={byId} />,
    );
    // the abandoned run resolves late — its result must never appear
    await act(async () => {
      first.resolve(estimate(0.9));
    });
    expect(screen.queryByTestId('winrate-estimate')).toBeNull();
    expect(screen.getByTestId('winrate-estimating')).toBeDefined();
    // the current run completes and is the only result ever shown
    await act(async () => {
      second.resolve(estimate(0.3));
    });
    const line = screen.getByTestId('winrate-estimate');
    expect(line.textContent).toContain('30%');
    expect(line.textContent).not.toContain('90%');
  });

  it('renders no archetype match and no meta-model metadata', async () => {
    estimateWinrateMock.mockResolvedValue(estimate(0.54));
    renderPanel(deckA);
    await screen.findByTestId('winrate-estimate');
    // the archetype match line (and its stale/data-through labeling) was
    // removed with its identifyArchetype consumption — the panel carries no
    // meta-model content at all
    expect(screen.queryByText(/Archetype match:/)).toBeNull();
    expect(screen.queryByTestId('meta-score')).toBeNull();
    expect(screen.queryByTestId('meta-calibration-unavailable')).toBeNull();
    expect(screen.queryByTestId('meta-unavailable')).toBeNull();
    const section = screen.getByTestId('winrate-section').textContent;
    expect(section).not.toMatch(/sim \d/);
    expect(section).not.toContain('stale');
  });
});
