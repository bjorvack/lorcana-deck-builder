import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onMessage } from './engine-winrate.worker';

/**
 * Tests for the worker's message protocol. The worker registers
 * `self.onmessage` at module load; the handler is exported and driven
 * directly here. The bundle is provided as a data:-URL module (the same
 * mechanism the runtime uses for the real bundle).
 */

const posted: Array<Record<string, unknown>> = [];

const bundleSource = (behavior: 'ok' | 'throw'): string =>
  [
    'export const engineCommit = "6de59de1";',
    'export const strategyId = "test";',
    'export const attribution = "test attribution";',
    behavior === 'ok'
      ? `export const createGame = async ({ seed }) => ({
    winner: Number(seed) % 2 === 0 ? 'p1' : 'p2',
    turns: 3,
    incomplete: false,
    log: [
      {
        turn: 1,
        p1: ['played opener'],
        p2: ['inked'],
        lore: { p1: 1, p2: 0 },
      },
    ],
  });`
      : `export const createGame = async () => { throw new Error('engine exploded'); };`,
  ].join('\n');

interface RunTask {
  scheduleIndex: number;
  deckA: Record<string, number>;
  deckB: Record<string, number>;
  opponentId: string;
  opponentName: string;
  seat: 'p1' | 'p2';
  seed: string;
}

const runMessage = (
  bundleUrl: string,
  tasks: RunTask[],
): { type: 'run'; bundleUrl: string; games: RunTask[] } => ({
  type: 'run',
  bundleUrl,
  games: tasks,
});

const task = (scheduleIndex: number, seed: string): RunTask => ({
  scheduleIndex,
  deckA: { 1: 60 },
  deckB: { 2: 60 },
  opponentId: 'opp-0',
  opponentName: 'Baseline 0',
  seat: scheduleIndex % 2 === 0 ? ('p1' as const) : ('p2' as const),
  seed,
});

describe('engine-winrate.worker', () => {
  beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal('self', {
      onmessage: null,
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    });
  });

  it('plays each scheduled game and reports per-game summaries then done', async () => {
    await onMessage(
      runMessage(
        `data:text/javascript,${encodeURIComponent(bundleSource('ok'))}`,
        [task(0, '1'), task(1, '2')],
      ),
    );
    const gameMessages = posted.filter((m) => m.type === 'game') as Array<{
      summary: { winner: string };
    }>;
    expect(gameMessages).toHaveLength(2);
    // the fixture bundle maps seed parity to the winner: '1' → p2, '2' → p1
    expect(gameMessages[0]!.summary.winner).toBe('p2');
    expect(gameMessages[1]!.summary.winner).toBe('p1');
    expect(posted.at(-1)).toMatchObject({ type: 'done' });
  });

  it('reports an error message when the engine throws', async () => {
    await onMessage(
      runMessage(
        `data:text/javascript,${encodeURIComponent(bundleSource('throw'))}`,
        [task(0, '1'), task(1, '2')],
      ),
    );
    expect(posted.at(-1)).toMatchObject({ type: 'error' });
  });

  it('ignores messages that are not runs', async () => {
    await onMessage({ type: 'other' } as never);
    expect(posted).toHaveLength(0);
  });
});
