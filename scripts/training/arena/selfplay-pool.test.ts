/** Self-play pool + partial-usage tests (synthetic card map + the real one). */
import { describe, expect, it } from 'vitest';
import { buildCanonicalRegistry } from '../canonical';
import { buildCardMap, type CardMap, type MapEntry } from './card-map';
import { loadCards } from './cards';
import { loadEngineCatalog } from './engine-cards';
import {
  buildSelfPlayPool,
  coverageStatus,
  DEFAULT_MIN_COVERAGE,
  partialUsage,
} from './selfplay-pool';

const entry = (missingImplementation: boolean): MapEntry => ({
  engineId: 'engine-1',
  engineKey: 'set1-001',
  via: 'key',
  missingImplementation,
  coverage: missingImplementation ? 'partial' : 'fully',
});

// 6 identities: 2 fully mapped, 2 partial, 2 unmapped (never in byIdentity)
const cardMap: CardMap = {
  format: 2,
  engineCommit: 'test',
  byIdentity: {
    1: entry(false),
    2: entry(false),
    3: entry(true),
    4: entry(true),
  },
  coverage: {
    identities: 6,
    mapped: 4,
    mappedVia: { key: 4, name: 0 },
    ineligible: { quest: 2, epic: 0, promo: 0, unknown: 0, 'name-mismatch': 0 },
    missingImplementation: 2,
    coverageStatuses: { fully: 2, partial: 2, unmapped: 2 },
    partialIdentities: ['3', '4'],
    statDriftGroups: [],
    perSet: {},
  },
};

describe('buildSelfPlayPool', () => {
  it('keeps only fully-scripted identities and counts exclusions', () => {
    const pool = buildSelfPlayPool(cardMap, { minCoverage: 0 });
    expect(pool.identities).toEqual(['1', '2']);
    expect(pool.excluded).toBe(4);
    expect(pool.coverage).toBeCloseTo(2 / 6);
  });

  it('fails below the default threshold, naming measured and threshold', () => {
    expect(() => buildSelfPlayPool(cardMap)).toThrowError(
      'self-play pool coverage 0.3333 is below the required 0.95',
    );
  });

  it('honours a lowered threshold', () => {
    expect(buildSelfPlayPool(cardMap, { minCoverage: 0.3 }).identities).toEqual(
      ['1', '2'],
    );
    expect(() => buildSelfPlayPool(cardMap, { minCoverage: 0.5 })).toThrowError(
      /0\.5.*2\/6 identities fully scripted/,
    );
  });

  it('excludes nothing when every identity is fully scripted', () => {
    const full: CardMap = {
      ...cardMap,
      byIdentity: { 1: entry(false), 2: entry(false) },
      coverage: {
        ...cardMap.coverage,
        identities: 2,
        mapped: 2,
        missingImplementation: 0,
        coverageStatuses: { fully: 2, partial: 0, unmapped: 0 },
        partialIdentities: [],
      },
    };
    const pool = buildSelfPlayPool(full);
    expect(pool).toEqual({ identities: ['1', '2'], excluded: 0, coverage: 1 });
  });
});

describe('coverageStatus', () => {
  it('reads the entry status and defaults to unmapped', () => {
    expect(coverageStatus(cardMap, '1')).toBe('fully');
    expect(coverageStatus(cardMap, '3')).toBe('partial');
    expect(coverageStatus(cardMap, '99')).toBe('unmapped');
  });
});

describe('partialUsage', () => {
  it('counts card slots and distinct partial identities', () => {
    expect(partialUsage({ 1: 4, 3: 2, 99: 3 }, cardMap)).toEqual({
      distinct: 1,
      slots: 2,
    });
    expect(partialUsage({ 3: 2, 4: 1 }, cardMap)).toEqual({
      distinct: 2,
      slots: 3,
    });
  });

  it('reports zero for decks without partial cards', () => {
    expect(partialUsage({ 1: 4, 2: 56 }, cardMap)).toEqual({
      distinct: 0,
      slots: 0,
    });
    expect(partialUsage({}, cardMap)).toEqual({ distinct: 0, slots: 0 });
  });
});

describe('real card map', () => {
  it('builds a pool above the default threshold with consistent statuses', async () => {
    const cards = loadCards();
    const { alias, canonicalByGroup } = buildCanonicalRegistry(cards);
    const catalog = await loadEngineCatalog();
    const map = buildCardMap({
      cards,
      alias,
      canonicalByGroup,
      engineById: catalog.byId,
      engineCommit: catalog.engineCommit,
    });
    const statuses = map.coverage.coverageStatuses;
    // the statuses partition the pool and agree with the legacy counters
    expect(statuses.fully + statuses.partial + statuses.unmapped).toBe(
      map.coverage.identities,
    );
    expect(statuses.partial).toBe(map.coverage.missingImplementation);
    expect(map.coverage.partialIdentities).toHaveLength(statuses.partial);
    for (const entry of Object.values(map.byIdentity)) {
      expect(entry.coverage).toBe(
        entry.missingImplementation ? 'partial' : 'fully',
      );
    }
    // the production gate: the current engine pin must clear the threshold
    const pool = buildSelfPlayPool(map);
    expect(pool.identities).toHaveLength(statuses.fully);
    expect(pool.excluded).toBe(statuses.partial + statuses.unmapped);
    expect(pool.coverage).toBeGreaterThanOrEqual(DEFAULT_MIN_COVERAGE);
  }, 60_000);
});
