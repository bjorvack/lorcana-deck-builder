/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeckState } from '../data/types';
import type { EngineGameSummary } from '../stats/engine-winrate';
import {
  deckSignature,
  ENGINE_GAMES,
  type EngineWinrateEstimate,
  estimateEngineWinrate,
} from '../stats/engine-winrate';
import { EngineWinrateSection } from './EngineWinrateSection';

// only the async runner is replaced: controllable promises let the tests
// resolve runs in a chosen order (deckSignature stays the real one)
vi.mock('../stats/engine-winrate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../stats/engine-winrate')>();
  return { ...actual, estimateEngineWinrate: vi.fn() };
});
const estimateMock = vi.mocked(estimateEngineWinrate);

const deckA: DeckState = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 30, 2: 30 },
};
const deckB: DeckState = { ...deckA, cards: { 1: 20, 2: 40 } };

const turnLine = (who: string) => [
  {
    turn: 1,
    p1: [`${who} played opener`],
    p2: ['opponent inked'],
    lore: { p1: 2, p2: 0 },
  },
];

const estimate = (winRate: number): EngineWinrateEstimate => ({
  wins: Math.round(winRate * 64),
  games: 64,
  winRate,
  ci: { low: winRate - 0.12, high: winRate + 0.12 },
  engineCommit: 'a'.repeat(40),
  played: [
    {
      opponentId: 'real:opp-0',
      opponentName: 'Tournament deck 18084',
      seat: 'p1',
      seed: '101',
      winner: 'p1',
      turns: 9,
      log: turnLine('you'),
    },
    {
      opponentId: 'real:opp-0',
      opponentName: 'Tournament deck 18084',
      seat: 'p2',
      seed: '102',
      winner: 'p1',
      turns: 11,
      log: turnLine('you'),
    },
  ],
});

