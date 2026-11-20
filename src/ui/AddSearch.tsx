import { type ReactNode, useMemo, useState } from 'react';
import type { Card, DeckState } from '../data/types';
import { groupCountsOf } from '../meta/score';
import { canAddCard } from '../rules/engine';
import type { AddResult } from '../state';
import { CostBadge, InkDots } from './charts';
import { panelHeadingCls } from './styles';

/**
 * Legal-card search with quick add. Only cards that can legally be added to
 * the current deck (inks, format, copy limits incl. text exemptions) are
 * offered; duplicate prints of the same full name collapse into one row
 * (preferring the print already in deck).
 */
export function AddSearch({
  cards,
  calcDeck,
  byId,
  addCard,
}: {
  cards: Card[];
  calcDeck: DeckState;
  byId: Map<number, Card>;
  addCard: (id: number) => AddResult;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [addNote, setAddNote] = useState<string>();

  const addResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    // group counts once per run, not per candidate
    const groupCounts = groupCountsOf(calcDeck, byId);
    const groupCount = (card: Card): number =>
      groupCounts.get(card.groupKey) ?? 0;
    const byName = new Map<string, { card: Card; group: number }>();
    for (const card of cards) {
      if (!card.fullName.toLowerCase().includes(q)) continue;
      const check = canAddCard(calcDeck, card, byId);
      if (!check.ok) continue;
      const existing = byName.get(card.fullName);
      const preferThis =
        (calcDeck.cards[card.id] ?? 0) > 0 &&
        !(existing && (calcDeck.cards[existing.card.id] ?? 0) > 0);
      if (!existing || preferThis)
        byName.set(card.fullName, { card, group: groupCount(card) });
    }
    return [...byName.values()]
      .sort(
        (a, b) =>
          Number(b.card.fullName.toLowerCase().startsWith(q)) -
            Number(a.card.fullName.toLowerCase().startsWith(q)) ||
          a.card.cost - b.card.cost ||
          a.card.fullName.localeCompare(b.card.fullName),
      )
      .slice(0, 8);
  }, [query, cards, calcDeck, byId]);
  const queryTooShort = query.trim().length < 2;
  const noValidMatches =
    !queryTooShort && query.trim().length >= 2 && addResults.length === 0;

  return (
    <>
      <h3 className={panelHeadingCls}>Add cards</h3>
      <div className="mb-3.5">
        <input
          type="search"
          className="w-full bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-[9px] text-sm"
          placeholder={
            calcDeck.inks.length === 0
              ? 'Pick 1–2 inks first, then search…'
              : 'Search cards to add — only legal cards shown…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && addResults.length > 0) {
              const r = addResults[0]!;
              const result = addCard(r.card.id);
              setAddNote(
                result.status === 'refused' ? result.reason : undefined,
              );
            }
          }}
        />
        {addResults.length > 0 && (
          <div className="mt-1.5">
            {addResults.map(({ card, group }) => (
              <div
                key={card.id}
                className="flex items-center gap-2 py-1 border-b border-line last:border-b-0 text-[13px]"
              >
                <CostBadge card={card} size="sm" />
                <InkDots inks={card.inks} inline />
                <span
                  className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis"
                  title={card.fullName}
                >
                  {card.fullName}
                </span>
                <span className="min-w-[22px] text-right text-xs text-parchment-muted">
                  {group > 0 ? `${group}×` : ''}
                </span>
                <button
                  type="button"
                  className="bg-panel-2 text-parchment border border-line rounded-lg py-0.5 px-2 cursor-pointer text-xs hover:border-gold"
                  aria-label={`Add ${card.fullName}`}
                  onClick={() => addCard(card.id)}
                >
                  +
                </button>
              </div>
            ))}
          </div>
        )}
        {noValidMatches && (
          <p className="text-parchment-muted text-xs mt-1.5 mb-0">
            {calcDeck.inks.length === 0
              ? 'No inks declared — pick 1–2 inks above to add cards.'
              : 'No valid matches — other results are off-ink, out of format, or at their copy limit.'}
          </p>
        )}
        {addNote && <p className="text-warn text-[13px]">{addNote}</p>}
      </div>
    </>
  );
}
