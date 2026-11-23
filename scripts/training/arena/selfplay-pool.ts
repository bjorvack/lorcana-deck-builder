/**
 * Self-play card pool (self-play-league): which identities league decks may
 * draw from. Only identities the engine fully scripts are eligible — partially
 * scripted cards are engine-playable but flagged upstream, and league results
 * must never rest on half-implemented rules; unmapped identities are already
 * arena-ineligible (`run.ts` refuses their decks). Coverage below the
 * threshold means the vendored engine lags the snapshot — fail loudly rather
 * than silently narrowing the pool.
 */
import type { CardMap, CoverageStatus } from './card-map';

/** The run fails when fully-scripted identities fall below this share. */
export const DEFAULT_MIN_COVERAGE = 0.95;

export interface SelfPlayPool {
  /** identity ids with coverage status 'fully' — the pool decks draw from */
  identities: string[];
  /** identities kept out of the pool: partial + unmapped */
  excluded: number;
  /** fully-scripted share of the whole identity pool (0..1) */
  coverage: number;
}

/** Coverage status of one identity: absent from the map ⇔ 'unmapped'. */
export function coverageStatus(
  cardMap: CardMap,
  identity: string,
): CoverageStatus {
  return cardMap.byIdentity[identity]?.coverage ?? 'unmapped';
}

export function buildSelfPlayPool(
  cardMap: CardMap,
  options: { minCoverage?: number } = {},
): SelfPlayPool {
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const identities = Object.entries(cardMap.byIdentity)
    .filter(([, entry]) => entry.coverage === 'fully')
    .map(([identity]) => identity)
    .sort((a, b) => Number(a) - Number(b));
  const total = cardMap.coverage.identities;
  const coverage = total === 0 ? 0 : identities.length / total;
  if (coverage < minCoverage) {
    const excluded = total - identities.length;
    throw new Error(
      `self-play pool coverage ${coverage.toFixed(4)} is below the required ` +
        `${minCoverage}: ${identities.length}/${total} identities fully ` +
        `scripted, ${excluded} excluded as partial or unmapped — bump the ` +
        'vendored engine before running self-play',
    );
  }
  return { identities, excluded: total - identities.length, coverage };
}

export interface PartialUsage {
  /** distinct partially scripted identities present in the deck */
  distinct: number;
  /** card slots (sum of counts) filled by partially scripted identities */
  slots: number;
}

/** How often partially scripted cards appear in a deck (identity → count). */
export function partialUsage(
  deck: Record<string, number>,
  cardMap: CardMap,
): PartialUsage {
  let distinct = 0;
  let slots = 0;
  for (const [identity, count] of Object.entries(deck)) {
    if (coverageStatus(cardMap, identity) !== 'partial') continue;
    distinct += 1;
    slots += count;
  }
  return { distinct, slots };
}