/** promise with a manually triggered resolution, for abandoned-run ordering */
const deferred = (): {
  promise: Promise<EngineWinrateEstimate | null>;
  resolve: (value: EngineWinrateEstimate | null) => void;
} => {
  let resolve!: (value: EngineWinrateEstimate | null) => void;
  const promise = new Promise<EngineWinrateEstimate | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('engine winrate section', () => {
  it('renders the loader with progress, then the estimate with Wilson CI and games', async () => {
    const run = deferred();
    let onProgress:
      | ((p: { completed: number; total: number }) => void)
      | undefined;
    estimateMock.mockImplementation((_deck, opts) => {
      onProgress = (opts as { onProgress?: typeof onProgress }).onProgress;
      return run.promise;
    });
    render(<EngineWinrateSection deck={deckA} />);
    const loader = screen.getByTestId('winrate-estimating');
    expect(loader.textContent).toContain(`0/${ENGINE_GAMES}`);
    // spinner + loading bar make the running simulation obvious
    expect(loader.querySelector('.animate-spin')).not.toBeNull();
    const bar = screen.getByTestId('winrate-progress-bar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    await act(async () => {
      onProgress?.({ completed: 23, total: ENGINE_GAMES });
    });
    expect(
      (
        screen.getByTestId('winrate-progress-bar')
          .firstElementChild as HTMLElement
      ).style.width,
    ).toBe(`${Math.round((23 / ENGINE_GAMES) * 100)}%`);
    expect(screen.getByTestId('winrate-estimating').textContent).toContain(
      `Simulating 23/${ENGINE_GAMES} games…`,
    );
    await act(async () => {
      run.resolve(estimate(0.54));
    });
    const line = await screen.findByTestId('winrate-estimate');
    expect(line.textContent).toContain('54%');
    expect(line.textContent).toContain('42–66%'); // Wilson 95% CI
    expect(line.textContent).toContain('64 engine games');
    expect(screen.queryByTestId('winrate-estimating')).toBeNull();
    // the run carries the abort token for deck-change cancellation
    expect(estimateMock).toHaveBeenCalledWith(
      deckA,
      expect.objectContaining({ shouldAbort: expect.any(Function) }),
    );
  });

  it('is keyed by the deck signature — identical content keeps the run, changed content restarts it', async () => {
    estimateMock.mockResolvedValue(estimate(0.54));
    const { rerender } = render(<EngineWinrateSection deck={deckA} />);
    await screen.findByTestId('winrate-estimate');
    // title-only edit: same signature → the run is kept
    rerender(<EngineWinrateSection deck={{ ...deckA, title: 'Renamed' }} />);
    expect(estimateMock).toHaveBeenCalledTimes(1);
    // content change: new signature → the run restarts
    rerender(<EngineWinrateSection deck={deckB} />);
    await vi.waitFor(() => expect(estimateMock).toHaveBeenCalledTimes(2));
    expect(estimateMock.mock.calls[1]![0]).toBe(deckB);
    expect(deckSignature(deckB)).not.toBe(deckSignature(deckA));
  });

  it('never renders an abandoned run when the deck changes mid-run', async () => {
    const first = deferred();
    estimateMock.mockReturnValueOnce(first.promise);
    const { rerender } = render(<EngineWinrateSection deck={deckA} />);
    const second = deferred();
    estimateMock.mockReturnValueOnce(second.promise);
    // deck changes while run 1 is in flight → run 1 is abandoned
    rerender(<EngineWinrateSection deck={deckB} />);
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

  it('renders the review disclosure with per-game logs', async () => {
    estimateMock.mockResolvedValue(estimate(0.54));
    render(<EngineWinrateSection deck={deckA} />);
    await screen.findByTestId('winrate-estimate');
    // the turn log only mounts when a game is expanded (64 collapsed rows)
    expect(screen.queryByTestId('winrate-game-log-0')).toBeNull();
    expect(screen.getByTestId('winrate-game-0').textContent).toContain(
      'Win vs Tournament deck 18084 (as p1, 9 turns)',
    );
    expect(screen.getByTestId('winrate-game-1').textContent).toContain(
      'Loss vs Tournament deck 18084 (as p2, 11 turns)',
    );
    fireEvent.click(screen.getByTestId('winrate-game-0'));
    const log = screen.getByTestId('winrate-game-log-0');
    expect(log.textContent).toContain('Turn 1 · 2–0');
    expect(log.textContent).toContain('you played opener');
    expect(log.textContent).toContain('opponent inked');
    // clicking again collapses the log
    fireEvent.click(screen.getByTestId('winrate-game-0'));
    expect(screen.queryByTestId('winrate-game-log-0')).toBeNull();
  });

  it('renders the unavailable state when the simulation resolves null', async () => {
    estimateMock.mockResolvedValue(null);
    render(<EngineWinrateSection deck={deckA} />);
    await screen.findByTestId('winrate-unavailable');
    expect(screen.queryByTestId('winrate-estimate')).toBeNull();
  });

  it('depends on no meta-model surface', async () => {
    estimateMock.mockResolvedValue(estimate(0.54));
    render(<EngineWinrateSection deck={deckA} />);
    await screen.findByTestId('winrate-estimate');
    expect(screen.queryByTestId('meta-unavailable')).toBeNull();
    expect(screen.queryByTestId('meta-score')).toBeNull();
  });
});

describe('live tally and progressive games list while simulating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the running tally and completed games as they finish', async () => {
    let resolveRun: ((r: EngineWinrateEstimate | null) => void) | undefined;
    let gameListener: ((g: EngineGameSummary) => void) | undefined;
    estimateMock.mockImplementation((_deck, opts) => {
      gameListener = (opts as { onGame?: (g: EngineGameSummary) => void })
        .onGame;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });
    render(<EngineWinrateSection deck={deckA} />);
    const game = (
      index: number,
      winnerSeat: 'p1' | 'p2',
    ): EngineGameSummary => ({
      opponentId: `opp-${index}`,
      opponentName: `Tournament deck ${index}`,
      seat: (index % 2 === 0 ? 'p1' : 'p2') as 'p1' | 'p2',
      seed: String(index),
      winner: winnerSeat,
      turns: 10 + index,
      log: [],
    });
    // first game finishes: the live tally appears with the running winrate
    await act(async () => {
      gameListener?.(game(0, 'p1'));
    });
    const tally = screen.getByTestId('winrate-live-tally');
    expect(tally.textContent).toContain('100%');
    expect(tally.textContent).toContain('1W–0L over 1 games');
    // the completed-games list grows progressively with a reviewable log
    expect(screen.getByTestId('winrate-game-0')).toBeDefined();
    act(() => {
      fireEvent.click(screen.getByTestId('winrate-game-0'));
    });
    expect(screen.getByTestId('winrate-game-log-0')).toBeDefined();
    // second game: the tally recomputes (1W–1L)
    await act(async () => {
      gameListener?.(game(1, 'p1'));
    });
    expect(screen.getByTestId('winrate-live-tally').textContent).toContain(
      '1W–1L over 2 games',
    );
    expect(screen.getByTestId('winrate-game-1')).toBeDefined();
    // run completes: the final estimate replaces the live tally
    await act(async () => {
      resolveRun?.({
        wins: 1,
        games: 2,
        winRate: 0.5,
        ci: { low: 0, high: 1 },
        engineCommit: '6de59de1',
        played: [game(0, 'p1'), game(1, 'p1')],
      });
    });
    expect(await screen.findByTestId('winrate-estimate')).toBeDefined();
  });
});
