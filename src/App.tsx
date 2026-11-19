import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Snapshot } from './data/load';
import { validateDeck } from './rules/engine';
import { AppProvider, useApp } from './state';
import { computeStats } from './stats/stats';
import { Browse } from './ui/Browse';
import { CardPreviewHost } from './ui/CardPreview';
import { DeckView } from './ui/DeckView';
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
    return <div className="center muted">Loading card data…</div>;
  if (status === 'error') return <div className="center error">{error}</div>;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Lorcana Deck Builder</span>
        <nav>
          {(['browse', 'deck', 'generate'] as Tab[]).map((t) => (
            <button
              type="button"
              key={t}
              className={`navbtn ${tab === t ? 'active' : ''}`}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => navigate(t)}
            >
              {t === 'browse' ? 'Browse' : t === 'deck' ? 'Deck' : 'Generator'}
              {t === 'deck' && violationCount > 0 && (
                <span className="badge">{violationCount}</span>
              )}
              {t === 'deck' && stats && (
                <span className="count-pill">{stats.total}</span>
              )}
            </button>
          ))}
        </nav>
        {meta && (
          <span className="muted datasrc">
            {meta.cardCount} cards · data {meta.generatedOn.slice(0, 10)}
          </span>
        )}
      </header>
      <main>
        {tab === 'browse' && <Browse />}
        {tab === 'deck' && <DeckView />}
        {tab === 'generate' && (
          <GeneratorView onGenerated={() => navigate('deck')} />
        )}
      </main>
      <footer className="muted footer">
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
    <AppProvider snapshot={snapshot}>
      <Shell />
    </AppProvider>
  );
}
