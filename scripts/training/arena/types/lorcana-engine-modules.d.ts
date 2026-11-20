// Typecheck shim for `@tcg/lorcana-engine/*` subpaths (see lorcana-engine.d.ts).

export interface AutomatedActionStrategy {
  name: string;
  informationPolicy?: string;
  summarizeCandidates(
    context: unknown,
    candidates: readonly unknown[],
  ): unknown;
}

export const AUTOMATED_ACTION_STRATEGIES: readonly import('./lorcana-engine').AutomatedActionStrategyOption[];
