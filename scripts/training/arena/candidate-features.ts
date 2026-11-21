/**
 * Shared candidate feature extraction for the learned ranker (M4): one
 * implementation used by BOTH the trace-capturing strategy path and the
 * trainer, so learned weights transfer exactly.
 *
 * Features are deliberately simple and engine-facing (family one-hots, card
 * stats, board context) — the trainer learns their weights from outcomes.
 */

export const FEATURE_NAMES = [
  'play',
  'quest',
  'challenge',
  'ink',
  'activate',
  'resolve',
  'move',
  'other',
  'cost',
  'lore',
  'strength',
  'willpower',
  'inkable',
  'isCharacter',
  'turn',
  'loreDiff',
] as const;

export const FEATURE_DIM = FEATURE_NAMES.length;

export interface CardShapeView {
  cost?: number;
  lore?: number;
  strength?: number;
  willpower?: number;
  inkable?: boolean;
  cardType?: string;
}

export interface FeatureCandidate {
  family: string;
  /** primary card (engine public id or instance id the resolver understands) */
  cardId?: string;
  attackerId?: string;
  defenderId?: string;
}

export interface FeatureContext {
  turn: number;
  myLore: number;
  oppLore: number;
  /** resolve an engine card reference to its definition-shaped fields */
  resolveCard(cardId: string | undefined): CardShapeView | undefined;
}

export function candidateFeatures(
  candidate: FeatureCandidate,
  context: FeatureContext,
): Float64Array {
  const f = new Float64Array(FEATURE_DIM);
  const familyIndex: Record<string, number> = {
    playCard: 0,
    quest: 1,
    challenge: 2,
    putCardIntoInkwell: 3,
    activateAbility: 4,
    resolveBag: 5,
    resolveEffect: 6,
    moveCharacterToLocation: 7,
  };
  f[familyIndex[candidate.family] ?? 7] = 1;

  const def = candidate.cardId
    ? context.resolveCard(candidate.cardId)
    : undefined;
  if (def) {
    f[8] = (def.cost ?? 0) / 10;
    f[9] = (def.lore ?? 0) / 3;
    f[10] = (def.strength ?? 0) / 5;
    f[11] = (def.willpower ?? 0) / 5;
    if (def.inkable) f[12] = 1;
    if (def.cardType === 'Character') f[13] = 1;
  }

  f[14] = context.turn / 20;
  f[15] = (context.oppLore - context.myLore) / 20;
  return f;
}

/** challenge candidates expose the defender via defenderId, not cardId */
export function featureCardId(candidate: FeatureCandidate): string | undefined {
  return candidate.family === 'challenge'
    ? candidate.attackerId
    : candidate.cardId;
}
