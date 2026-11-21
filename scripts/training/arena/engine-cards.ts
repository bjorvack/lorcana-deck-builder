import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal shape of the vendored engine's card definitions we rely on. */
export interface EngineCard {
  id: string;
  name: string;
  /** engine set code, e.g. "001" */
  set?: string;
  cardNumber?: number;
  externalIds?: { lorcast?: string };
  printings?: Array<{
    id?: string;
    setCode?: string;
    collectorNumber?: string;
  }>;
}

export interface EngineCatalog {
  byId: Record<string, EngineCard>;
  engineCommit: string;
}

let cached: EngineCatalog | null = null;

/**
 * The vendored engine catalog (all game cards with ability definitions) plus
 * the upstream commit the vendor tree was pulled at — the cache key's engine
 * version, so a bump never mixes eras of game records.
 */
export async function loadEngineCatalog(): Promise<EngineCatalog> {
  if (cached) return cached;
  const { getAllCardsById } = await import('@tcg/lorcana-cards');
  const byId = (await getAllCardsById()) as unknown as Record<
    string,
    EngineCard
  >;
  const pin = readFileSync(
    join(import.meta.dirname, '..', 'vendor', 'PIN.md'),
    'utf8',
  );
  const commit = /Upstream commit: `([0-9a-f]{40})`/.exec(pin)?.[1];
  if (!commit)
    throw new Error(
      'scripts/training/vendor/PIN.md is missing the upstream commit',
    );
  cached = { byId, engineCommit: commit };
  return cached;
}
