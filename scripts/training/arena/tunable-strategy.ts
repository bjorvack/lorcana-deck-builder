/**
 * Tunable strategy (M3 stage A): delegate to a shipped strategy for its
 * candidate ordering, then re-rank by a genome of interpretable feature
 * weights. The planner consumes summaries in order, so this fully controls
 * move preference while inheriting everything the shipped heuristic knows.
 *
 * A neutral genome (base = 1, all feature weights 0) reproduces the wrapped
 * strategy's ordering exactly. Types here are structural: the arena typecheck
 * program never enters the vendor tree (see tsconfig.typecheck.json), and at
 * runtime the engine duck-types whatever strategy object it receives.
 */

export interface StrategyGenome {
  /** weight of the wrapped strategy's ordering (1 = respect it fully) */
  base: number;
  familyBias: {
    playCard: number;
    quest: number;
    challenge: number;
    ink: number;
  };
  /** card cost / 10 (negative = prefer cheap) */
  cost: number;
  /** character lore / 3 on quest candidates */
  lore: number;
  /** prefer inkable play candidates */
  inkable: number;
  /** challenge kill potential: (attacker strength − defender willpower) / 5 */
  killPotential: number;
  /** challenge target lore / 3 (deny the lore) */
  denyLore: number;
  /** tempo: challenge bias scaled by (opponent lore − my lore) / 20 */
  tempo: number;
}

export const NEUTRAL_GENOME: StrategyGenome = {
  base: 1,
  familyBias: { playCard: 0, quest: 0, challenge: 0, ink: 0 },
  cost: 0,
  lore: 0,
  inkable: 0,
  killPotential: 0,
  denyLore: 0,
  tempo: 0,
};

export function genomeToVector(genome: StrategyGenome): number[] {
  return [
    genome.base,
    genome.familyBias.playCard,
    genome.familyBias.quest,
    genome.familyBias.challenge,
    genome.familyBias.ink,
    genome.cost,
    genome.lore,
    genome.inkable,
    genome.killPotential,
    genome.denyLore,
    genome.tempo,
  ];
}

export function vectorToGenome(vector: number[]): StrategyGenome {
  return {
    base: vector[0] ?? 0,
    familyBias: {
      playCard: vector[1] ?? 0,
      quest: vector[2] ?? 0,
      challenge: vector[3] ?? 0,
      ink: vector[4] ?? 0,
    },
    cost: vector[5] ?? 0,
    lore: vector[6] ?? 0,
    inkable: vector[7] ?? 0,
    killPotential: vector[8] ?? 0,
    denyLore: vector[9] ?? 0,
    tempo: vector[10] ?? 0,
  };
}

interface CardShape {
  cost?: number;
  lore?: number;
  strength?: number;
  willpower?: number;
  inkable?: boolean;
  cardType?: string;
}

/** structural views of the engine's planner types (loose, read-only) */
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
  board: { players?: Record<string, { lore?: number }> };
  getCardDefinition(cardId: string): CardShape | undefined;
}

interface BaseStrategyView {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: ContextView,
    candidates: readonly unknown[],
  ): SummaryView[];
}

export interface TunableStrategyView {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: ContextView,
    candidates: readonly unknown[],
  ): SummaryView[];
}

export function tunableStrategy(
  base: BaseStrategyView,
  genome: StrategyGenome,
): TunableStrategyView {
  return {
    name: `tunable(${base.name})`,
    informationPolicy: base.informationPolicy,
    summarizeCandidates(context, candidates) {
      const baseSummaries = base.summarizeCandidates(context, candidates);
      const total = baseSummaries.length;
      const scored = baseSummaries.map((summary, rank) => ({
        summary,
        rank,
        score:
          genome.base * (total > 1 ? 1 - rank / (total - 1) : 1) +
          featureScore(context, summary),
      }));
      scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
      return scored.map((s) => s.summary);
    },
  };

  function featureScore(context: ContextView, summary: SummaryView): number {
    const candidate = summary.candidate;
    let score = 0;
    switch (candidate.family) {
      case 'playCard': {
        score += genome.familyBias.playCard;
        const def = candidate.cardId
          ? context.getCardDefinition(candidate.cardId)
          : undefined;
        if (def) {
          score += genome.cost * ((def.cost ?? 0) / 10);
          if (def.cardType === 'Character')
            score += genome.lore * ((def.lore ?? 0) / 3);
          if (def.inkable) score += genome.inkable;
        }
        break;
      }
      case 'quest': {
        score += genome.familyBias.quest;
        const def = candidate.cardId
          ? context.getCardDefinition(candidate.cardId)
          : undefined;
        if (def) score += genome.lore * ((def.lore ?? 0) / 3);
        break;
      }
      case 'challenge': {
        score += genome.familyBias.challenge;
        const attacker = candidate.attackerId
          ? context.getCardDefinition(candidate.attackerId)
          : undefined;
        const defender = candidate.defenderId
          ? context.getCardDefinition(candidate.defenderId)
          : undefined;
        if (attacker && defender) {
          score +=
            (genome.killPotential *
              ((attacker.strength ?? 0) - (defender.willpower ?? 0))) /
            5;
          score += genome.denyLore * ((defender.lore ?? 0) / 3);
        }
        // tempo: challenge harder when behind on the lore race
        const myLore = context.board.players?.[context.actorId]?.lore ?? 0;
        const oppLore = context.opponentId
          ? (context.board.players?.[context.opponentId]?.lore ?? 0)
          : 0;
        score += genome.tempo * ((oppLore - myLore) / 20);
        break;
      }
      case 'putCardIntoInkwell': {
        score += genome.familyBias.ink;
        break;
      }
      default:
        break; // other families inherit the base order
    }
    return score;
  }
}
