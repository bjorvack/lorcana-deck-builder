import type { Card, DeckState } from '../data/types';
import { type CurveConsistency, curveConsistency } from './curve';
import { type MatchupEstimate, matchupEstimates } from './goldfish';
import { type HandQuality, openingHandQuality } from './hand';
import type { OpponentProfile } from './profiles';
import { shiftTargetName, tempoEffects } from './tempo';

export const FINGERPRINT_VERSION = 1;

export interface RedundancyEntry {
  key: string;
  name: string;
  copies: number;
  /** first turn the card can be played (its cost, min 1) */
  playableTurn: number;
  /** P(at least one copy drawn by playableTurn), on the play */
  probability: number;
}

export interface ShiftEntry {
  card: string;
  copies: number;
  shiftable: boolean;
}

export interface SingerBand {
  songCost: number;
  songs: number;
  singers: number;
}

export type AxisName =
  | 'Tempo'
  | 'Consistency'
  | 'Resilience'
  | 'Interaction'
  | 'Reach';

export interface Fingerprint {
  version: number;
  curve: CurveConsistency;
  openingHand: HandQuality;
  redundancy: RedundancyEntry[];
  interaction: { removal: number; boardWipe: number; bounce: number };
  singerCoverage: SingerBand[];
  shiftCoverage: ShiftEntry[];
  matchups: MatchupEstimate[];
  /** 0-100 viability profile; formulas in AXIS_FORMULAS for the panel tooltips */
  axes: Record<AxisName, number>;
}

/**
 * Axis formulas (deterministic, clamped to 0-100):
 * - Tempo: expected lore by turn 5 vs the midrange baseline — 15 lore scores
 *   100 (the aggressive pace), 0 lore scores 0.
 * - Consistency: opening-hand keepable rate (60%) and consecutive on-curve
 *   turns (40%, 5 turns = full marks).
 * - Resilience: win rate vs the removal-heavy control baseline — how well the
 *   race survives interaction aimed at our board.
 * - Interaction: removal + board-wipe + bounce copies; 10 copies = full marks.
 * - Reach: heavy finishers and lore-burst effects; 16 such copies = full marks.
 */
