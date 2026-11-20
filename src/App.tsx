import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Snapshot } from './data/load';
import { validateDeck } from './rules/engine';
import { AppProvider, useApp } from './state';
import { computeStats } from './stats/stats';
import { Browse } from './ui/Browse';
import { CardPreviewHost } from './ui/CardPreview';
import { DeckView } from './ui/DeckView';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { GeneratorView } from './ui/GeneratorView';
import { useCalcDeck } from './ui/useCalcDeck';

type Tab = 'browse' | 'deck' | 'generate';

function parseHashTab(): Tab {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return hash === 'deck' || hash === 'generate' ? hash : 'browse';
}

function useHashTab(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState<Tab>(parseHashTab);
  useEffect(() => {
    const onHash = (): void => setTab(parseHashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = (next: Tab): void => {
    window.location.hash = `#/${next}`;
    setTab(next);
  };
  return [tab, navigate];
}

function Shell(): ReactNode {
  const { status, error, meta, byId } = useApp();
  const [tab, navigate] = useHashTab();
  const calcDeck = useCalcDeck();
  // derived per real deck change, not per render or title keystroke
  const violations = useMemo(
    () => (status === 'ready' ? validateDeck(calcDeck, byId) : []),
    [status, calcDeck, byId],
  );
  const stats = useMemo(
    () => (status === 'ready' ? computeStats(calcDeck, byId) : null),
    [status, calcDeck, byId],
  );
  const violationCount = violations.length;

  if (status === 'loading')
    return (
      <div className="grid place-items-center py-20 text-parchment-muted">
        Loading card data…
      </div>
    );
  if (status === 'error')
    return (
      <div className="grid place-items-center py-20 text-error">{error}</div>
    );

  return (
    <div className="flex flex-col min-h-screen">
      <header className="flex items-center gap-4 py-2.5 px-4 bg-panel border-b border-line sticky top-0 z-10">
        <span className="font-bold text-gold tracking-[0.3px]">
          <span className="max-[720px]:hidden">Lorcana Deck Builder</span>
          <span className="hidden max-[720px]:inline" aria-hidden="true">
            LDB
          </span>
        </span>
        <nav className="flex gap-1.5">
          {(['browse', 'deck', 'generate'] as Tab[]).map((t) => (
            <button
              type="button"
              key={t}
              className={`bg-transparent border py-1.5 px-3.5 rounded-lg cursor-pointer text-[15px] ${tab === t ? 'border-line text-parchment bg-panel-2' : 'border-transparent text-parchment-muted'}`}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => navigate(t)}
            >
              {t === 'browse' ? 'Browse' : t === 'deck' ? 'Deck' : 'Generator'}
              {t === 'deck' && violationCount > 0 && (
                <span className="bg-error text-white rounded-[10px] text-[11px] py-px px-1.5 ml-1.5">
                  {violationCount}
                </span>
              )}
              {t === 'deck' && stats && (
                <span className="bg-panel-2 border border-line rounded-[10px] text-[11px] py-px px-1.5 ml-1.5 text-parchment-muted">
                  {stats.total}
                </span>
              )}
            </button>
          ))}
        </nav>
        {meta && (
          <span className="ml-auto text-xs text-parchment-muted max-[720px]:hidden">
            {meta.cardCount} cards · data {meta.generatedOn.slice(0, 10)}
          </span>
        )}
      </header>
      <main className="flex-1 py-3 px-4 max-w-[1500px] mx-auto w-full">
        {tab === 'browse' && <Browse />}
        {tab === 'deck' && <DeckView />}
        {tab === 'generate' && (
          <GeneratorView onGenerated={() => navigate('deck')} />
        )}
      </main>
      <footer className="py-3 px-4 text-xs text-center text-parchment-muted">
        Data: lorcanajson.org (weekly snapshot) · prices/images: Lorcast ·
        Unofficial fan tool, not affiliated with Disney or Ravensburger.
      </footer>
      <CardPreviewHost />
    </div>
  );
}

export default function App({
  snapshot,
}: {
  /** pre-loaded snapshot (tests); production fetches it */
  snapshot?: Snapshot;
}): ReactNode {
  return (
    <ErrorBoundary>
      <AppProvider snapshot={snapshot}>
        <Shell />
      </AppProvider>
    </ErrorBoundary>
  );
}
