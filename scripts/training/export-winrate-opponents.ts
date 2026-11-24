/**
 * Thin CLI wrapper: the selection logic lives in the arena program
 * (arena/winrate-opponents.ts — it needs the engine-cards import chain).
 * This file is excluded from the root tsconfig for that reason.
 */
import './arena/winrate-opponents.ts';
