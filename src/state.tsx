import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { indexById, loadSnapshot, type Snapshot } from './data/load';
import type {
  Card,
  DeckState,
  Format,
  Ink,
  SetInfo,
  SnapshotMeta,
} from './data/types';
import { applyAdd } from './deck/add';
import {
  decodeDeck,
  emptyDeck,
  encodeDeck,
  loadSaved,
  saveDeck,
} from './deck/codec';

/** result of the single add-card path — refusal reasons are identical on every surface */
export type AddResult =
  | { status: 'added' }
  | { status: 'refused'; reason: string }
  | { status: 'unknown' };

interface AppState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  cards: Card[];
  sets: SetInfo[];
  meta: SnapshotMeta | null;
  deck: DeckState;
  /** catalog index, built once per snapshot — shared by every view */
  byId: Map<number, Card>;
  setInks: (inks: Ink[]) => void;
  setFormat: (format: Format) => void;
  setTitle: (title: string) => void;
  addCard: (id: number) => AddResult;
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

export function AppProvider({
  children,
  snapshot,
}: {
  children: ReactNode;
  /** pre-loaded snapshot (tests, storybook); defaults to fetching it */
  snapshot?: Snapshot;
}): ReactNode {
  const [status, setStatus] = useState<AppState['status']>('loading');
  const [error, setError] = useState<string>();
  const [cards, setCards] = useState<Card[]>([]);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [meta, setMeta] = useState<SnapshotMeta | null>(null);
  const [deck, setDeck] = useState<DeckState>(emptyDeck);

  useEffect(() => {
    const applySnapshot = (snap: Snapshot): void => {
      setCards(snap.cards);
      setSets(snap.sets);
      setMeta(snap.meta);
      // a shared URL wins over localStorage on first load; the param then
      // stays and is kept in sync by the URL-sync effect below, so reloads
      // restore the deck including edits made after opening the link
      const params = new URLSearchParams(window.location.search);
      const shared = params.get('d');
      // a corrupt share payload falls back to the saved deck
      const restored = (shared ? decodeDeck(shared) : null) ?? loadSaved();
      if (restored) setDeck(restored);
      setStatus('ready');
    };
    if (snapshot) {
      applySnapshot(snapshot);
      return;
    }
    loadSnapshot()
      .then(applySnapshot)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });
  }, [snapshot]);

  useEffect(() => {
    if (status === 'ready') saveDeck(deck);
  }, [deck, status]);

  // the address bar always encodes the current deck: the share parameter is
  // rewritten in place (no history entries) and dropped again once the deck
  // is back to its empty encoding, keeping a clean URL for a fresh start
  useEffect(() => {
    if (status !== 'ready') return;
    const encoded = encodeDeck(deck);
    const target = encoded === encodeDeck(emptyDeck()) ? '' : encoded;
    const params = new URLSearchParams(window.location.search);
    if (params.get('d') === target) return;
    if (target === '') params.delete('d');
    else params.set('d', target);
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, [deck, status]);

  const byId = useMemo(() => indexById(cards), [cards]);

  const value = useMemo<AppState>(() => {
    const patch = (fn: (d: DeckState) => DeckState): void =>
      setDeck((d) => fn(d));
    return {
      status,
      error,
      cards,
      sets,
      meta,
      deck,
      byId,
      setInks: (inks) => patch((d) => ({ ...d, inks: inks.slice(0, 2) })),
      setFormat: (format) => patch((d) => ({ ...d, format })),
      setTitle: (title) => patch((d) => ({ ...d, title })),
      addCard: (id) => {
        const card = byId.get(id);
        if (!card) return { status: 'unknown' };
        const { deck: next, result } = applyAdd(deck, card, byId);
        if (result.status === 'added') patch(() => next);
        return result;
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
  }, [status, error, cards, sets, meta, deck, byId]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
