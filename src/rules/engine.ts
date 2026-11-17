import type { Card, DeckState, Ink, Violation } from '../data/types';

export const MIN_DECK_SIZE = 60;

function activeInkExemptions(present: Card[]): { targetTypes: string[]; targetSubtypes: string[]; sourceCardId: number }[] {
  const effects: { targetTypes: string[]; targetSubtypes: string[]; sourceCardId: number }[] = [];
  for (const card of present) {
    for (const effect of card.deckRuleEffects) {
      if (effect.kind === 'inkExemption') {
        effects.push({ targetTypes: effect.targetTypes, targetSubtypes: effect.targetSubtypes, sourceCardId: effect.sourceCardId });
      }
    }
  }
  return effects;
}

function isExempt(card: Card, exemptions: ReturnType<typeof activeInkExemptions>): boolean {
  return exemptions.some(
    (e) =>
      e.targetTypes.includes(card.type) &&
      e.targetSubtypes.some((s) => card.subtypes.includes(s)) &&
      !(card.id === e.sourceCardId)
  );
}

export interface AddCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Whether adding one copy of `card` to the deck would keep it rule-legal
 * (ignoring the 60-card minimum, which is never the card's fault).
 * Mirrors validateDeck's per-card checks: format, copy limit per full-name
 * group across prints, dual-ink, and declared inks incl. text exemptions.
 */
export function canAddCard(deck: DeckState, card: Card, byId: Map<number, Card>): AddCheck {
  if (deck.format === 'core' && !card.formats.core) {
    return {
      ok: false,
      reason: card.setType === 'quest' ? 'Quest cards are not tournament-legal in Core' : 'Not legal in Core (rotated or banned)',
    };
  }
  if (deck.format === 'infinity' && !card.formats.infinity) {
    return { ok: false, reason: 'Banned in Infinity' };
  }

  const groupTotal = [...Object.entries(deck.cards)].reduce((sum, [id, count]) => {
    const other = byId.get(Number(id));
    return other && other.groupKey === card.groupKey ? sum + count : sum;
  }, 0);
  if (card.maxCopies !== 'unlimited' && groupTotal >= card.maxCopies) {
    return { ok: false, reason: `Copy limit reached (${groupTotal}/${card.maxCopies} in deck)` };
  }

  const present = resolveEntries(deck, byId).map((e) => e.card);
  if (!present.some((c) => c.id === card.id)) present.push(card);
  const exemptions = activeInkExemptions(present);

  if (card.isDualInk) {
    if (!card.inks.every((ink) => deck.inks.includes(ink))) {
      return { ok: false, reason: `Dual-ink card needs both inks declared (${card.inks.join('/')})` };
    }
  } else if (card.inks.length === 1) {
    if (!deck.inks.includes(card.inks[0]!) && !isExempt(card, exemptions)) {
      return { ok: false, reason: `${card.inks[0]} is outside the declared inks` };
    }
  } else if (card.inks.length === 0) {
    return { ok: false, reason: 'Card has no ink' };
  }
  return { ok: true };
}

export interface DeckEntry {
  card: Card;
  count: number;
}

/** resolve deck entries to cards; unknown ids are dropped defensively */
export function resolveEntries(deck: DeckState, byId: Map<number, Card>): DeckEntry[] {
  const entries: DeckEntry[] = [];
  for (const [idStr, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(idStr));
    if (card && count > 0) entries.push({ card, count });
  }
  return entries;
}

export function totalCards(entries: DeckEntry[]): number {
  return entries.reduce((sum, e) => sum + e.count, 0);
}

export function validateDeck(deck: DeckState, byId: Map<number, Card>): Violation[] {
  const entries = resolveEntries(deck, byId);
  const violations: Violation[] = [];

  const total = totalCards(entries);
  if (total < MIN_DECK_SIZE) {
    violations.push({
      rule: 'card-count',
      cardIds: [],
      message: `${total}/${MIN_DECK_SIZE} cards — decks must contain at least ${MIN_DECK_SIZE} cards`,
    });
  }

  // copy limits are per full name, grouped across prints/reprints; a group
  // inherits the lowest limit among its prints
  const groups = new Map<string, { limit: number | 'unlimited'; count: number; card: Card }>();
  for (const { card, count } of entries) {
    const g = groups.get(card.groupKey) ?? { limit: card.maxCopies, count: 0, card };
    g.count += count;
    if (card.maxCopies !== 'unlimited') {
      g.limit = g.limit === 'unlimited' ? card.maxCopies : Math.min(g.limit, card.maxCopies);
    } else {
      g.limit = 'unlimited';
    }
    groups.set(card.groupKey, g);
  }
  for (const g of groups.values()) {
    if (g.limit !== 'unlimited' && g.count > g.limit) {
      violations.push({
        rule: 'copy-limit',
        cardIds: [g.card.id],
        message: `${g.count} copies of ${g.card.fullName} (limit ${g.limit})`,
      });
    }
  }

  const declared: Ink[] = deck.inks;
  const exemptions = activeInkExemptions(entries.flatMap((e) => Array.from({ length: 1 }, () => e.card)));

  for (const { card, count } of entries) {
    if (card.isDualInk) {
      if (!card.inks.every((ink) => declared.includes(ink))) {
        violations.push({
          rule: 'dual-ink',
          cardIds: [card.id],
          message: `${card.fullName} is dual-ink (${card.inks.join('/')}); both inks must be the deck's declared inks`,
        });
      }
    } else if (card.inks.length === 1 && !declared.includes(card.inks[0]!) && !isExempt(card, exemptions)) {
      violations.push({
        rule: 'off-ink',
        cardIds: [card.id],
        message: `${count}x ${card.fullName} is ${card.inks[0]}, outside the declared inks (${declared.join('/') || 'none'})`,
      });
    } else if (card.inks.length === 0) {
      violations.push({
        rule: 'off-ink',
        cardIds: [card.id],
        message: `${count}x ${card.fullName} has no ink and cannot be included`,
      });
    }

    if (deck.format === 'core' && !card.formats.core) {
      violations.push({
        rule: 'format',
        cardIds: [card.id],
        message:
          card.setType === 'quest'
            ? `${card.fullName} is not tournament-legal (Quest set)`
            : `${card.fullName} is not legal in Core (rotated or banned)`,
      });
    } else if (deck.format === 'infinity' && !card.formats.infinity) {
      violations.push({
        rule: 'format',
        cardIds: [card.id],
        message: `${card.fullName} is banned in Infinity`,
      });
    }
  }

  return violations;
}
