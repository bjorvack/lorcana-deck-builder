import { type ReactNode, useMemo } from 'react';
import type { Card, DeckState } from '../data/types';
import { resolveEntries } from '../rules/engine';
import type { AddResult } from '../state';
import { cardPreviewHandlers } from './CardPreview';
import { CostBadge } from './charts';
import { useRowRefusal } from './SuggestionRow';

/** deck rows with per-row gated steppers and remove */
export function DeckList({
  deck,
  byId,
  setCount,
  addCard,
  removeCard,
}: {
  deck: DeckState;
  byId: Map<number, Card>;
  setCount: (id: number, count: number) => void;
  addCard: (id: number) => AddResult;
  removeCard: (id: number) => void;
}): ReactNode {
  const { refusals: rowRefusals, handleResult: handleRowResult } =
    useRowRefusal();
  const entries = useMemo(
    () =>
      resolveEntries(deck, byId).sort(
        (a, b) =>
          a.card.cost - b.card.cost ||
          a.card.fullName.localeCompare(b.card.fullName),
      ),
    [deck, byId],
  );

  return (
    <>
      <h3>Deck ({entries.length} distinct)</h3>
      {entries.length === 0 && (
        <p className="muted">
          Empty — add cards from Browse or run the Generator.
        </p>
      )}
      {entries.map(({ card, count }) => (
        <div key={card.id}>
          <div className="deckrow" {...cardPreviewHandlers(card)}>
            <span className="deckrow-count">
              <button
                type="button"
                className="btn btn-mini"
                aria-label={`Remove one copy of ${card.fullName}`}
                onClick={() => setCount(card.id, count - 1)}
              >
                −
              </button>
              {count}
              <button
                type="button"
                className="btn btn-mini"
                aria-label={`Add one copy of ${card.fullName}`}
                onClick={() => handleRowResult(card.id, addCard(card.id))}
              >
                +
              </button>
            </span>
            <span className="deckrow-name" title={card.fullName}>
              {card.fullName}
            </span>
            <CostBadge card={card} />
            <button
              type="button"
              className="btn btn-mini"
              aria-label={`Remove ${card.fullName} from deck`}
              onClick={() => removeCard(card.id)}
            >
              ✕
            </button>
          </div>
          {rowRefusals[card.id] && (
            <p className="note deckrow-note">{rowRefusals[card.id]}</p>
          )}
        </div>
      ))}
    </>
  );
}
