// Typecheck shim for `@tcg/lorcana-cards` (see lorcana-engine.d.ts).

export function fromDeckToCardInstances(
  input: Array<{
    owner: string;
    deck: Array<{ cardId: string; qty: number; cardName?: string }>;
  }>,
): { cardInstances: Record<string, string>; owners: Record<string, string[]> };

export function getAllCardsById(): Promise<
  Record<string, Record<string, unknown>>
>;
export function getLorcanaCardCatalog(): Promise<unknown>;
