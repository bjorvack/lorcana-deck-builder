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

export type IneligibleReason =
  | 'quest'
  | 'epic'
  | 'promo'
  | 'unknown'
  | 'name-mismatch';

/**
 * Engine rule support per identity (D1b, self-play-league): `fully` = mapped
 * and not flagged upstream, `partial` = mapped but upstream flags incomplete
 * rule support, `unmapped` = no engine mapping (incl. quest/epic/promo).
 */
export type CoverageStatus = 'fully' | 'partial' | 'unmapped';

export interface MapEntry {
  /** engine public card id (what deck lists feed the engine) */
  engineId: string;
  /** engine canonical catalog key, e.g. "set1-175" (first plain printing) */
  engineKey: string;
  /** how the identity was resolved: 'key' = catalog key, 'name' = name+version */
  via: 'key' | 'name';
  /** upstream flags the engine card as not fully implemented (fidelity note) */
  missingImplementation: boolean;
  /** derived from missingImplementation; identities absent from the map are 'unmapped' */
  coverage: Exclude<CoverageStatus, 'unmapped'>;
}

export interface CardMapCoverage {
  identities: number;
  mapped: number;
  mappedVia: { key: number; name: number };
  ineligible: Record<IneligibleReason, number>;
  /** engine cards consumed that upstream flags as not fully implemented */
  missingImplementation: number;
  /** per-status identity counts over the whole pool: fully + partial + unmapped = identities */
  coverageStatuses: Record<CoverageStatus, number>;
  /** identities with status 'partial' (engine has the card, rules incomplete) */
  partialIdentities: string[];
  /** identity groups whose prints differ in cost/stats/ink/type — never merge */
  statDriftGroups: string[];
  perSet: Record<string, { total: number; mapped: number; ineligible: number }>;
}

