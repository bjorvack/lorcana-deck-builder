import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Card, DeckState, Format, Ink, SetInfo, SnapshotMeta } from './data/types';
import { loadSnapshot } from './data/load';
import { decodeDeck, emptyDeck, loadSaved, saveDeck } from './deck/codec';

interface AppState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  cards: Card[];
  sets: SetInfo[];
  meta: SnapshotMeta | null;
  deck: DeckState;
  setInks: (inks: Ink[]) => void;
  setFormat: (format: Format) => void;
  setTitle: (title: string) => void;
  addCard: (id: number) => 'added' | 'limit' | 'unknown';
  setCount: (id: number, count: number) => void;
  removeCard: (id: number) => void;
  replaceDeck: (deck: DeckState) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<AppState['status']>('loading');
  const [error, setError] = useState<string>();
  const [cards, setCards] = useState<Card[]>([]);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [meta, setMeta] = useState<SnapshotMeta | null>(null);
  const [deck, setDeck] = useState<DeckState>(emptyDeck);

  useEffect(() => {
    loadSnapshot()
      .then((snap) => {
        setCards(snap.cards);
        setSets(snap.sets);
        setMeta(snap.meta);
        // shared URL wins over localStorage
        const params = new URLSearchParams(window.location.search);
        const shared = params.get('d');
        const restored = shared ? decodeDeck(shared) : loadSaved();
        if (restored) setDeck(restored);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
  }, []);

  useEffect(() => {
    if (status === 'ready') saveDeck(deck);
  }, [deck, status]);

  const value = useMemo<AppState>(() => {
    const patch = (fn: (d: DeckState) => DeckState): void => setDeck((d) => fn(d));
    return {
      status,
      error,
      cards,
      sets,
      meta,
      deck,
      setInks: (inks) => patch((d) => ({ ...d, inks: inks.slice(0, 2) })),
      setFormat: (format) => patch((d) => ({ ...d, format })),
      setTitle: (title) => patch((d) => ({ ...d, title })),
      addCard: (id) => {
        const card = cards.find((c) => c.id === id);
        if (!card) return 'unknown';
        const current = deck.cards[id] ?? 0;
        if (card.maxCopies !== 'unlimited' && current >= card.maxCopies) return 'limit';
        patch((d) => ({ ...d, cards: { ...d.cards, [id]: (d.cards[id] ?? 0) + 1 } }));
        return 'added';
      },
      setCount: (id, count) =>
        patch((d) => {
          const cardsNext = { ...d.cards };
          if (count <= 0) delete cardsNext[id];
          else cardsNext[id] = count;
          return { ...d, cards: cardsNext };
        }),
      removeCard: (id) =>
        patch((d) => {
          const cardsNext = { ...d.cards };
          delete cardsNext[id];
          return { ...d, cards: cardsNext };
        }),
      replaceDeck: (next) => setDeck(next),
    };
  }, [status, error, cards, sets, meta, deck]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
