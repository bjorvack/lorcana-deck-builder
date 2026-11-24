/**
 * Web Worker for the engine-verified winrate: plays the pre-committed games
 * OFF the main thread so the page stays responsive during the ~1 s/game
 * simulations. The main thread posts the schedule (with the bundle URL);
 * this worker imports the bundle lazily, plays each game, and streams
 * per-game summaries back. The main thread terminates the worker to cancel.
 *
 * The handler is exported for tests; `self.onmessage` binds it at load.
 */
import type { EngineGameResult } from './engine-winrate';

interface RunGameInput {
  deckA: Record<string, number>;
  deckB: Record<string, number>;
  seed: string;
}

interface RunGameTask extends RunGameInput {
  scheduleIndex: number;
  opponentId: string;
  opponentName: string;
  seat: 'p1' | 'p2';
}

interface RunMessage {
  type: 'run';
  bundleUrl: string;
  games: RunGameTask[];
}

interface EngineBundle {
  engineCommit: string;
  strategyId: string;
  attribution: string;
  createGame: (input: RunGameInput) => Promise<EngineGameResult>;
}

type OutMessage =
  | { type: 'game'; index: number; summary: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string };

export async function onMessage(message: RunMessage): Promise<void> {
  if (message.type !== 'run') return;
  const out = (message: OutMessage) => self.postMessage(message);
  try {
    const bundle = (await import(
      /* @vite-ignore */ message.bundleUrl
    )) as EngineBundle;
    for (const task of message.games) {
      const result = await bundle.createGame({
        deckA: task.deckA,
        deckB: task.deckB,
        seed: task.seed,
      });
      out({
        type: 'game',
        index: task.scheduleIndex,
        summary: {
          opponentId: task.opponentId,
          opponentName: task.opponentName,
          seat: task.seat,
          seed: task.seed,
          winner: result.winner,
          turns: result.turns,
          log: result.log,
        },
      });
    }
    out({ type: 'done' });
  } catch (error) {
    out({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Worker context: self exists; guard for Node-side imports (tests).
if (typeof self !== 'undefined')
  self.onmessage = (event: MessageEvent<RunMessage>) =>
    void onMessage(event.data);
