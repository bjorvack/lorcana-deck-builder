import type { Card } from '../data/types';

/**
 * Opening-hand alteration, Disney Lorcana Comprehensive Rules 2.3.0 (Oct 2026):
 *
 *   2.2.2.1 "First, the starting player selects any number of cards from their hand and
 *   places them on the bottom of their deck without revealing them. Then, they draw
 *   until they have 7 cards in their hand."
 *   2.2.2.3 "Third, each player who altered their hand by 1 or more cards shuffles their deck."
 *
 * Altering is therefore a free partial mulligan: replace any subset of the opening
 * hand with fresh cards, once per game, with no net card loss.
 *
 * Related timing rules quoted for the simulation (same revision):
 *   3.2.3.1 "The active player draws a card from their deck. If this turn is the first
 *   turn of the game, the starting player skips this step."
 *   3.2.2.2 "The active player gains lore from locations they have in play with a % characteristic."
 */

export interface TempoEffects {
  /** printed "pay N less to play this card" discount */
  selfDiscount: number;
  /** "if <character> in play, you pay N less to play this card" — applies only while a same-named character is on the board */
  conditionalDiscount: { amount: number; target: string } | null;
  /** action/song text that puts the deck's top card into the inkwell (+1 exerted ink on resolution) */
  rampOnPlay: boolean;
  /** "This turn, you may ink an additional card" (one-shot, e.g. Sail the Azurite Sea) */
  additionalInkOnPlay: boolean;
  /** "During your turn, you may ink an additional card" (static while in play, e.g. Belle) */
  additionalInkWhileInPlay: boolean;
  /** unconditional on-play ink drop grants (counters pay 1 ink each) */
  inkDropsOnPlay: number;
  /** "put any card from your hand into your inkwell" — also inks cards without the inkwell icon */
  flexibleInk: boolean;
  /** song — singable by exerting a dry in-play character with sufficient cost (or Singer N) */
  isSong: boolean;
  /** printed Singer N value, when present */
  singerValue: number | null;
}

const num = (s: string | undefined): number => (s ? parseInt(s, 10) : 1);

export function tempoEffects(card: Card): TempoEffects {
  // normalized card text keeps hard line breaks — match across whitespace
  const t = (card.text || '').toLowerCase().replace(/\s+/g, ' ');
  const unconditional = t
    .split('.')
    .find((s) => /you pay \d+ ?⬡? ?less to play this/.test(s) && !/\bif\b[^.]*(?:,|in play|controls?)[^.]*(?:, )?you pay/.test(s));
  const conditionalSentence = t
    .split('.')
    .find((s) => /if .+in play, you pay \d+ ?⬡? ?less to play this/.test(s) && /named /.test(s));
  let conditionalTarget: string | null = null;
  if (conditionalSentence) {
    // extract the target with its original casing from the raw text
    const m = (card.text || '').match(/named\s+([^.,]+?)\s+(?:in play|on the battlefield|on board)/i);
    conditionalTarget = m?.[1]?.trim() ?? conditionalSentence.match(/named ([^.,)]+)/)?.[1]?.trim() ?? null;
  }
  const rampOnPlay =
    card.type === 'Action' && /put the top card of your deck into your inkwell/.test(t);
  const drops = t.match(/when you play this (?:character|item|location)[^.]*?gets? (\d+ )?ink drop/);
  return {
    selfDiscount: unconditional ? parseInt(unconditional.match(/you pay (\d+)/)![1]!, 10) : 0,
    conditionalDiscount: conditionalSentence
      ? {
          amount: parseInt(conditionalSentence.match(/you pay (\d+)/)![1]!, 10),
          target: conditionalTarget ?? '',
        }
      : null,
    rampOnPlay,
    additionalInkOnPlay: /this turn, you may ink an additional card/.test(t),
    additionalInkWhileInPlay:
      !/this turn, you may ink/.test(t) && /you may ink an additional card/.test(t),
    inkDropsOnPlay: drops ? num(drops[1]) : 0,
    flexibleInk: /put (?:any|a) card from your hand into your inkwell/.test(t),
    isSong: card.isSong,
    singerValue: card.keywords.includes('Singer')
      ? num(t.match(/singer (\d+)/)?.[1])
      : null,
  };
}

/** "Shift N" — the deck needs a character with the target name to shift onto */
export function shiftTargetName(card: Card): string | null {
  if (!card.keywords.includes('Shift')) return null;
  // most shifts target their own name; classification/name shifts name it in the reminder text
  const named = (card.text || '').match(/characters named ([^.)]+)/);
  return named ? named[1]!.trim() : card.name;
}
