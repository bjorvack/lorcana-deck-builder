import type { Card, DeckState, Format, Ink } from '../data/types';
import { INKS } from '../data/types';
import type { MetaArchetype } from '../meta/infer';
import { buildCanonicalRegistry } from '../../scripts/training/canonical';

/**
 * Archetype starter decks (card-first creation): the trained archetype
 * centroids become one-click editable decks to clone and adjust. The
 * artifact format is unchanged — this reads existing centroid data.
 */

/** shares below this produce no copies — starters aren't 60 singletons */
const SHARE_FLOOR = 1 / 120;

/** the archetype's dominant inks: centroid share accumulated per ink, top 2 */
export function dominantInks(archetype: MetaArchetype, idToCard: Map<number, Card>): Ink[] {
  const weight: Partial<Record<Ink, number>> = {};
  for (const [id, share] of Object.entries(archetype.centroid)) {
    const card = idToCard.get(Number(id));
    if (!card) continue;
    for (const ink of card.inks) weight[ink] = (weight[ink] ?? 0) + share;
  }
  return [...INKS]
    .filter((ink) => (weight[ink] ?? 0) > 0)
    .sort((a, b) => (weight[b] ?? 0) - (weight[a] ?? 0))
    .slice(0, 2);
}

/**
 * Build an editable starter deck from an archetype centroid: the centroid's
 * highest-share cards (respecting copy limits, floored tiny shares), the
 * archetype's dominant inks declared, its name as the title. Returns null
 * when the centroid maps to nothing in the snapshot.
 */
export function buildStarterDeck(
  archetype: MetaArchetype,
  cards: Card[],
  format: Format,
  targetSize = 60
): DeckState | null {
  const registry = buildCanonicalRegistry(cards);
  const idToCanonical = new Map<number, Card>();
  for (const card of registry.canonicalByGroup.values()) idToCanonical.set(card.id, card);

  const inks = dominantInks(archetype, idToCanonical);
  if (inks.length === 0) return null;
  const fitsPair = (card: Card): boolean =>
    card.inks.length > 0 &&
    card.inks.every((ink) => inks.includes(ink)) &&
    (card.inks.length === 1 || card.inks.length === 2);

  // centroid entries in share order, mapped to snapshot cards
  const entries = Object.entries(archetype.centroid)
    .map(([id, share]) => ({ card: idToCanonical.get(Number(id)), share }))
    .filter((e): e is { card: Card; share: number } => e.card !== undefined && e.share >= SHARE_FLOOR)
    .filter((e) => fitsPair(e.card))
    .sort((a, b) => b.share - a.share || a.card.id - b.card.id);
  if (entries.length === 0) return null;

  // group copy limits across prints (canonical cards are one per group, so
  // the limit applies directly per card)
  const cardsRecord: Record<number, number> = {};
  let total = 0;
  for (const { card, share } of entries) {
    if (total >= targetSize) break;
    const limit = card.maxCopies === 'unlimited' ? targetSize : Math.min(card.maxCopies, 4);
    const copies = Math.max(1, Math.min(limit, Math.round(share * targetSize)));
    const capped = Math.min(copies, targetSize - total);
    if (capped <= 0) break;
    cardsRecord[card.id] = (cardsRecord[card.id] ?? 0) + capped;
    total += capped;
  }
  if (total === 0) return null;

  return {
    title: archetype.name,
    inks,
    format,
    cards: cardsRecord,
  };
}
