/* Probe: do card effects actually resolve in arena games? Count move types + effect resolutions. */
import { AUTOMATED_ACTION_STRATEGIES, createLorcanaServerGame } from '@tcg/lorcana-engine';
import { fromDeckToCardInstances, getAllCardsById } from '@tcg/lorcana-cards';
import { createRecordCardCatalog } from '@tcg/shared/cards/catalog';

type AnyCard = { set?: string; name?: string };

async function main(): Promise<void> {
  const byId = (await getAllCardsById()) as unknown as Record<
    string,
    AnyCard & { id: string; name?: string }
  >;
  const set1 = Object.entries(byId)
    .filter(([, c]) => c.set === '001')
    .map(([id]) => id);
  const take = (offset: number): Array<{ cardId: string; qty: number }> => {
    const deck: Array<{ cardId: string; qty: number }> = [];
    let total = 0;
    for (let i = 0; total < 60 && i < set1.length; i++) {
      const qty = Math.min(3, 60 - total);
      deck.push({ cardId: set1[(offset + i) % set1.length]!, qty });
      total += qty;
    }
    return deck;
  };
  const raw = fromDeckToCardInstances([
    { owner: 'p1', deck: take(0) },
    { owner: 'p2', deck: take(20) },
  ]);
  const key = (owner: string, i: number, inst: string): string =>
    `${owner}-${String(i).padStart(3, '0')}-${inst}`;
  const cardsMaps = {
    cardInstances: Object.fromEntries(
      Object.entries(raw.owners).flatMap(([owner, ids]) =>
        ids.map((inst, i) => [key(owner, i, inst), raw.cardInstances[inst]!] as const),
      ),
    ),
    owners: Object.fromEntries(
      Object.entries(raw.owners).map(([owner, ids]) => [
        owner,
        ids.map((inst, i) => key(owner, i, inst)),
      ]),
    ),
  };
  const players = [
    { id: 'p1', name: 'A' },
    { id: 'p2', name: 'B' },
  ];
  const lorcana = createLorcanaServerGame(
    players.map((player) => ({ player })),
    {
      seed: 'effect-probe',
      goingFirst: 'p1',
      cardCatalog: createRecordCardCatalog('lorcana:cards', byId) as never,
      players,
      cardsMaps,
    },
  );
  const strategy = AUTOMATED_ACTION_STRATEGIES[0]!.strategy;
  for (let i = 0; i < 2000; i++) {
    if ((lorcana.getBoard() as { winner?: string }).winner != null) break;
    const actor = lorcana.getCurrentActorId();
    if (!actor) break;
    lorcana.takeAutomatedActionForCurrentActor({ strategy });
  }

  const engine = (
    lorcana as unknown as {
      engine?: {
        moveHistory?: Array<Record<string, unknown>>;
        stateHistory?: unknown[];
      };
    }
  ).engine;
  const moves = engine?.moveHistory ?? [];
  if (moves.length > 0) console.log('sample move keys:', Object.keys(moves[0]!).join(','), '| sample:', JSON.stringify(moves[0]).slice(0, 300));
  const kinds = new Map<string, number>();
  for (const move of moves) {
    const kind = String((move as { moveId?: string }).moveId ?? 'unknown');
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }

  // how many distinct real cards were actually played to the board?
  const played = new Map<string, number>();
  for (const move of moves) {
    if (String((move as { moveId?: string }).moveId ?? '') !== 'playCard') continue;
    console.error('sample playCard:', JSON.stringify(move).slice(0, 240));
    const cardId = String(
      (move as { args?: { cardId?: string }; input?: { cardId?: string } }).args?.cardId ??
        (move as { cardId?: string }).cardId ??
        '',
    );
    played.set(cardId, (played.get(cardId) ?? 0) + 1);
  }
  const board = lorcana.getBoard() as { winner?: string; turnNumber?: number };
  console.log(
    JSON.stringify(
      {
        winner: board.winner ?? 'incomplete',
        turns: board.turnNumber,
        totalMoves: moves.length,
        moveKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]),
        distinctCardsPlayed: played.size,
      },
      null,
      1,
    ),
  );
}

void main();
