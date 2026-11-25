/**
 * Tiny pure arena helpers used across league, evolution and MAP-Elites.
 * Kept engine-free so modules that must avoid the vendored engine import
 * chain can still share deck signatures and affinity.
 */

export function deckSignature(cards: Record<string, number>): string {
  const entries = Object.entries(cards).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  let hash = 0;
  for (const [id, count] of entries)
    hash = (hash * 31 + Number(id) * 7 + count) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** total copies in the deck */
export const deckSize = (cards: Record<string, number>): number =>
  Object.values(cards).reduce((a, b) => a + b, 0);

/** partner affinity of `id` to the rest of the deck (both table directions) */
export function affinityTo(
  id: string,
  deckCards: Record<string, number>,
  partners: Record<string, Array<[number, number]>> | null,
): number {
  if (!partners) return 0;
  let best = 0;
  const own = partners[id] ?? [];
  for (const [partner, score] of own) {
    if ((deckCards[String(partner)] ?? 0) > 0) best = Math.max(best, score);
  }
  // inverse direction: any deck card naming id as its partner
  for (const deckId of Object.keys(deckCards)) {
    const list = partners[deckId] ?? [];
    for (const [partner, score] of list) {
      if (String(partner) === id) best = Math.max(best, score);
    }
  }
  return best;
}
