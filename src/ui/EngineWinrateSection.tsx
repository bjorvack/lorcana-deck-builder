import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { DeckState } from '../data/types';
import {
  deckSignature,
  ENGINE_GAMES,
  type EngineGameSummary,
  type EngineWinrateEstimate,
  estimateEngineWinrate,
} from '../stats/engine-winrate';
import { panelCls, panelHeadingCls } from './styles';

/**
 * Engine-verified winrate section (openspec change engine-winrate): plays the
 * pre-committed 64-game budget of full-rules vendored-engine games against
 * the shipped baseline decks, async and batched so the page stays responsive.
 * Rendered above the deck-validity check in the deck page; needs no
 * meta-model artifact. A deck change flips the run token — the in-flight run
 * is abandoned and never rendered.
 */
export function EngineWinrateSection({ deck }: { deck: DeckState }): ReactNode {
  // the estimate is keyed by the deck signature (content identity): a deck
  // change flips the run token, the in-flight run is abandoned and never
  // rendered. The latest deck object is read through a ref so a new object
  // with identical cards (title-only edit) does not restart the run.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const signature = useMemo(() => deckSignature(deck), [deck]);
  const [estimate, setEstimate] = useState<EngineWinrateEstimate | null>(null);
  const [estimating, setEstimating] = useState(true);
  const [completed, setCompleted] = useState(0);
  const [liveGames, setLiveGames] = useState<EngineGameSummary[]>([]);
  const [openGame, setOpenGame] = useState<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect is keyed by the deck signature — content identity, not deck object identity
  useEffect(() => {
    let aborted = false;
    setEstimate(null);
    setEstimating(true);
    setCompleted(0);
    setLiveGames([]);
    setOpenGame(null);
    estimateEngineWinrate(deckRef.current, {
      shouldAbort: () => aborted,
      onProgress: ({ completed: done }) => setCompleted(done),
      onGame: (game) => setLiveGames((prev) => [...prev, game]),
    }).then((result) => {
      if (aborted) return; // an abandoned run's games are discarded
      setEstimate(result); // null when the simulation is unavailable
      setEstimating(false);
    });
    return () => {
      aborted = true;
    };
  }, [signature]);

  const liveWins = liveGames.filter((g) => g.winner === g.seat).length;
  const liveWinRate =
    liveGames.length === 0
      ? 0
      : Math.round((liveWins / liveGames.length) * 100);

  return (
    <section className={panelCls} data-testid="winrate-section">
      <h3 className={panelHeadingCls}>Winrate</h3>
      {estimating && (
        <div data-testid="winrate-estimating" className="my-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-gold"
            />
            <p className="m-0 text-[13px]">
              Simulating {completed}/{ENGINE_GAMES} games…
            </p>
          </div>
          <div
            className="mt-1.5 h-2 overflow-hidden rounded-md bg-panel-2"
            data-testid="winrate-progress-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={ENGINE_GAMES}
            aria-valuenow={completed}
          >
            <div
              className="h-full bg-gold transition-[width] duration-300"
              style={{
                width: `${Math.round((completed / ENGINE_GAMES) * 100)}%`,
              }}
            />
          </div>
          {liveGames.length > 0 && (
            <p className="my-1 text-[13px]" data-testid="winrate-live-tally">
              Current: <strong>{liveWinRate}%</strong> ({liveWins}W–
              {liveGames.length - liveWins}L over {liveGames.length} games)
            </p>
          )}
        </div>
      )}
      {liveGames.length > 0 && (
        <details
          className="mt-1.5"
          data-testid={estimating ? 'winrate-review-live' : 'winrate-review'}
          open={estimating}
        >
          <summary className="cursor-pointer text-[13px]">
            {estimating
              ? `Games played so far (${liveGames.length})`
              : 'Review games'}
          </summary>
          <ol className="m-0 mt-1 pl-[18px]">
            {(estimating ? liveGames : (estimate?.played ?? [])).map(
              (game, index) => (
                <li key={`${game.opponentId}:${game.seed}`} className="my-1">
                  <button
                    type="button"
                    className="cursor-pointer text-left text-[12px] underline-offset-2 hover:underline"
                    data-testid={`winrate-game-${index}`}
                    onClick={() =>
                      setOpenGame(openGame === index ? null : index)
                    }
                  >
                    {game.winner === game.seat ? 'Win' : 'Loss'} vs{' '}
                    {game.opponentName} (as {game.seat}, {game.turns} turns)
                    {openGame === index ? ' ▾' : ' ▸'}
                  </button>
                  {openGame === index && (
                    <ul
                      className="m-0 mt-1 pl-[18px] text-[11px] text-parchment-muted"
                      data-testid={`winrate-game-log-${index}`}
                    >
                      {game.log.map((turn) => (
                        <li key={turn.turn}>
                          Turn {turn.turn} · {turn.lore.p1}–{turn.lore.p2} ·
                          you:{' '}
                          {(game.seat === 'p1' ? turn.p1 : turn.p2).join(', ')}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ),
            )}
          </ol>
        </details>
      )}
      {!estimating && estimate && (
        <>
          <p className="my-1 text-[13px]" data-testid="winrate-estimate">
            Simulated winrate vs shipped baselines:{' '}
            <strong>{Math.round(estimate.winRate * 100)}%</strong> · 95% CI{' '}
            {Math.round(estimate.ci.low * 100)}–
            {Math.round(estimate.ci.high * 100)}% · {estimate.games} engine
            games
          </p>
          <details className="mt-1.5" data-testid="winrate-review">
            <summary className="cursor-pointer text-[13px]">
              Review games
            </summary>
            <ol className="m-0 mt-1 pl-[18px]">
              {estimate.played.map((game, index) => (
                <li key={`${game.opponentId}:${game.seed}`} className="my-1">
                  <button
                    type="button"
                    className="cursor-pointer text-left text-[12px] underline-offset-2 hover:underline"
                    data-testid={`winrate-game-${index}`}
                    onClick={() =>
                      setOpenGame(openGame === index ? null : index)
                    }
                  >
                    {game.winner === game.seat ? 'Win' : 'Loss'} vs{' '}
                    {game.opponentName} (as {game.seat}, {game.turns} turns)
                    {openGame === index ? ' ▾' : ' ▸'}
                  </button>
                  {openGame === index && (
                    <ul
                      className="m-0 mt-1 pl-[18px] text-[11px] text-parchment-muted"
                      data-testid={`winrate-game-log-${index}`}
                    >
                      {game.log.map((turn) => (
                        <li key={turn.turn}>
                          Turn {turn.turn} · {turn.lore.p1}–{turn.lore.p2} ·
                          you:{' '}
                          {(game.seat === 'p1' ? turn.p1 : turn.p2).join(
                            ', ',
                          ) || '—'}{' '}
                          · opponent:{' '}
                          {(game.seat === 'p1' ? turn.p2 : turn.p1).join(
                            ', ',
                          ) || '—'}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      {!estimating && !estimate && (
        <p className="my-1 text-[13px]" data-testid="winrate-unavailable">
          Engine simulation unavailable — the engine bundle or the baseline deck
          pool failed to load, or this deck has cards the simulator cannot map.
        </p>
      )}
      <p className="text-[11px] mt-1 text-parchment-muted">
        Full-rules games (heuristic bot on both seats, seat-alternating)
        simulated in your browser by the pinned vendored engine against four
        shipped tournament decks. Deterministic per deck — the same cards always
        produce the same games.
      </p>
    </section>
  );
}
