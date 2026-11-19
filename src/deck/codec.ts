import type { Card, DeckState, Format, Ink } from '../data/types';

export const STORAGE_KEY = 'ldb.deck.v1';

export function emptyDeck(): DeckState {
  return { title: 'New Deck', inks: [], format: 'core', cards: {} };
}

export function saveDeck(deck: DeckState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deck));
}

export function loadSaved(): DeckState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitize(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function sanitize(value: unknown): DeckState | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<DeckState>;
  if (typeof v.cards !== 'object' || v.cards === null) return null;
  const cards: Record<number, number> = {};
  for (const [id, count] of Object.entries(v.cards)) {
    const n = Number(id);
    if (Number.isInteger(n) && n > 0 && typeof count === 'number' && count > 0)
      cards[n] = Math.floor(count);
  }
  const inks = Array.isArray(v.inks)
    ? v.inks.filter((i): i is Ink => typeof i === 'string')
    : [];
  return {
    title: typeof v.title === 'string' ? v.title : 'New Deck',
    inks: inks.slice(0, 2),
    format: v.format === 'infinity' ? 'infinity' : 'core',
    cards,
  };
}

// ---- plain text: "4x Aladdin - Heroic Outlaw" (also "4 Aladdin…" / "Aladdin - … x4")

export interface TextImportResult {
  deck: DeckState;
  unmatched: string[];
}

export function deckToText(deck: DeckState, byId: Map<number, Card>): string {
  const entries = Object.entries(deck.cards)
    .map(([id, count]) => ({ card: byId.get(Number(id)), count }))
    .filter((e): e is { card: Card; count: number } => e.card !== undefined)
    .sort((a, b) => a.card.fullName.localeCompare(b.card.fullName));
  return entries.map((e) => `${e.count}x ${e.card.fullName}`).join('\n');
}

const byNameCache = (byId: Map<number, Card>): Map<string, Card> => {
  const map = new Map<string, Card>();
  for (const card of byId.values()) {
    map.set(card.fullName.toLowerCase(), card);
  }
  return map;
};

export function deckFromText(
  text: string,
  byId: Map<number, Card>,
  base?: Partial<DeckState>,
): TextImportResult {
  const byName = byNameCache(byId);
  const cards: Record<number, number> = {};
  const unmatched: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    let count = 1;
    let name = line;
    const prefix = /^(\d+)\s*[xX]?\s+(.+)$/.exec(line);
    const suffix = /^(.+?)\s+[xX]\s*(\d+)$/.exec(line);
    if (prefix) {
      count = Number(prefix[1]);
      name = prefix[2]!;
    } else if (suffix) {
      count = Number(suffix[2]);
      name = suffix[1]!;
    }
    const card = byName.get(name.toLowerCase().trim());
    if (card) {
      cards[card.id] = (cards[card.id] ?? 0) + count;
    } else {
      unmatched.push(line);
    }
  }
  return {
    deck: {
      ...emptyDeck(),
      ...base,
      cards,
    },
    unmatched,
  };
}

// ---- share URLs: ?d=<base64url(json)>

export function encodeDeck(deck: DeckState): string {
  const compact = {
    t: deck.title,
    i: deck.inks,
    f: deck.format,
    c: Object.entries(deck.cards).map(([id, count]) => [Number(id), count]),
  };
  const json = JSON.stringify(compact);
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeDeck(encoded: string): DeckState | null {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const compact = JSON.parse(json) as {
      t?: string;
      i?: Ink[];
      f?: Format;
      c?: [number, number][];
    };
    const cards: Record<number, number> = {};
    for (const [id, count] of compact.c ?? []) cards[id] = count;
    return sanitize({
      title: compact.t,
      inks: compact.i,
      format: compact.f,
      cards,
    });
  } catch {
    return null;
  }
}
