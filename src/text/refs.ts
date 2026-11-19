import type { Card, Payoff, PayoffCost } from '../data/types';

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
 *
 * This module is shared between the trainer (scripts/training/) and the app:
 * the same one-implementation rule as canonical.ts (D5).
 */

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\u2019]/g, "'")
    .replace(/[\u2010\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

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
const phraseKey = (s: string): string =>
  normalize(s)
    .replace(/[^a-z0-9 -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** whole-phrase containment (padded boundaries) over phrase-keyed text */
const mentions = (text: string, key: string): boolean =>
  ` ${text} `.includes(` ${key} `);

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
    if (hit.size > 0)
      refs.set(
        card.id,
        [...hit].sort((a, b) => a - b),
      );
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
  opts: { realDecks?: number; coldIds?: Set<number> } = {},
): { tokens: number[]; date: string }[] {
  const releasedAt = new Map<number, string>();
  for (const c of cards) releasedAt.set(c.id, c.releasedAt ?? '');
  const all = [...refs.refs]
    .sort((a, b) => a[0] - b[0])
    .map(([id, referenced]) => ({
      tokens: [id, id, ...referenced],
      date: releasedAt.get(id) ?? '',
    }));

  const budget =
    opts.realDecks === undefined
      ? all.length
      : Math.max(0, Math.floor(opts.realDecks / 2));
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

// ---------------------------------------------------------------------------
// Payoff extraction (card-payoffs capability) — pattern rules interpreted
// into typed payoffs, so the app and the pipeline share one implementation.
// Rules come from scripts/tag-rules.json (payoffRules); overrides in
// scripts/deck-rule-overrides.json replace pattern output for named cards.
// ---------------------------------------------------------------------------

export interface PayoffRule {
  /** rule id, referenced in needsReview messages and tests */
  id: string;
  /** selects the interpreter that turns a match into typed payoffs */
  kind:
    | 'shift-named'
    | 'shift-classification'
    | 'shift-universal'
    | 'shift-duo'
    | 'shift-combo'
    | 'shift-potato'
    | 'shift-discard-cost'
    | 'shift-inkdrop-cost'
    | 'mimicry'
    | 'named'
    | 'classification'
    | 'sing'
    | 'keyword-grant';
  /** regex over newline-folded card text; named groups feed the interpreter */
  pattern: string;
}

export interface PayoffVocabulary {
  /** valid classification targets (character subtypes of the snapshot) */
  classifications: Set<string>;
  /** valid keyword grants (keyword abilities of the snapshot) */
  keywords: Set<string>;
  /** all known character/item base names + full names, normalized */
  names: Set<string>;
}

export function buildPayoffVocabulary(cards: Card[]): PayoffVocabulary {
  const classifications = new Set<string>();
  const keywords = new Set<string>();
  const names = new Set<string>();
  const addName = (s: string): void => {
    const n = s.toLowerCase();
    if (n) names.add(n);
  };
  for (const card of cards) {
    for (const subtype of card.subtypes) classifications.add(subtype);
    for (const keyword of card.keywords) {
      keywords.add(keyword);
      // the Shift family shares one dimension (8.10.8): "Floodborn Shift"
      // grants Shift, so it too may appear as a granted keyword
      if (/ Shift$/.test(keyword)) keywords.add('Shift');
    }
    addName(baseName(card));
    addName(card.fullName);
    if (card.name) {
      addName(card.name);
      // dual-named cards ("Flotsam & Jetsam") are referenced per component
      for (const part of splitNameComponents(card.name)) addName(part);
    }
  }
  return { classifications, keywords, names };
}

const INK_MARK = '\\u2be1'; // ⬡ ink symbol between cost and reminder text

export interface PayoffRulesInput {
  payoffRules: PayoffRule[];
}

/** effect-text rules run on the text left after shift-family spans are removed */
const EFFECT_TEXT_KINDS: ReadonlySet<PayoffRule['kind']> = new Set([
  'named',
  'classification',
  'sing',
  'keyword-grant',
]);

/** compile rules once; extraction walks them in declaration order */
export function compilePayoffRules(
  input: PayoffRulesInput,
): { rule: PayoffRule; re: RegExp }[] {
  return input.payoffRules.map((rule) => ({
    rule,
    re: new RegExp(rule.pattern, 'g'),
  }));
}

function shiftCostFromDiscard(m: RegExpMatchArray): PayoffCost {
  const g = m.groups ?? {};
  if (g.count) return { mode: 'discard', amount: Number(g.count) };
  return { mode: 'discard', amount: 1, cardType: g.cardType };
}

function shiftCostFromInk(m: RegExpMatchArray): PayoffCost {
  const amount = m.groups?.ink ?? m.groups?.cost ?? '0';
  return { mode: 'ink', amount: Number(amount) };
}

/** reminder/effect target names — "named A", "A or B", duo/combo name1+name2 */
function namesFromMatch(m: RegExpMatchArray): string[] | undefined {
  const g = m.groups ?? {};
  const raw = [g.name, g.name1, g.name2].filter(
    (n): n is string => typeof n === 'string',
  );
  if (raw.length === 0) return undefined;
  const split = raw
    .flatMap((n) => n.split(/\s+or\s+/))
    // reminder texts with a second sentence ("… named Grandma Wu. At the end
    // of your turn, …") are cut at the clause boundary; abbreviation periods
    // ("Dr. Facilier", "Jr.") never precede that phrase
    .map((n) => {
      const clause = n.indexOf('. At the end of');
      return (clause >= 0 ? n.slice(0, clause) : n).trim().replace(/\.$/, '');
    })
    .filter(Boolean);
  return split.length > 0 ? split : undefined;
}

const classificationOf = (
  m: RegExpMatchArray,
  fallback?: string,
): string | undefined => {
  // the reminder text ("… one of your Red Panda characters") is the
  // authoritative spelling; the keyword prefix ("Temporary Red Panda Shift")
  // is the fallback
  const c = m.groups?.classification2 ?? m.groups?.classification ?? fallback;
  return c ? c.trim() : undefined;
};

function splitNameComponents(fullName: string): string[] {
  const base = fullName.includes(' - ')
    ? fullName.slice(0, fullName.indexOf(' - '))
    : fullName;
  return base
    .split(' & ')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pattern extraction into typed payoffs. Pass 1: shift-family + mimicry rules
 * consume their spans (reminder targets must not re-surface as "named X"
 * effect references). Pass 2: effect-text rules (named, classification, sing,
 * keyword grants) run over the remaining text. Vocabulary validation drops
 * noise matches; keyword-only fallbacks cover parenthetical-free reprints
 * ("Shift 7 ⬡", "Combo Shift 4 ⬡").
 */
export function extractPayoffs(
  card: Pick<Card, 'fullName' | 'text' | 'keywords'>,
  rules: { rule: PayoffRule; re: RegExp }[],
  vocab: PayoffVocabulary,
): Payoff[] {
  const payoffs: Payoff[] = [];
  const text = card.text.replace(/\n/g, ' ').replace(/ {2,}/g, ' ');
  const consumed: { start: number; end: number }[] = [];
  const overlaps = (start: number, end: number): boolean =>
    consumed.some((c) => start < c.end && end > c.start);

  const keywordVariant = card.keywords.find(
    (k) => k.endsWith(' Shift') || k === 'Shift',
  );
  const kwKind = ((): PayoffRule['kind'] | null => {
    if (!keywordVariant) return null;
    if (keywordVariant === 'Universal Shift') return 'shift-universal';
    if (keywordVariant === 'Duo Shift') return 'shift-duo';
    if (keywordVariant === 'Combo Shift') return 'shift-combo';
    if (keywordVariant === 'Potato Shift') return 'shift-potato';
    if (keywordVariant === 'Shift' || keywordVariant === 'Temporary Shift')
      return 'shift-named';
    return 'shift-classification'; // Puppy Shift, Madrigal Shift, Temporary Red Panda Shift, …
  })();

  for (const { rule, re } of rules) {
    if (EFFECT_TEXT_KINDS.has(rule.kind)) continue; // pass 2
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      const g = m.groups ?? {};
      const start = m.index;
      const end = start + m[0].length;
      switch (rule.kind) {
        case 'shift-named': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          const temporary = g.temp !== undefined;
          push({
            kind: 'shift',
            variant: 'named',
            cost: shiftCostFromInk(m),
            names: namesFromMatch(m) ?? splitNameComponents(card.fullName),
            ...(temporary ? { temporary } : {}),
          });
          break;
        }
        case 'shift-classification': {
          if (overlaps(start, end)) break;
          // consumed even when the classification is unknown: an unparseable
          // variant must land in needsReview, not mutate into a named shift
          consumed.push({ start, end });
          const classification = classificationOf(
            m,
            keywordVariant?.replace(/ Shift$/, ''),
          );
          if (!classification || !vocab.classifications.has(classification))
            break;
          const temporary = /Temporary/.test(m[0]);
          push({
            kind: 'shift',
            variant: 'classification',
            classification,
            cost: shiftCostFromInk(m),
            ...(temporary ? { temporary } : {}),
          });
          break;
        }
        case 'shift-universal': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          push({
            kind: 'shift',
            variant: 'universal',
            cost: shiftCostFromInk(m),
          });
          break;
        }
        case 'shift-duo': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          const names =
            namesFromMatch(m) ?? splitNameComponents(card.fullName).slice(0, 2);
          push({
            kind: 'shift',
            variant: 'duo',
            cost: shiftCostFromInk(m),
            names,
          });
          break;
        }
        case 'shift-combo': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          const names =
            namesFromMatch(m) ?? splitNameComponents(card.fullName).slice(0, 2);
          push({
            kind: 'shift',
            variant: 'combo',
            cost: shiftCostFromInk(m),
            names,
          });
          break;
        }
        case 'shift-potato': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          push({
            kind: 'shift',
            variant: 'potato',
            cost: shiftCostFromInk(m),
            names: namesFromMatch(m) ?? ['Potato'],
          });
          break;
        }
        case 'shift-discard-cost': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          push({
            kind: 'shift',
            variant: 'named',
            cost: shiftCostFromDiscard(m),
            names: namesFromMatch(m) ?? splitNameComponents(card.fullName),
          });
          break;
        }
        case 'shift-inkdrop-cost': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          push({
            kind: 'shift',
            variant: 'named',
            cost: { mode: 'inkDrops', amount: Number(g.drops ?? 0) },
            names: namesFromMatch(m) ?? splitNameComponents(card.fullName),
          });
          break;
        }
        case 'mimicry': {
          if (overlaps(start, end)) break;
          consumed.push({ start, end });
          push({ kind: 'mimicry', advanced: /ADVANCED/.test(m[0]) });
          break;
        }
      }
    }
  }

  // pass 2: effect-text rules over the text with shift spans blanked out
  let remaining = text;
  for (const c of [...consumed].sort((a, b) => a.start - b.start)) {
    remaining =
      remaining.slice(0, c.start) +
      ' '.repeat(c.end - c.start) +
      remaining.slice(c.end);
  }
  for (const { rule, re } of rules) {
    if (!EFFECT_TEXT_KINDS.has(rule.kind)) continue;
    for (const m of remaining.matchAll(re)) {
      if (m[0].length === 0) continue;
      const g = m.groups ?? {};
      switch (rule.kind) {
        case 'named': {
          const names = (namesFromMatch(m) ?? []).filter((n) =>
            vocab.names.has(n.toLowerCase()),
          );
          for (const name of names) push({ kind: 'named', name });
          break;
        }
        case 'classification': {
          const classification = (g.classification ?? '').trim();
          if (classification && vocab.classifications.has(classification)) {
            push({ kind: 'classification', classification });
          }
          break;
        }
        case 'sing': {
          // Sing Together N (rule 8.12): a group of characters with total cost
          // ≥ N may sing — distinct from the standard single-character sing
          push({
            kind: 'sing',
            minCost: Number(g.cost ?? 0),
            together: /total cost|Any number/.test(m[0]) || undefined,
          });
          break;
        }
        case 'keyword-grant': {
          const keyword = (g.keyword ?? '').trim();
          if (keyword && vocab.keywords.has(keyword))
            push({ kind: 'keywordGrant', keyword });
          break;
        }
      }
    }
  }

  // keyword-only fallback: variant keyword present and the printed cost is
  // parseable from text. Without a parseable cost the card emits nothing —
  // an unparseable variant must land in needsReview, never a wrong cost-0.
  if (kwKind && keywordVariant && !payoffs.some((p) => p.kind === 'shift')) {
    const escaped = keywordVariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const costMatch = text.match(
      new RegExp(`${escaped} (?<cost>\\d+)(?: ?[${INK_MARK}])?`),
    );
    if (costMatch) {
      const cost: PayoffCost = {
        mode: 'ink',
        amount: Number(costMatch.groups?.cost ?? 0),
      };
      const base = splitNameComponents(card.fullName);
      if (kwKind === 'shift-universal')
        push({ kind: 'shift', variant: 'universal', cost });
      else if (kwKind === 'shift-duo')
        push({ kind: 'shift', variant: 'duo', cost, names: base.slice(0, 2) });
      else if (kwKind === 'shift-combo')
        push({
          kind: 'shift',
          variant: 'combo',
          cost,
          names: base.slice(0, 2),
        });
      else if (kwKind === 'shift-potato')
        push({ kind: 'shift', variant: 'potato', cost, names: ['Potato'] });
      else if (kwKind === 'shift-classification') {
        const classification = keywordVariant!.replace(/ Shift$/, '');
        // an unknown classification is a future variant the patterns cannot
        // type — emit nothing so the card lands in needsReview
        if (vocab.classifications.has(classification)) {
          push({
            kind: 'shift',
            variant: 'classification',
            classification,
            cost,
            ...(keywordVariant!.startsWith('Temporary')
              ? { temporary: true }
              : {}),
          });
        }
      } else {
        push({
          kind: 'shift',
          variant: 'named',
          cost,
          names: base,
          ...(keywordVariant!.startsWith('Temporary')
            ? { temporary: true }
            : {}),
        });
      }
    }
  }

  return payoffs;

  function push(p: Payoff): void {
    payoffs.push(p);
  }
}