export const AXIS_FORMULAS: Record<AxisName, string> = {
  Tempo:
    'expected lore by turn 5 vs the midrange baseline (15 lore = full marks)',
  Consistency:
    '60% opening-hand keepable rate + 40% consecutive on-curve turns (5 = full)',
  Resilience: 'win rate vs the control baseline (most interaction)',
  Interaction: 'removal, board-wipe and bounce copies (10 = full marks)',
  Reach: 'copies of cost-5+ cards and lore-burst effects (16 = full marks)',
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const choose = (n: number, k: number): number => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

/** P(at least one of `copies` among the first `seen` cards of a deck of `total`) */
const drawAtLeastOne = (
  total: number,
  copies: number,
  seen: number,
): number => {
  if (copies <= 0 || seen <= 0) return 0;
  if (seen > total - copies) return 1; // pigeonhole: impossible to miss every copy
  return 1 - choose(total - copies, seen) / choose(total, seen);
};

const INTERACTION_TAGS: Record<keyof Fingerprint['interaction'], string> = {
  removal: 'removal',
  boardWipe: 'board-wipe',
  bounce: 'bounce',
};

export function computeFingerprint(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: { seed?: number; trials?: number } = {},
): Fingerprint | null {
  // trials tuned so the whole fingerprint lands near the ~50 ms budget
  // (measured 44-50 ms warm on a 60-card deck, ~85 ms cold first compute —
  // memoized per deck; precision ±2% on per-turn probabilities, ±3% on
  // matchup win rates — both displayed as rounded integers)
  const trials = opts.trials ?? 3_000;
  return computeFingerprintUncached(deck, byId, { ...opts, trials });
}

/** per-deck memo: the fingerprint is deterministic, so identical decks reuse the result */
const cache = new WeakMap<DeckState, Fingerprint | null>();

export function computeFingerprintCached(
  deck: DeckState,
  byId: Map<number, Card>,
): Fingerprint | null {
  if (cache.has(deck)) return cache.get(deck)!;
  const fp = computeFingerprintUncached(deck, byId);
  cache.set(deck, fp);
  return fp;
}

function computeFingerprintUncached(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: { seed?: number; trials?: number } = {},
): Fingerprint | null {
  const entries: { card: Card; count: number }[] = [];
  let total = 0;
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card || count <= 0) continue;
    entries.push({ card, count });
    total += count;
  }
  if (total === 0) return null;

  const curve = curveConsistency(deck, byId, opts);
  const openingHand = openingHandQuality(deck, byId, opts);
  if (!curve || !openingHand) return null;

  // redundancy: build-around effects (deck-rule enablers), closed form, on the play
  const seen = (turn: number): number => turn + 6; // 7 opening cards + (turn - 1) draws, first draw skipped
  const redundancy: RedundancyEntry[] = [];
  const byGroup = new Map<string, { card: Card; copies: number }>();
  for (const { card, count } of entries) {
    if (card.deckRuleEffects.length === 0) continue;
    const cur = byGroup.get(card.groupKey);
    if (cur) cur.copies += count;
    else byGroup.set(card.groupKey, { card, copies: count });
  }
  for (const { card, copies } of byGroup.values()) {
    const playableTurn = Math.max(1, card.cost);
    const p = drawAtLeastOne(total, copies, seen(playableTurn));
    redundancy.push({
      key: card.groupKey,
      name: card.fullName,
      copies,
      playableTurn,
      probability: p,
    });
  }
  redundancy.sort((a, b) => a.probability - b.probability);

  // interaction density by gameplay tag
  const interaction = { removal: 0, boardWipe: 0, bounce: 0 };
  for (const { card, count } of entries) {
    for (const [axis, tag] of Object.entries(INTERACTION_TAGS)) {
      if (card.tags.some((t) => t.tag === tag))
        interaction[axis as keyof Fingerprint['interaction']] += count;
    }
  }

  // singer coverage: per song cost band, characters able to sing it (cost ≥ band, or Singer N ≥ band)
  const bands = new Map<number, { songs: number; singers: number }>();
  for (const { card, count } of entries) {
    if (card.isSong) {
      const band = bands.get(card.cost) ?? { songs: 0, singers: 0 };
      band.songs += count;
      bands.set(card.cost, band);
    }
  }
  for (const { card, count } of entries) {
    if (card.type !== 'Character') continue;
    const singer = tempoEffects(card);
    for (const [costStr, band] of bands) {
      const songCost = Number(costStr);
      if (card.cost >= songCost || (singer.singerValue ?? 0) >= songCost)
        band.singers += count;
    }
  }
  const singerCoverage: SingerBand[] = [...bands.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([songCost, b]) => ({ songCost, songs: b.songs, singers: b.singers }));

  // shift coverage: a Shift card is shiftable when the deck runs a character
  // with the target name — another print of it, or a second copy of itself
  const shiftCoverage: ShiftEntry[] = [];
  for (const { card, count } of entries) {
    const target = shiftTargetName(card);
    if (!target) continue;
    const targetInDeck = entries.some(
      (e) =>
        e.card.type === 'Character' &&
        e.card.name.toLowerCase() === target.toLowerCase() &&
        (e.card.id !== card.id || e.count >= 2),
    );
    shiftCoverage.push({
      card: card.fullName,
      copies: count,
      shiftable: targetInDeck,
    });
  }
  shiftCoverage.sort((a, b) => Number(a.shiftable) - Number(b.shiftable));

  const matchups =
    matchupEstimates(deck, byId, {
      trials: opts.trials ?? 2_500,
      seed: opts.seed,
    }) ?? [];
  const byId2 = (id: OpponentProfile['id']): MatchupEstimate | undefined =>
    matchups.find((m) => m.profileId === id);
  const control = byId2('control');
  // tempo = early lore pace vs the midrange baseline (15 lore by turn 5 = aggressive pace)
  const tempo = clamp01((byId2('midrange')?.loreByTurn[4] ?? 0) / 15) * 100;
  const consistency =
    (0.6 * openingHand.keepableRate + 0.4 * clamp01(curve.onCurveThrough / 5)) *
    100;
  const resilience = (control?.winRate ?? 0) * 100;
  const reachCopies = entries.reduce(
    (s, { card, count }) =>
      s +
      (card.cost >= 5 ? count : 0) +
      (card.tags.some((t) => t.tag === 'lore-burst') ? count : 0),
    0,
  );
  const interactionCopies =
    interaction.removal + interaction.boardWipe + interaction.bounce;
  const axes: Record<AxisName, number> = {
    Tempo: Math.round(tempo),
    Consistency: Math.round(consistency),
    Resilience: Math.round(resilience),
    Interaction: Math.round(clamp01(interactionCopies / 10) * 100),
    Reach: Math.round(clamp01(reachCopies / 16) * 100),
  };

  return {
    version: FINGERPRINT_VERSION,
    curve,
    openingHand,
    redundancy,
    interaction,
    singerCoverage,
    shiftCoverage,
    matchups,
    axes,
  };
}
