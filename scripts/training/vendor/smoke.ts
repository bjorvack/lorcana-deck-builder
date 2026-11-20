/* Task 1.4 smoke test: one AI-vs-AI game through the vendored @tcg/* aliases. */
import { AUTOMATED_ACTION_STRATEGIES, createLorcanaServerGame } from '@tcg/lorcana-engine';
import { fromDeckToCardInstances, getAllCardsById, getLorcanaCardCatalog } from '@tcg/lorcana-cards';

async function main(): Promise<void> {
  const byId = (await getAllCardsById()) as Record<string, { set?: string }>;
  const set1 = Object.entries(byId).filter(([, c]) => c.set === '001').map(([id]) => id);
  if (set1.length < 40) throw new Error(`only ${set1.length} set-1 cards`);
  const take = (offset: number) => {
    const deck: { cardId: string; qty: number }[] = [];
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
  // Deterministic instance ids (see arena/engine.ts for the real implementation).
  const key = (owner: string, i: number, inst: string) =>
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
    { id: 'p1', name: 'Bot A' },
    { id: 'p2', name: 'Bot B' },
  ];
  const lorcana = createLorcanaServerGame(
    players.map((player) => ({ player })),
    {
      seed: 'vendor-smoke-1',
      goingFirst: 'p1',
      cardCatalog: await getLorcanaCardCatalog(),
      players,
      cardsMaps,
    },
  );
  const [stratA, stratB] = AUTOMATED_ACTION_STRATEGIES;
  for (let i = 0; i < 500; i++) {
    if ((lorcana.getBoard() as { winner?: string }).winner != null) break;
    const actor = lorcana.getCurrentActorId();
    if (!actor) break;
    lorcana.takeAutomatedActionForCurrentActor({
      strategy: actor === 'p1' ? stratA!.strategy : stratB!.strategy,
    });
  }
  const board = lorcana.getBoard() as { winner?: string };
  console.log(JSON.stringify({ winner: board.winner ?? 'incomplete' }));
  if (board.winner == null) process.exit(1);
}

void main();
