import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../state';
import { computeStats } from '../stats/stats';
import { curveConsistency } from '../stats/curve';
import { canAddCard, validateDeck } from '../rules/engine';
import { deckFromText, deckToText, encodeDeck } from '../deck/codec';
import { INK_COLORS, StatList } from './components';
import { CostBadge, CurveChart, CurveConsistencyChart, InkDots, InkMatrix, InkSplitBar, StatDistributions } from './charts';
import { AnalysisPanel } from './AnalysisPanel';
import { computeFingerprintCached } from '../stats/fingerprint';
import { loadMetaModel, isStale, type MetaModel } from '../meta/infer';
import type { Card, Ink } from '../data/types';
import { indexById } from '../data/load';

const ALL_INKS: Ink[] = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];

export function DeckView(): ReactNode {
  const { cards, deck, meta, setInks, setFormat, setTitle, setCount, removeCard, replaceDeck, addCard } = useApp();
  const byId = useMemo(() => indexById(cards), [cards]);
  const violations = useMemo(() => validateDeck(deck, byId), [deck, byId]);
  const stats = useMemo(() => computeStats(deck, byId), [deck, byId]);
  const [metaModel, setMetaModel] = useState<MetaModel | null>(null);
  useEffect(() => {
    let alive = true;
    loadMetaModel().then((m) => {
      if (alive) setMetaModel(m);
    });
    return () => {
      alive = false;
    };
  }, []);
  const metaState = useMemo(
    () => ({ model: metaModel, stale: metaModel !== null && meta !== null && isStale(metaModel, meta.generatedOn) }),
    [metaModel, meta]
  );
  const curve = useMemo(() => curveConsistency(deck, byId), [deck, byId]);
  const isValid = useMemo(() => violations.length === 0, [violations]);
  const fingerprint = useMemo(
    () => (isValid ? computeFingerprintCached(deck, byId) : null),
    [isValid, deck, byId]
  );
  const [io, setIo] = useState<'none' | 'import' | 'export'>('none');
  const [ioText, setIoText] = useState('');
  const [ioNote, setIoNote] = useState<string>();
  const fileRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState('');
  const [addNote, setAddNote] = useState<string>();

  // only cards that can legally be added to the current deck (inks, format,
  // copy limits incl. text exemptions) are offered here; duplicate prints of
  // the same full name collapse into one row (prefer the print already in deck)
  const addResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const groupCount = (card: Card): number =>
      [...Object.entries(deck.cards)].reduce(
        (s, [id, count]) => s + (byId.get(Number(id))?.groupKey === card.groupKey ? count : 0),
        0
      );
    const byName = new Map<string, { card: Card; group: number }>();
    for (const card of cards) {
      if (!card.fullName.toLowerCase().includes(q)) continue;
      const check = canAddCard(deck, card, byId);
      if (!check.ok) continue;
      const existing = byName.get(card.fullName);
      const preferThis = (deck.cards[card.id] ?? 0) > 0 && !(existing && (deck.cards[existing.card.id] ?? 0) > 0);
      if (!existing || preferThis) byName.set(card.fullName, { card, group: groupCount(card) });
    }
    return [...byName.values()]
      .sort(
        (a, b) =>
          Number(b.card.fullName.toLowerCase().startsWith(q)) -
            Number(a.card.fullName.toLowerCase().startsWith(q)) ||
          a.card.cost - b.card.cost ||
          a.card.fullName.localeCompare(b.card.fullName)
      )
      .slice(0, 8);
  }, [query, cards, deck, byId]);
  const queryTooShort = query.trim().length < 2;
  const noValidMatches = !queryTooShort && query.trim().length >= 2 && addResults.length === 0;

  const entries = Object.entries(deck.cards)
    .map(([id, count]) => ({ card: byId.get(Number(id)), count }))
    .filter((e): e is { card: NonNullable<typeof e.card>; count: number } => e.card !== undefined)
    .sort((a, b) => a.card.cost - b.card.cost || a.card.fullName.localeCompare(b.card.fullName));

  const toggleInk = (ink: Ink): void => {
    if (deck.inks.includes(ink)) setInks(deck.inks.filter((i) => i !== ink));
    else setInks([...deck.inks, ink].slice(-2));
  };

  const exportText = (): void => {
    setIo('export');
    setIoText(deckToText(deck, byId));
    setIoNote(undefined);
  };

  const importText = (): void => {
    const result = deckFromText(ioText, byId, { title: deck.title, inks: deck.inks, format: deck.format });
    replaceDeck(result.deck);
    setIoNote(
      result.unmatched.length > 0
        ? `Imported with ${result.unmatched.length} unmatched line(s): ${result.unmatched.join(' | ')}`
        : 'Imported.'
    );
  };

  const share = (): void => {
    const url = `${window.location.origin}${window.location.pathname}?d=${encodeDeck(deck)}#/deck`;
    void navigator.clipboard?.writeText(url);
    setIoNote('Share link copied to clipboard.');
  };

  return (
    <div className="deckview">
      <section className="deck-controls panel">
        <input className="deck-title" value={deck.title} onChange={(e) => setTitle(e.target.value)} />
        <div className="inkpicker">
          {ALL_INKS.map((ink) => (
            <button
              key={ink}
              className={`inkchip ${deck.inks.includes(ink) ? 'active' : ''}`}
              style={{ borderColor: deck.inks.includes(ink) ? INK_COLORS[ink] : undefined }}
              onClick={() => toggleInk(ink)}
            >
              {ink}
            </button>
          ))}
        </div>
        <select value={deck.format} onChange={(e) => setFormat(e.target.value as 'core' | 'infinity')}>
          <option value="core">Core Constructed</option>
          <option value="infinity">Infinity</option>
        </select>
        <span className={`count ${stats.total >= 60 ? 'ok' : 'warn'}`}>{stats.total} / 60</span>
      </section>

      <div className="deck-columns">
        <section className="panel decklist">
          <h3>Add cards</h3>
          <div className="addsearch">
            <input
              type="search"
              placeholder={deck.inks.length === 0 ? 'Pick 1–2 inks first, then search…' : 'Search cards to add — only legal cards shown…'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addResults.length > 0) {
                  const r = addResults[0]!;
                  const result = addCard(r.card.id);
                  setAddNote(result === 'limit' ? 'Copy limit reached' : undefined);
                }
              }}
            />
            {addResults.length > 0 && (
              <div className="addresults">
                {addResults.map(({ card, group }) => (
                  <div key={card.id} className="addrow">
                    <CostBadge card={card} size="sm" />
                    <InkDots inks={card.inks} inline />
                    <span className="addrow-name" title={card.fullName}>{card.fullName}</span>
                    <span className="addrow-indeck muted">{group > 0 ? `${group}×` : ''}</span>
                    <button className="btn btn-mini" onClick={() => addCard(card.id)}>+</button>
                  </div>
                ))}
              </div>
            )}
            {noValidMatches && (
              <p className="muted addsearch-hint">
                {deck.inks.length === 0
                  ? 'No inks declared — pick 1–2 inks above to add cards.'
                  : 'No valid matches — other results are off-ink, out of format, or at their copy limit.'}
              </p>
            )}
            {addNote && <p className="note">{addNote}</p>}
          </div>
          <h3>Deck ({entries.length} distinct)</h3>
          {entries.length === 0 && <p className="muted">Empty — add cards from Browse or run the Generator.</p>}
          {entries.map(({ card, count }) => (
            <div key={card.id} className="deckrow">
              <span className="deckrow-count">
                <button className="btn btn-mini" onClick={() => setCount(card.id, count - 1)}>−</button>
                {count}
                <button className="btn btn-mini" onClick={() => setCount(card.id, count + 1)}>+</button>
              </span>
              <span className="deckrow-name" title={card.fullName}>{card.fullName}</span>
              <CostBadge card={card} />
              <button className="btn btn-mini" onClick={() => removeCard(card.id)}>✕</button>
              <span className="row-preview" aria-hidden>
                {card.images.thumb && <img src={card.images.thumb} alt="" loading="lazy" />}
                <span className="row-preview-caption">{card.fullName}</span>
              </span>
            </div>
          ))}
        </section>

        <aside className="deck-side">
          <section className="panel validation">
            <h3>Validation</h3>
            {violations.length === 0 ? (
              <p className="ok">{stats.total >= 60 ? '✓ Deck is legal' : `✓ No rule problems (add ${60 - stats.total} more cards)`}</p>
            ) : (
              <ul className="violations">
                {violations.map((v, i) => (
                  <li key={i} className={`violation rule-${v.rule}`}>{v.message}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel io">
            <h3>Import / Export / Share</h3>
            <div className="btnrow">
              <button className="btn" onClick={exportText}>Export</button>
              <button className="btn" onClick={() => setIo('import')}>Import</button>
              <button className="btn" onClick={share}>Copy share link</button>
            </div>
            {io !== 'none' && (
              <>
                <textarea
                  ref={fileRef}
                  rows={8}
                  placeholder={'4x Aladdin - Heroic Outlaw\n3x Elsa - Spirit of Winter'}
                  value={ioText}
                  onChange={(e) => setIoText(e.target.value)}
                />
                {io === 'import' && <button className="btn btn-primary" onClick={importText}>Import text</button>}
              </>
            )}
            {ioNote && <p className="note">{ioNote}</p>}
          </section>
        </aside>
      </div>

      <section className="statsgrid">
        <div className="panel span2">
          <div className="chips">
            <span className="chip-big"><strong>{stats.total}</strong> cards · {entries.length} distinct</span>
            <span className="chip-big"><strong>{stats.inkable}</strong> inkable ({Math.round(stats.inkablePct * 100)}%)</span>
            {curve && (
              <span className="chip-big">
                on curve through turn <strong>{Math.floor(curve.onCurveThrough)}</strong>
                <span className="muted"> (median of {curve.trials.toLocaleString()} sims)</span>
              </span>
            )}
            {stats.avgStrength !== null && (
              <span className="chip-big muted">avg S/W/L {stats.avgStrength.toFixed(1)}/{stats.avgWillpower?.toFixed(1)}/{stats.avgLore?.toFixed(1)}</span>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Ink curve</h3>
          <CurveChart buckets={stats.inkabilityByCost} />
        </div>

        <div className="panel">
          <h3>Curve consistency</h3>
          {curve ? (
            <CurveConsistencyChart byTurn={curve.byTurn} expectedInk={curve.expectedInk} />
          ) : (
            <p className="muted">—</p>
          )}
        </div>

        <div className="panel">
          <h3>Cost × ink</h3>
          {stats.costInkRows.length > 0 ? (
            <InkMatrix rows={stats.costInkRows} maxCost={stats.maxCost} />
          ) : (
            <p className="muted">—</p>
          )}
        </div>

        <div className="panel">
          <h3>Ink split</h3>
          <InkSplitBar byInk={stats.byInk} byInkDual={stats.byInkDual} />
          <h4 className="mt">Types</h4>
          <div className="chips">
            {Object.entries(stats.byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <span key={type} className="chip">{count} {type.toLowerCase()}</span>
              ))}
          </div>
        </div>

        <div className="panel">
          <h3>Character stats</h3>
          <StatDistributions distributions={stats.distributions} />
        </div>

        <div className="panel span2 morestats">
          <StatList title="Tags" entries={Object.entries(stats.byTag).sort((a, b) => b[1] - a[1]).slice(0, 10)} />
          <StatList title="Rarity" entries={Object.entries(stats.byRarity).sort((a, b) => b[1] - a[1])} />
          <StatList title="Franchises" entries={Object.entries(stats.byFranchise).sort((a, b) => b[1] - a[1]).slice(0, 10)} />
        </div>
      </section>

      {isValid && <AnalysisPanel fingerprint={fingerprint} meta={metaState} deck={deck} byId={byId} />}
    </div>
  );
}
