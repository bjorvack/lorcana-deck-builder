// Typecheck shims for the vendored engine. These exist ONLY for
// `tsconfig.typecheck.json` (via tsconfig paths): the vendor's TypeScript
// sources are authored for upstream's toolchain and do not typecheck under
// ours, so the arena's typecheck program never enters the vendor tree.
// Runtime (tsx/vitest) resolves the real vendored modules via node_modules;
// these shims only describe the surface the arena consumes.

export interface LorcanaBoardView {
  winner?: unknown;
  turnNumber?: number;
  players?: Record<string, { lore?: number }>;
  [key: string]: unknown;
}

export interface AutomatedActionExecutionResult {
  finalResult?: { success: boolean; error?: unknown; errorCode?: unknown };
  fallbackTaken?: string;
  actorId?: unknown;
  [key: string]: unknown;
}

export interface LorcanaServerLike {
  getBoard(): LorcanaBoardView;
  getCurrentActorId(): string | undefined;
  takeAutomatedActionForCurrentActor(options: {
    strategy: unknown;
  }): AutomatedActionExecutionResult;
  /** restore an authoritative state clone (is-mcts simulation) */
  loadState(state: unknown): void;
}

export interface AutomatedActionStrategyOption {
  id: string;
  label?: string;
  description?: string;
  informationPolicy?: string;
  testOnly?: boolean;
  strategy: unknown;
}

export function createLorcanaServerGame(
  players: Array<{ player: { id: string; name?: string } }>,
  init: Record<string, unknown>,
): LorcanaServerLike;

export const AUTOMATED_ACTION_STRATEGIES: readonly AutomatedActionStrategyOption[];
