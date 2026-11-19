import type { Card, SetInfo, SnapshotMeta } from './types';

export interface Snapshot {
  cards: Card[];
  sets: SetInfo[];
  meta: SnapshotMeta;
}

export async function loadSnapshot(): Promise<Snapshot> {
  const base = import.meta.env.BASE_URL ?? '/';
  // revalidate: the snapshot refreshes weekly and Pages caches for 10 minutes
  const [cardsRes, setsRes, metaRes] = await Promise.all([
    fetch(`${base}data/cards.min.json`, { cache: 'no-cache' }),
    fetch(`${base}data/sets.json`, { cache: 'no-cache' }),
    fetch(`${base}data/meta.json`, { cache: 'no-cache' }),
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