/**
 * Shift-like text the patterns could not parse — the needsReview trigger
 * (card-payoffs: unknown future variants are surfaced, never dropped
 * silently). "If you used Shift to play them" trigger texts and effect
 * references to the word Shift are not shift-like.
 */
export function isUnparseableShiftText(
  card: Pick<Card, 'text' | 'keywords' | 'payoffs'>,
): boolean {
  const hasShiftPayoff = card.payoffs.some(
    (p) => p.kind === 'shift' || p.kind === 'mimicry',
  );
  if (hasShiftPayoff) return false;
  if (card.keywords.some((k) => k.endsWith(' Shift') || k === 'Shift'))
    return true;
  const text = card.text.replace(/\n/g, ' ');
  return /Shift: (Discard|Remove)|Shift \d|gains? Shift|on top of (one|two|any) of your/.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Target resolution — dual-named characters satisfy component names (rule
// 5.2.6.1): "Sulley & Boo" counts as Sulley, Boo and "Sulley & Boo".
// ---------------------------------------------------------------------------

/** names a card counts as for payoff targets: components + compound + base + full name */
export function cardTargetNames(
  card: Pick<Card, 'fullName' | 'name'>,
): Set<string> {
  const names = new Set<string>();
  const add = (s: string): void => {
    const n = normalize(s);
    if (n) names.add(n);
  };
  add(baseName(card as Card));
  if (card.name) add(card.name);
  add(card.fullName);
  for (const part of splitNameComponents(card.fullName)) add(part);
  return names;
}

/** whether `card` satisfies a named target; compound names match only the compound card */
export function cardSatisfiesName(
  card: Pick<Card, 'fullName' | 'name'>,
  targetName: string,
): boolean {
  return cardTargetNames(card).has(normalize(targetName));
}

/** the names a payoff accepts, normalized */
export function payoffTargetNames(payoff: Payoff): string[] {
  if (payoff.kind === 'named') return [normalize(payoff.name)];
  if (payoff.kind === 'shift' && payoff.names)
    return payoff.names.map(normalize);
  return [];
}

// ---------------------------------------------------------------------------
// Payoff coverage — informational only (never a validation violation)
// ---------------------------------------------------------------------------

export interface ShiftCoverage {
  /** deck cards with a shift payoff */
  shiftCards: number;
  /** shift cards whose target is present in the deck (or covered by a wildcard) */
  covered: number;
  /** a MIMICRY wildcard is in the deck */
  wildcard: boolean;
  /** ADVANCED MIMICRY covers Classification Shift targets too */
  advancedWildcard: boolean;
}

const hasShiftKeyword = (card: Card): boolean =>
  card.keywords.some((k) => k === 'Shift' || k.endsWith(' Shift'));

/**
 * Whether the deck covers a shift card's target. Coverage never blocks
 * anything: an uncovered shift card is playable without its target (the deck
 * is legal and validation-clean either way).
 */
export function shiftCoverage(
  entries: { card: Card; count: number }[],
): ShiftCoverage {
  const cards = entries.filter((e) => e.count > 0).map((e) => e.card);
  let shiftCards = 0;
  let covered = 0;
  let wildcard = false;
  let advancedWildcard = false;
  for (const card of cards) {
    for (const payoff of card.payoffs) {
      if (payoff.kind === 'mimicry') {
        if (payoff.advanced) advancedWildcard = true;
        else wildcard = true;
      }
    }
  }
  const others = (self: Card): Card[] => cards.filter((c) => c.id !== self.id);
  for (const card of cards) {
    const shifts = card.payoffs.filter(
      (p): p is Extract<Payoff, { kind: 'shift' }> => p.kind === 'shift',
    );
    if (shifts.length === 0) continue;
    shiftCards += 1;
    const rest = others(card);
    const satisfied = shifts.some((payoff) => {
      if (payoff.variant === 'universal')
        return rest.some((c) => c.type === 'Character');
      if (payoff.variant === 'classification') {
        return rest.some(
          (c) =>
            payoff.classification !== undefined &&
            c.subtypes.includes(payoff.classification),
        );
      }
      if (payoff.variant === 'duo') {
        // two distinct characters, one per name — a dual-named card fills one slot
        const names = payoff.names ?? [];
        const first = rest.find((c) => cardSatisfiesName(c, names[0] ?? ''));
        if (!first) return false;
        return rest.some(
          (c) => c.id !== first.id && cardSatisfiesName(c, names[1] ?? ''),
        );
      }
      // named / combo / potato: one matching target (combo: either name)
      const names = payoff.names ?? [];
      const matched = rest.some((c) =>
        payoff.variant === 'potato'
          ? c.type === 'Item' && names.some((n) => cardSatisfiesName(c, n))
          : names.some((n) => cardSatisfiesName(c, n)),
      );
      if (matched) return true;
      // wildcards: basic MIMICRY accepts any name (not Classification Shift);
      // ADVANCED MIMICRY accepts any character, all Shift variants
      if (advancedWildcard) return rest.some((c) => c.type === 'Character');
      if (wildcard)
        return rest.some((c) => c.type === 'Character' && hasShiftKeyword(c));
      return false;
    });
    if (satisfied) covered += 1;
  }
  return { shiftCards, covered, wildcard, advancedWildcard };
}