export interface CardMap {
  format: 2;
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

/**
 * Letters-and-digits-only comparison. Collapses typography (' vs ’), spacing
 * ("Heaaaaaaart . . ." vs "Heaaaaaaart...") and dashes so upstream's stylized
 * card names still match ours.
 */
export function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function engineNameKey(card: EngineCard): string {
  return normalizedName(
    `${card.name}|${'version' in card ? ((card.version as string) ?? '') : ''}`,
  );
}

function ourNameKey(card: Card): string {
  return normalizedName(`${card.name}|${card.version ?? ''}`);
}

export interface BuildMapInput {
  cards: Card[];
  /** printing id → canonical print (from buildCanonicalRegistry) */
  alias: Map<number, number>;
  /** groupKey → the group's canonical print (the identity's true card) */
  canonicalByGroup: Map<string, Card>;
  engineById: Record<string, EngineCard>;
  engineCommit: string;
}

export function buildCardMap({
  cards,
  alias,
  canonicalByGroup,
  engineById,
  engineCommit,
}: BuildMapInput): CardMap {
  // Engine lookup: plain printing keys ("set1-001") and normalized
  // name+version. Our snapshot carries no lorcast ids today, so the catalog
  // key is the primary join; the name index rescues identities whose canonical
  // print is mis-keyed in our snapshot (e.g. set7-026, where three different
  // cards share one collector number).
  const engineByKey = new Map<string, EngineCard>();
  const engineByName = new Map<string, EngineCard[]>();
  for (const engine of Object.values(engineById)) {
    for (const key of engineCatalogKeys(engine)) engineByKey.set(key, engine);
    const nameKey = engineNameKey(engine);
    const bucket = engineByName.get(nameKey);
    if (bucket) bucket.push(engine);
    else engineByName.set(nameKey, [engine]);
  }

  const byIdentity: Record<string, MapEntry> = {};
  const coverage: CardMapCoverage = {
    identities: 0,
    mapped: 0,
    mappedVia: { key: 0, name: 0 },
    ineligible: { quest: 0, epic: 0, promo: 0, unknown: 0, 'name-mismatch': 0 },
    missingImplementation: 0,
    coverageStatuses: { fully: 0, partial: 0, unmapped: 0 },
    partialIdentities: [],
    statDriftGroups: statDriftGroups(cards),
    perSet: {},
  };

  const record = (
    canonicalId: number,
    canonical: Card,
    entry: MapEntry | null,
    reason: IneligibleReason,
  ): void => {
    coverage.identities += 1;
    const setKey = String(canonical.setCode);
    const setBucket = coverage.perSet[setKey] ?? {
      total: 0,
      mapped: 0,
      ineligible: 0,
    };
    coverage.perSet[setKey] = setBucket;
    setBucket.total += 1;
    if (!entry) {
      coverage.ineligible[reason] += 1;
      setBucket.ineligible += 1;
      coverage.coverageStatuses.unmapped += 1;
      return;
    }
    byIdentity[String(canonicalId)] = entry;
    coverage.mapped += 1;
    coverage.mappedVia[entry.via] += 1;
    if (entry.missingImplementation) {
      coverage.missingImplementation += 1;
      coverage.coverageStatuses.partial += 1;
      coverage.partialIdentities.push(String(canonicalId));
    } else {
      coverage.coverageStatuses.fully += 1;
    }
    setBucket.mapped += 1;
  };

  // one identity per group: the registry's canonical print decides the join;
  // every print of the group inherits the result via the alias map
  for (const [, canonical] of canonicalByGroup) {
    const canonicalId = alias.get(canonical.id);
    if (canonicalId === undefined) continue;

    const viaKey = (): MapEntry | null => {
      const engine = engineByKey.get(ourCatalogKey(canonical));
      if (!engine) return null;
      // a key hit with a different name is a snapshot numbering collision —
      // fall through to the name index rather than mapping the wrong card
      if (engineNameKey(engine) !== ourNameKey(canonical)) return null;
      const missingImplementation = Boolean(
        (engine as { missingImplementation?: boolean }).missingImplementation,
      );
      return {
        engineId: engine.id,
        engineKey: engineCatalogKeys(engine)[0] ?? '',
        via: 'key',
        missingImplementation,
        coverage: missingImplementation ? 'partial' : 'fully',
      };
    };

    const viaName = (): MapEntry | null => {
      const candidates = engineByName.get(ourNameKey(canonical)) ?? [];
      if (candidates.length === 0) return null;
      // Engine defs are one-per-game-card, but upstream sometimes ships a
      // separate def for a promo reprint of the same card (e.g. set 7's Moana:
      // base #156 vs the P2 026 promo). Rank candidates by printing evidence:
      // exact catalog key beats a shared collector number; no signal with
      // multiple candidates means we cannot tell — leave unmapped for review.
      // disambiguated collectors like "P2-26" carry the number as the
      // trailing digits
      const ourNumber =
        /(\d+)\s*$/.exec(canonical.collectorNumber ?? '')?.[1] ?? '';
      const padded = ourNumber.padStart(3, '0');
      const score = (engine: EngineCard): number => {
        if (engineCatalogKeys(engine).includes(ourCatalogKey(canonical)))
          return 2;
        const sharesNumber = (engine.printings ?? []).some((p) => {
          const id = p.id ?? '';
          return id.includes(`-${padded}`) || id.includes(`-${ourNumber}`);
        });
        return sharesNumber ? 1 : 0;
      };
      const best = Math.max(...candidates.map(score));
      const winners = candidates.filter((c) => score(c) === best);
      if (winners.length !== 1 || (candidates.length > 1 && best === 0))
        return null;
      const engine = winners[0]!;
      const missingImplementation = Boolean(
        (engine as { missingImplementation?: boolean }).missingImplementation,
      );
      return {
        engineId: engine.id,
        engineKey: engineCatalogKeys(engine)[0] ?? '',
        via: 'name',
        missingImplementation,
        coverage: missingImplementation ? 'partial' : 'fully',
      };
    };

    const keyEntry = viaKey();
    if (keyEntry) {
      record(canonicalId, canonical, keyEntry, 'unknown');
      continue;
    }
    const nameEntry = viaName();
    if (nameEntry) {
      record(canonicalId, canonical, nameEntry, 'name-mismatch');
      continue;
    }
    // distinguish "key hit but name disagreed" (snapshot quirk) from a plain
    // engine gap so the audit knows where to look
    const keyHit = engineByKey.get(ourCatalogKey(canonical));
    record(
      canonicalId,
      canonical,
      null,
      keyHit ? 'name-mismatch' : ineligibleReason(canonical),
    );
  }

  // byte-stable artifacts: identity ids sort numerically (as in map.ts)
  coverage.partialIdentities.sort((a, b) => Number(a) - Number(b));
  return { format: 2, engineCommit, byIdentity, coverage };
}
