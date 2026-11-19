import { type ReactNode, useMemo } from 'react';
import type { Ink } from '../data/types';
import { INKS } from '../data/types';
import { isStale } from '../meta/infer';
import { resolveEntries, validateDeck } from '../rules/engine';
import { useApp } from '../state';
import { curveConsistency } from '../stats/curve';
import { computeFingerprintCached } from '../stats/fingerprint';
import { computeStats } from '../stats/stats';
import { AddSearch } from './AddSearch';
import { AnalysisPanel, SuggestionsPanel } from './AnalysisPanel';
import { INK_COLORS } from './components';
import { DeckList } from './DeckList';
import { IoPanel } from './IoPanel';
import { StatsGrid } from './StatsGrid';
import { useCalcDeck } from './useCalcDeck';
import { useMetaModel } from './useMetaModel';

export function DeckView(): ReactNode {
  const {
    cards,
    deck,
    meta,
    byId,
    setInks,
    setFormat,
    setTitle,
    setCount,
    removeCard,
    replaceDeck,
    addCard,
  } = useApp();
  // computation runs on the calc deck (stable across title-only edits);
  // display reads the real deck from context
  const calcDeck = useCalcDeck();
  const violations = useMemo(
    () => validateDeck(calcDeck, byId),
    [calcDeck, byId],
  );
  const stats = useMemo(() => computeStats(calcDeck, byId), [calcDeck, byId]);
  const metaModel = useMetaModel();
  const metaState = useMemo(
    () => ({
      model: metaModel,
      stale:
        metaModel !== null &&
        meta !== null &&
        isStale(metaModel, meta.generatedOn),
    }),
    [metaModel, meta],
  );
  const curve = useMemo(
    () => curveConsistency(calcDeck, byId),
    [calcDeck, byId],
  );
  const isValid = useMemo(() => violations.length === 0, [violations]);
  const fingerprint = useMemo(
    () => (isValid ? computeFingerprintCached(calcDeck, byId) : null),
    [isValid, calcDeck, byId],
  );
  const distinct = useMemo(
    () => resolveEntries(calcDeck, byId).length,
    [calcDeck, byId],
  );

  const toggleInk = (ink: Ink): void => {
    if (deck.inks.includes(ink)) setInks(deck.inks.filter((i) => i !== ink));
    else setInks([...deck.inks, ink].slice(-2));
  };

  return (
    <div className="deckview">
      <section className="deck-controls panel">
        <input
          className="deck-title"
          aria-label="Deck title"
          value={deck.title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="inkpicker">
          {INKS.map((ink) => (
            <button
              type="button"
              key={ink}
              className={`inkchip ${deck.inks.includes(ink) ? 'active' : ''}`}
              aria-pressed={deck.inks.includes(ink)}
              style={{
                borderColor: deck.inks.includes(ink)
                  ? INK_COLORS[ink]
                  : undefined,
              }}
              onClick={() => toggleInk(ink)}
            >
              {ink}
            </button>
          ))}
        </div>
        <select
          value={deck.format}
          onChange={(e) => setFormat(e.target.value as 'core' | 'infinity')}
        >
          <option value="core">Core Constructed</option>
          <option value="infinity">Infinity</option>
        </select>
        <span className={`count ${stats.total >= 60 ? 'ok' : 'warn'}`}>
          {stats.total} / 60
        </span>
      </section>

      <div className="deck-columns">
        <section className="panel decklist">
          <AddSearch
            cards={cards}
            calcDeck={calcDeck}
            byId={byId}
            addCard={addCard}
          />
          <DeckList
            deck={deck}
            byId={byId}
            setCount={setCount}
            addCard={addCard}
            removeCard={removeCard}
          />
        </section>

        <aside className="deck-side">
          <section className="panel validation">
            <h3>Validation</h3>
            {violations.length === 0 ? (
              <p className="ok">
                {stats.total >= 60
                  ? '✓ Legal 60-card deck'
                  : `✓ No rule problems (add ${60 - stats.total} more cards)`}
              </p>
            ) : (
              <ul className="violations">
                {violations.map((v, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: violations have no stable identity and the list re-renders fully each time
                  <li key={i} className={`violation rule-${v.rule}`}>
                    {v.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!isValid && Object.keys(deck.cards).length > 0 && (
            <SuggestionsPanel
              meta={metaState}
              deck={calcDeck}
              byId={byId}
              onAddCard={addCard}
            />
          )}

          <IoPanel deck={deck} byId={byId} replaceDeck={replaceDeck} />
        </aside>
      </div>

      <StatsGrid stats={stats} curve={curve} distinct={distinct} />

      {isValid && (
        <AnalysisPanel
          fingerprint={fingerprint}
          meta={metaState}
          deck={calcDeck}
          byId={byId}
        />
      )}
    </div>
  );
}
