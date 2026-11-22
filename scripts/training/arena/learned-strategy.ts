/**
 * Learned strategy (M4 stage B v1): score candidates purely by a trained
 * linear weight vector over the shared feature space (candidate-features.ts),
 * with the wrapped strategy's ordering as a tie-break. Weights come from
 * outcome-supervised logistic regression over traced games (ranker.ts).
 */
import {
  candidateFeatures,
  FEATURE_DIM,
  type FeatureCandidate,
} from './candidate-features';

export interface LearnedStrategyWeights {
  version: '1';
  featureNames: readonly string[];
  /** linear mode: feature dot-product weights, FEATURE_DIM long */
  weights: number[];
  /** weight of the wrapped strategy's ordering as a tie-break */
  baseOrder: number;
  /** mlp mode: hidden-layer size (W1 hidden x D, b1 hidden, W2 hidden) */
  hidden?: number;
  W1?: number[];
  b1?: number[];
  W2?: number[];
  b2?: number;
  /** training metadata (trace games, decisions, trained-at seed) */
  meta?: Record<string, number | string>;
}

interface CardShapeView {
  cost?: number;
  lore?: number;
  strength?: number;
  willpower?: number;
  inkable?: boolean;
  cardType?: string;
}

interface CandidateView {
  family: string;
  cardId?: string;
  attackerId?: string;
  defenderId?: string;
}

interface SummaryView {
  candidate: CandidateView;
}

interface ContextView {
  actorId: string;
  opponentId?: string;
  turnNumber?: number;
  board: { players?: Record<string, { lore?: number }> };
  getCardDefinition(cardId: string | undefined): CardShapeView | undefined;
}

interface BaseStrategyView {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: ContextView,
    candidates: readonly unknown[],
  ): SummaryView[];
}

export interface LearnedStrategyView {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: ContextView,
    candidates: readonly unknown[],
  ): SummaryView[];
}

export function learnedStrategy(
  base: BaseStrategyView,
  learned: LearnedStrategyWeights,
): LearnedStrategyView {
  if (learned.featureNames.length !== FEATURE_DIM)
    throw new Error(
      `learned weights expect ${FEATURE_DIM} features, got ${learned.featureNames.length}`,
    );
  return {
    name: `learned(${base.name})`,
    informationPolicy: base.informationPolicy,
    summarizeCandidates(context, candidates) {
      const baseSummaries = base.summarizeCandidates(context, candidates);
      const total = baseSummaries.length;
      const myLore = context.board.players?.[context.actorId]?.lore ?? 0;
      const oppLore = context.opponentId
        ? (context.board.players?.[context.opponentId]?.lore ?? 0)
        : 0;
      const actorBoard = context.board.players?.[context.actorId] as
        | { inkwell?: unknown[]; hand?: unknown[]; play?: unknown[] }
        | undefined;
      const oppBoard = (
        context.opponentId
          ? context.board.players?.[context.opponentId]
          : undefined
      ) as { play?: unknown[] } | undefined;
      const scored = baseSummaries.map((summary, rank) => {
        const features = candidateFeatures(
          summary.candidate as FeatureCandidate,
          {
            turn: context.turnNumber ?? 0,
            myLore,
            oppLore,
            myInk: Array.isArray(actorBoard?.inkwell)
              ? actorBoard.inkwell.length
              : 0,
            myHand: Array.isArray(actorBoard?.hand)
              ? actorBoard.hand.length
              : 0,
            myPlay: Array.isArray(actorBoard?.play)
              ? actorBoard.play.length
              : 0,
            oppPlay: Array.isArray(oppBoard?.play) ? oppBoard.play.length : 0,
            resolveCard: (cardId) => context.getCardDefinition(cardId),
          },
        );
        let score: number;
        if (learned.hidden && learned.W2) {
          // mlp forward pass: h = tanh(W1 x + b1); z = W2 h + b2
          let z = learned.b2 ?? 0;
          for (let u = 0; u < learned.hidden; u++) {
            let a = learned.b1?.[u] ?? 0;
            for (let i = 0; i < FEATURE_DIM; i++)
              a += learned.W1![u * FEATURE_DIM + i]! * features[i]!;
            z += learned.W2[u]! * Math.tanh(a);
          }
          score = z;
        } else {
          let dot = 0;
          for (let i = 0; i < FEATURE_DIM; i++)
            dot += learned.weights[i]! * features[i]!;
          score = dot;
        }
        return {
          summary,
          rank,
          score:
            score +
            learned.baseOrder * (total > 1 ? 1 - rank / (total - 1) : 1),
        };
      });
      scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
      return scored.map((s) => s.summary);
    },
  };
}
