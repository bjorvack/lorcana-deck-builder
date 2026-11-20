import type { Card } from '../../../src/data/types';
import type { EngineCard } from './engine-cards';

/**
 * Identity-level card mapping between our catalog and the vendored engine.
 *
 * Identity is functionality, not print (D1, scripts/training/canonical.ts):
 * reprints, rarities, promos and enchanted/epic variants alias to the group's
 * canonical print and inherit its mapping — one training unit, one vector.
 * Differently-functioning variants (e.g. Quest challenge versions) already
 * carry distinct groupKeys upstream of this module.
 */

/** Join key on both catalogs: set{number}-{collectorNumber zero-padded to 3}. */
export function ourCatalogKey(
  card: Pick<Card, 'setCode' | 'collectorNumber'>,
): string {
  // setNumber is 0 in the snapshot; setCode holds the numeric set ("1"…"14")
  const set = Number.parseInt(card.setCode, 10);
  const number = Number.parseInt(card.collectorNumber ?? '', 10);
  if (Number.isNaN(set) || Number.isNaN(number)) return '';
  return `set${set}-${String(number).padStart(3, '0')}`;
}

/**
 * Engine key derived from a *plain* printing id ("set1-001"). Challenge and
 * promo printings reuse the base set/collector fields ("set1-c2-009-challenge",
 * "set1-cc1-001-promo"), so keying on set+cardNumber alone collides with the
 * base card — only plain printings define core-construction catalog keys.
 */
export function plainPrintingKey(printingId: string): string | null {
  const match = /^set(\d+)-(\d+)$/.exec(printingId);
  if (!match) return null;
  return `set${match[1]}-${String(match[2]).padStart(3, '0')}`;
}

export function engineCatalogKeys(card: EngineCard): string[] {
  const keys = new Set<string>();
  for (const printing of card.printings ?? []) {
    const key = printing.id ? plainPrintingKey(printing.id) : null;
    if (key) keys.add(key);
  }
  return [...keys];
}

export type IneligibleReason = 'quest' | 'epic' | 'promo' | 'unknown';

export interface MapEntry {
  /** engine public card id (what deck lists feed the engine) */
  engineId: string;
  /** engine canonical catalog key, e.g. "set1-175" */
  engineKey: string;
  /** sanity check: engine name vs ours (mismatches surface as needs-review) */
  nameMatches: boolean;
}

export interface CardMapCoverage {
  identities: number;
  mapped: number;
  ineligible: Record<IneligibleReason, number>;
  /** mapped keys where the engine's name disagrees with ours — audit signal */
  nameMismatches: number;
  /** identity groups whose prints differ in cost/stats/ink/type — never merge */
  statDriftGroups: string[];
  perSet: Record<string, { total: number; mapped: number; ineligible: number }>;
}

export interface CardMap {
  format: 1;
  engineCommit: string;
  /** canonical print id → engine mapping */
  byIdentity: Record<string, MapEntry>;
  coverage: CardMapCoverage;
}

export function ineligibleReason(card: Card): IneligibleReason {
  if (card.setType === 'quest') return 'quest';
  const rarity = card.rarity.toLowerCase();
  if (rarity === 'epic') return 'epic';
  if (rarity.includes('promo')) return 'promo';
  return 'unknown';
}

/** Identity groups whose members differ in functionality-relevant stats. */
export function statDriftGroups(cards: Card[]): string[] {
  const byGroup = new Map<string, Card[]>();
  for (const card of cards) {
    const list = byGroup.get(card.groupKey);
    if (list) list.push(card);
    else byGroup.set(card.groupKey, [card]);
  }
  const signature = (c: Card): string =>
    JSON.stringify([
      c.cost,
      c.type,
      c.strength ?? null,
      c.willpower ?? null,
      c.lore ?? null,
      c.inkwell,
      [...c.inks].sort(),
    ]);
  const drifted: string[] = [];
  for (const [group, prints] of byGroup) {
    const first = signature(prints[0]!);
    if (prints.some((p) => signature(p) !== first)) drifted.push(group);
  }
  return drifted.sort();
}

/** Whitespace + typography-insensitive name comparison (’ vs ', – vs -). */
function normalized(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2018\u2019'’]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BuildMapInput {
  cards: Card[];
  /** printing id → canonical print (from buildCanonicalRegistry) */
  alias: Map<number, number>;
  engineById: Record<string, EngineCard>;
  engineCommit: string;
}

export function buildCardMap({
  cards,
  alias,
  engineById,
  engineCommit,
}: BuildMapInput): CardMap {
  // engine lookup keyed by plain printing ids; our snapshot carries no lorcast
  // ids today, so this join is the only path (revisit if the pipeline starts
  // emitting external ids)
  const engineByKey = new Map<string, EngineCard>();
  for (const engine of Object.values(engineById)) {
    for (const key of engineCatalogKeys(engine)) engineByKey.set(key, engine);
  }

  const byIdentity: Record<string, MapEntry> = {};
  const coverage: CardMapCoverage = {
    identities: 0,
    mapped: 0,
    ineligible: { quest: 0, epic: 0, promo: 0, unknown: 0 },
    nameMismatches: 0,
    statDriftGroups: statDriftGroups(cards),
    perSet: {},
  };

  // one bucket per identity: canonical print decides eligibility + mapping,
  // every print of the group inherits the result via the alias map
  const canonicalById = new Map<number, Card>();
  for (const card of cards) {
    const canonicalId = alias.get(card.id);
    if (canonicalId === undefined) continue;
    if (!canonicalById.has(canonicalId)) canonicalById.set(canonicalId, card);
  }

  for (const [canonicalId, canonical] of canonicalById) {
    coverage.identities += 1;
    const setKey = String(canonical.setCode);
    const setBucket = coverage.perSet[setKey] ?? {
      total: 0,
      mapped: 0,
      ineligible: 0,
    };
    coverage.perSet[setKey] = setBucket;
    setBucket.total += 1;

    const engine = engineByKey.get(ourCatalogKey(canonical));
    if (!engine) {
      coverage.ineligible[ineligibleReason(canonical)] += 1;
      setBucket.ineligible += 1;
      continue;
    }
    const nameMatches = normalized(engine.name) === normalized(canonical.name);
    if (!nameMatches) coverage.nameMismatches += 1;
    byIdentity[String(canonicalId)] = {
      engineId: engine.id,
      engineKey: engineCatalogKeys(engine)[0] ?? '',
      nameMatches,
    };
    coverage.mapped += 1;
    setBucket.mapped += 1;
  }

  return { format: 1, engineCommit, byIdentity, coverage };
}
