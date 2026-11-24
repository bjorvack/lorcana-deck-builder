import { type ReactNode, useMemo } from 'react';
import type { Ink } from '../data/types';
import { INKS } from '../data/types';
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
import {
  btnCls,
  btnPrimaryCls,
  mutedCls,
  panelCls,
  panelHeadingCls,
} from './styles';
import { useCalcDeck } from './useCalcDeck';
import { useMetaModel } from './useMetaModel';

const selectCls =
  'bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-[9px] text-sm leading-[normal]';
const inkChipCls =
  'bg-transparent border-2 border-line rounded-[14px] px-2.5 py-[3px] text-xs leading-[normal] cursor-pointer';

const violationCls = (rule: string): string => {
  const warn = rule === 'card-count' || rule === 'format';
  return `text-[13px] my-1 ${warn ? 'text-warn' : 'text-error'}`;
};

export function DeckView(): ReactNode {
  const {
    cards,
    deck,
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
    <div>
      <section className={`${panelCls} flex flex-wrap items-center gap-2.5`}>
        <input
          className="bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-2.5 text-[15px] font-semibold w-60"
          aria-label="Deck title"
          value={deck.title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {INKS.map((ink) => (
            <button
              type="button"
              key={ink}
              className={`${inkChipCls} ${deck.inks.includes(ink) ? 'text-parchment bg-white/[0.06]' : 'text-parchment-muted'}`}
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
          className={selectCls}
        >
          <option value="core">Core Constructed</option>
          <option value="infinity">Infinity</option>
        </select>
        <span
          className={`ml-auto font-bold text-base ${stats.total >= 60 ? 'text-ok' : 'text-warn'}`}
        >
          {stats.total} / 60
        </span>
      </section>

      <div className="grid grid-cols-[minmax(320px,1fr)_minmax(360px,480px)] gap-3 items-start max-[900px]:grid-cols-1">
        <section className={panelCls}>
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

        <aside>
          <section className={panelCls}>
            <h3 className={panelHeadingCls}>Validation</h3>
            {violations.length === 0 ? (
              <p className="text-ok">
                {stats.total >= 60
                  ? '✓ Legal 60-card deck'
                  : `✓ No rule problems (add ${60 - stats.total} more cards)`}
              </p>
            ) : (
              <ul className="m-0 pl-[18px]">
                {violations.map((v, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: violations have no stable identity and the list re-renders fully each time
                  <li key={i} className={violationCls(v.rule)}>
                    {v.message}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!isValid && Object.keys(deck.cards).length > 0 && (
            <SuggestionsPanel
              meta={{ model: metaModel }}
              deck={calcDeck}
              byId={byId}
              onAddCard={addCard}
            />
          )}

          <IoPanel deck={deck} byId={byId} replaceDeck={replaceDeck} />
        </aside>
      </div>

      {stats.total === 0 ? (
        <section className={`${panelCls} flex flex-col gap-2.5 items-start`}>
          <h3 className={panelHeadingCls}>Start building</h3>
          <p className={mutedCls}>
            Your deck is empty. Browse the full catalog, or let the generator
            draft a legal 60-card deck for you.
          </p>
          <div className="flex gap-2 mb-2">
            <a className={btnCls} href="#/browse">
              Browse cards
            </a>
            <a className={btnPrimaryCls} href="#/generate">
              Open the generator
            </a>
          </div>
        </section>
      ) : (
        <StatsGrid stats={stats} curve={curve} distinct={distinct} />
      )}

      {isValid && (
        <AnalysisPanel fingerprint={fingerprint} deck={calcDeck} byId={byId} />
      )}
    </div>
  );
}
