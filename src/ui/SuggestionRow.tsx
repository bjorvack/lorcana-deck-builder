import { type ReactNode, useState } from 'react';
import type { Card, DeckState } from '../data/types';
import { BASIS_FUSED, BASIS_TEXT } from '../meta/infer';
import type { AddResult } from '../state';
import { cardSatisfiesName } from '../text/refs';
import { cardPreviewHandlers } from './CardPreview';
import { CostBadge, InkDots } from './components';

/**
 * Payoff-completion hints for a candidate card against the current deck, in
 * both directions: the candidate's own payoffs that the deck already satisfies
 * ("Shift target present"), and the deck's payoffs the candidate completes
 * ("completes the Shift target for X"). Informational only; the first
 * matching hint wins so rows stay clean. Snapshot-derived: works without a
 * meta artifact.
 */
export function payoffHint(
  candidate: Card,
  deck: DeckState,
  byId: Map<number, Card>,
): string | undefined {
  const deckCards: Card[] = [];
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (card && count > 0) deckCards.push(card);
  }
  if (deckCards.length === 0) return undefined;

  const classificationIn = (
    card: Card,
    classification: string | undefined,
  ): boolean =>
    classification !== undefined && card.subtypes.includes(classification);

  // 1) the candidate's payoffs satisfied by the deck
  for (const payoff of candidate.payoffs) {
    switch (payoff.kind) {
      case 'shift': {
        if (payoff.variant === 'universal') break;
        const satisfied =
          payoff.variant === 'classification'
            ? deckCards.some((c) => classificationIn(c, payoff.classification))
            : (payoff.names ?? []).some((name) =>
                deckCards.some((c) => cardSatisfiesName(c, name)),
              );
        if (satisfied) {
          const target =
            payoff.variant === 'classification'
              ? `${payoff.classification} characters`
              : (payoff.names ?? []).join(' or ');
          return `completes the Shift target for ${target}`;
        }
        break;
      }
      case 'named': {
        if (deckCards.some((c) => cardSatisfiesName(c, payoff.name))) {
          return `pairs with your ${payoff.name}`;
        }
        break;
      }
      case 'classification': {
        if (deckCards.some((c) => classificationIn(c, payoff.classification))) {
          return `boosts your ${payoff.classification} characters`;
        }
        break;
      }
      case 'sing': {
        const singer = deckCards.find(
          (c) => c.type === 'Character' && c.cost >= payoff.minCost,
        );
        if (singer)
          return `singable with your ${singer.fullName} (cost ${singer.cost})`;
        break;
      }
      case 'keywordGrant': {
        if (
          deckCards.some(
            (c) =>
              c.type === 'Character' && !c.keywords.includes(payoff.keyword),
          )
        ) {
          return `grants ${payoff.keyword} to your characters`;
        }
        break;
      }
      default:
        break; // mimicry wildcards have no deck-specific hint
    }
  }

  // 2) the deck's payoffs the candidate completes
  for (const card of deckCards) {
    for (const payoff of card.payoffs) {
      if (payoff.kind === 'shift' && payoff.variant !== 'universal') {
        const satisfied =
          payoff.variant === 'classification'
            ? classificationIn(candidate, payoff.classification)
            : (payoff.names ?? []).some((name) =>
                cardSatisfiesName(candidate, name),
              );
        if (satisfied) {
          const target =
            payoff.variant === 'classification'
              ? `${payoff.classification} characters`
              : (payoff.names ?? []).join(' or ');
          return `completes the Shift target for ${target}`;
        }
      } else if (
        payoff.kind === 'named' &&
        cardSatisfiesName(candidate, payoff.name)
      ) {
        return `pairs with your ${payoff.name}`;
      } else if (
        payoff.kind === 'classification' &&
        classificationIn(candidate, payoff.classification)
      ) {
        return `boosts your ${payoff.classification} characters`;
      } else if (
        payoff.kind === 'sing' &&
        candidate.type === 'Character' &&
        candidate.cost >= payoff.minCost
      ) {
        return `singable with your cost ${candidate.cost}+ characters`;
      }
    }
  }
  return undefined;
}

export interface SuggestionRowProps {
  card: Card;
  /** fused (or text-only) similarity, 0–1 */
  score: number;
  /** affinity basis label */
  basis: string;
  /** why this card fits the deck right now (payoff completion) */
  hint?: string;
  /** gated-add refusal reason, shown in place */
  refusal?: string;
  onAdd?: (cardId: number) => void;
}

/**
 * One suggested-addition row, shared by the deck view's suggestions panel and
 * the Browse strip: cost, inks, name, basis, score, payoff hint, add button.
 */
export function SuggestionRow({
  card,
  score,
  basis,
  hint,
  refusal,
  onAdd,
}: SuggestionRowProps): ReactNode {
  return (
    <div
      className="grid grid-cols-[24px_40px_1fr_44px_auto] gap-2 items-center my-1 text-[13px]"
      data-testid="suggestion-row"
      {...cardPreviewHandlers(card)}
    >
      <CostBadge card={card} size="sm" />
      <InkDots inks={card.inks} inline />
      <span className="flex flex-col min-w-0 overflow-hidden">
        {card.fullName}
        <span className="text-[11px] text-parchment-muted whitespace-nowrap overflow-hidden text-ellipsis">
          {basis}
        </span>
        {hint && <span data-testid="suggestion-hint">{hint}</span>}
      </span>
      <span
        className="text-xs text-right tabular-nums"
        title={`${BASIS_FUSED} / ${BASIS_TEXT}: fused 60% co-occurrence + 40% content`}
      >
        {Math.round(score * 100)}%
      </span>
      <button
        type="button"
        className="btn btn-mini"
        onClick={() => onAdd?.(card.id)}
        title={`Add ${card.fullName}`}
      >
        +
      </button>
      {refusal && <span className="note">{refusal}</span>}
    </div>
  );
}

/** surfacing gated-add refusals in place, per row */
export function useRowRefusal(): {
  refusals: Record<number, string>;
  handleResult: (cardId: number, result: AddResult | undefined) => void;
} {
  const [refusals, setRefusals] = useState<Record<number, string>>({});
  const handleResult = (
    cardId: number,
    result: AddResult | undefined,
  ): void => {
    if (result && result.status === 'refused') {
      setRefusals((r) => ({ ...r, [cardId]: result.reason }));
    } else if (result && result.status === 'added') {
      // a later successful add clears the stale refusal for this row
      setRefusals((r) => {
        if (!(cardId in r)) return r;
        const next = { ...r };
        delete next[cardId];
        return next;
      });
    }
  };
  return { refusals, handleResult };
}
