import type { Card, SetInfo, SnapshotMeta } from './types';

export interface Snapshot {
  cards: Card[];
  sets: SetInfo[];
  meta: SnapshotMeta;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const base = import.meta.env.BASE_URL ?? '/';
  const [cardsRes, setsRes, metaRes] = await Promise.all([
    fetch(`${base}data/cards.min.json`),
    fetch(`${base}data/sets.json`),
    fetch(`${base}data/meta.json`),
  ]);
  if (!cardsRes.ok || !setsRes.ok || !metaRes.ok) {
    throw new Error('Failed to load card data (snapshot files missing)');
  }
  const cards = (await cardsRes.json()) as { cards: Card[] };
  const sets = (await setsRes.json()) as { sets: SetInfo[] };
  const meta = (await metaRes.json()) as SnapshotMeta;
  return { cards: cards.cards, sets: sets.sets, meta };
}

export function indexById(cards: Card[]): Map<number, Card> {
  return new Map(cards.map((c) => [c.id, c]));
}
