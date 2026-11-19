import type { Card } from '../../src/data/types';

/**
 * Text-reference extraction (D2 extension): Lorcana effect text *designs*
 * synergies that deck co-occurrence may never observe — Shift targets
 * ("characters named Hiro Hamada"), named-character effects, direct card
 * mentions. These become synthetic SGNS documents so referenced cards land
 * close in embedding space, giving cold-start vectors to cards the tournament
 * corpus has never seen.
 *
 * Scope: identity references only (full names and character base names).
 * Classification/keyword references are class-level, not identity-level —
 * they live in the client-side text-feature space (subtypes one-hot), where
 * "same class" similarity is expressible without flooding SGNS with
 * hundreds of diluted edges per card.
 */

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[\u2019]/g, "'").replace(/[\u2010\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();

/** character/location base name: the part before " - " (Action/Item names are their own key) */
const baseName = (card: Card): string => {
  const i = card.fullName.indexOf(' - ');
  return i === -1 ? card.fullName : card.fullName.slice(0, i);
};

export interface TextReferences {
  /** cardId → ids of other cards its text references, both sorted */
  refs: Map<number, number[]>;
}

/** phrase key: normalized, punctuation folded to spaces so "X.") matches "X" as a whole phrase */
const phraseKey = (s: string): string => normalize(s).replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();

/** whole-phrase containment (padded boundaries) over phrase-keyed text */
const mentions = (text: string, key: string): boolean => ` ${text} `.includes(` ${key} `);

export function extractNameReferences(cards: Card[]): TextReferences {
  const byName = new Map<string, Set<number>>();
  for (const card of cards) {
    const key = phraseKey(card.fullName);
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key)!.add(card.id);
    const base = phraseKey(baseName(card));
    if (base && base !== key) {
      if (!byName.has(base)) byName.set(base, new Set());
      byName.get(base)!.add(card.id);
    }
  }

  const refs = new Map<number, number[]>();
  for (const card of cards) {
    const text = phraseKey(card.text);
    if (!text) continue;
    const hit = new Set<number>();
    for (const [key, ids] of byName) {
      // ≥3 chars keeps out noise ("Max" stays, "Ed" goes); whole-phrase keeps
      // out substrings ("Bell" ≠ "Belle")
      if (key.length < 3 || !mentions(text, key)) continue;
      for (const id of ids) if (id !== card.id) hit.add(id);
    }
    if (hit.size > 0) refs.set(card.id, [...hit].sort((a, b) => a - b));
  }
  return { refs };
}

/**
 * One synthetic SGNS document per referencing card: `[A, A, …references]`.
 * A doubled so the center↔context draws within the document associate A with
 * each reference; references sorted for determinism. Date = the card's own
 * release (recency weighting is off by default, but stays honest if enabled).
 *
 * With a `realDecks` budget, synthetic documents are capped at half the real
 * corpus so they can never drown the co-occurrence signal on thin corpora.
 * Selection is deterministic and cold-start-first: decks referencing cards the
 * real corpus never plays come in before the rest (stride-spread across sets).
 */
export function referenceDecks(
  refs: TextReferences,
  cards: Card[],
  opts: { realDecks?: number; coldIds?: Set<number> } = {}
): { tokens: number[]; date: string }[] {
  const releasedAt = new Map<number, string>();
  for (const c of cards) releasedAt.set(c.id, c.releasedAt ?? '');
  const all = [...refs.refs]
    .sort((a, b) => a[0] - b[0])
    .map(([id, referenced]) => ({ tokens: [id, id, ...referenced], date: releasedAt.get(id) ?? '' }));

  const budget = opts.realDecks === undefined ? all.length : Math.max(0, Math.floor(opts.realDecks / 2));
  if (all.length <= budget) return all;

  const cold = opts.coldIds
    ? all.filter((d) => d.tokens.slice(2).some((t) => !opts.coldIds!.has(t)))
    : [];
  const coldSet = new Set(cold);
  const rest = all.filter((d) => !coldSet.has(d));
  const chosen = new Set(cold.slice(0, budget));
  let remaining = budget - chosen.size;
  if (remaining > 0 && rest.length > 0) {
    const stride = Math.ceil(rest.length / remaining);
    for (let i = 0; i < rest.length && remaining > 0; i += stride) {
      chosen.add(rest[i]!);
      remaining--;
    }
  }
  return all.filter((d) => chosen.has(d));
}
