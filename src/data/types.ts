/** Canonical card schema shared by the build-time pipeline and the app. */

export const INKS = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'] as const;
export type Ink = (typeof INKS)[number];

export type CardType = 'Character' | 'Action' | 'Item' | 'Location';
export type Format = 'core' | 'infinity';
/** absent dataset field → 4, `null` → unlimited, otherwise the given number */
export type CopyLimit = number | 'unlimited';

export interface Tag {
  tag: string;
  by: 'rule' | 'manual';
}

/**
 * Structured deck-building rule modification coming from card text.
 * v1 covers ink exemptions (Christopher Robin - Hunny Sage);
 * copy limits are data-driven via `maxCopies`.
 */
export interface InkExemptionEffect {
  kind: 'inkExemption';
  sourceCardId: number;
  targetTypes: string[];
  targetSubtypes: string[];
  exceptSelf: boolean;
  note: string;
}

export type DeckRuleEffect = InkExemptionEffect;

/** how a Shift cost is paid */
export type PayoffCost =
  | { mode: 'ink'; amount: number }
  | { mode: 'discard'; amount: number; cardType?: string }
  | { mode: 'inkDrops'; amount: number };

/** Shift variants, semantics per Comprehensive Rules 8.10.8.x */
export type ShiftVariant = 'named' | 'classification' | 'universal' | 'duo' | 'combo' | 'potato';

/** Shift payoff: this card may be played on top of matching targets */
export interface ShiftPayoff {
  kind: 'shift';
  variant: ShiftVariant;
  cost: PayoffCost;
  /** named/duo/combo/potato: the target name(s) */
  names?: string[];
  /** classification shift: the classification target */
  classification?: string;
  /** Temporary Shift family: the stack returns to hand at end of turn */
  temporary?: boolean;
  /** granted by another ability (e.g. UNUSUAL TRANSFORMATION), not innate */
  conditional?: boolean;
}

/** MIMICRY wildcard: universal shift landing target for any Shift card */
export interface MimicryPayoff {
  kind: 'mimicry';
  /** ADVANCED MIMICRY: any character may shift onto this card, all Shift variants included */
  advanced: boolean;
}

/** effect text references a character by name ("named X", "characters named X or Y") */
export interface NamedPayoff {
  kind: 'named';
  name: string;
}

/** effect text keys on a classification ("your Puppy characters gain …") */
export interface ClassificationPayoff {
  kind: 'classification';
  classification: string;
}

/** song sing requirement ("A character with cost N or more can sing this song") */
export interface SingPayoff {
  kind: 'sing';
  minCost: number;
  /** Sing Together N (rule 8.12): any number of characters with total cost ≥ N may sing */
  together?: boolean;
}

/** effect text grants a keyword ("your characters gain Ward") */
export interface KeywordGrantPayoff {
  kind: 'keywordGrant';
  keyword: string;
}

export type Payoff = ShiftPayoff | MimicryPayoff | NamedPayoff | ClassificationPayoff | SingPayoff | KeywordGrantPayoff;


export interface CardImages {
  thumb?: string;
  full?: string;
  alt?: string;
}

export interface Card {
  /** stable lorcanajson id; same across languages */
  id: number;
  name: string;
  version?: string;
  /** name + version subtitle (or just name for non-characters) */
  fullName: string;
  /** normalized fullName; copy limits are enforced per group across prints/sets */
  groupKey: string;
  inks: Ink[];
  isDualInk: boolean;
  cost: number;
  inkwell: boolean;
  type: CardType;
  subtypes: string[];
  isSong: boolean;
  franchise: string;
  setCode: string;
  setName: string;
  setNumber: number;
  setType: 'expansion' | 'quest';
  rarity: string;
  maxCopies: CopyLimit;
  strength?: number;
  willpower?: number;
  lore?: number;
  moveCost?: number;
  text: string;
  keywords: string[];
  tags: Tag[];
  deckRuleEffects: DeckRuleEffect[];
  /** structured payoffs extracted from effect text (empty when none) */
  payoffs: Payoff[];
  images: CardImages;
  prices?: { usd?: string; usdFoil?: string };
  collectorNumber?: string;
  releasedAt?: string;
  formats: { core: boolean; infinity: boolean };
}

export interface SetInfo {
  code: string;
  number: number;
  name: string;
  type: 'expansion' | 'quest';
  releaseDate?: string;
  prereleaseDate?: string | null;
}

export interface SnapshotMeta {
  generatedOn: string;
  cardCount: number;
  sources: {
    lorcanajson: { generatedOn?: string; formatVersion?: string };
    lorcast: { fetched: boolean };
  };
  tagRulesVersion: number;
}

export interface ValidationReport {
  generatedOn: string;
  ok: boolean;
  cardCount: number;
  perSetCounts: Record<string, { expected: number; actual: number }>;
  missingStory: number[];
  needsReview: { cardId: number; reason: string }[];
  derivations: { cardId: number; field: string }[];
  checksums: { file: string; ok: boolean }[];
}

export interface DeckState {
  title: string;
  /** declared inks, 0..2 entries */
  inks: Ink[];
  format: Format;
  /** cardId -> copy count */
  cards: Record<number, number>;
}

export type RuleId = 'card-count' | 'copy-limit' | 'off-ink' | 'dual-ink' | 'format';

export interface Violation {
  rule: RuleId;
  cardIds: number[];
  message: string;
}

export interface GeneratorNote {
  relaxations: string[];
  notes: string[];
}
