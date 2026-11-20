import { type ReactNode, useMemo, useState } from 'react';
import type { Card, DeckState } from '../data/types';
import { resolveEntries } from '../rules/engine';
import type { AddResult } from '../state';
import { CostBadge } from './charts';
import { CardModal } from './components';
import { useRowRefusal } from './SuggestionRow';
import { btnMiniCls, mutedCls, noteCls, panelHeadingCls } from './styles';

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
  // hover previews are mouse-only — tapping the row name opens the modal so
  // touch users can view a card at all
  const [selected, setSelected] = useState<Card | null>(null);
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
      <h3 className={panelHeadingCls}>Deck ({entries.length} distinct)</h3>
      {entries.length === 0 && (
        <p className={mutedCls}>
          Empty — add cards from Browse or run the Generator.
        </p>
      )}
      {entries.map(({ card, count }) => (
        <div key={card.id}>
          <div className="flex items-center gap-2 py-1 border-b border-line last:border-b-0">
            <span className="flex gap-1 items-center min-w-[86px]">
              <button
                type="button"
                className={btnMiniCls}
                aria-label={`Remove one copy of ${card.fullName}`}
                onClick={() => setCount(card.id, count - 1)}
              >
                −
              </button>
              {count}
              <button
                type="button"
                className={btnMiniCls}
                aria-label={`Add one copy of ${card.fullName}`}
                onClick={() => handleRowResult(card.id, addCard(card.id))}
              >
                +
              </button>
            </span>
            <button
              type="button"
              className="flex-1 bg-transparent border-0 p-0 [font:inherit] text-inherit text-left cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis hover:underline"
              title={card.fullName}
              onClick={() => setSelected(card)}
            >
              {card.fullName}
            </button>
            <CostBadge card={card} className="ml-auto" />
            <button
              type="button"
              className={btnMiniCls}
              aria-label={`Remove ${card.fullName} from deck`}
              onClick={() => removeCard(card.id)}
            >
              ✕
            </button>
          </div>
          {rowRefusals[card.id] && (
            <p className={noteCls}>{rowRefusals[card.id]}</p>
          )}
        </div>
      ))}
      {selected && (
        <CardModal card={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
