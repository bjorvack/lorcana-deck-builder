import type { Card, Tag } from '../src/data/types';
import { readFileSync } from 'node:fs';

export interface GameplayTagRule {
  tag: string;
  include: string[];
  exclude: string[];
}

export interface TagRules {
  version: number;
  gameplayTags: GameplayTagRule[];
}

export function loadTagRules(file: string): TagRules {
  return JSON.parse(readFileSync(file, 'utf8')) as TagRules;
}

/**
 * Deterministic tagging: mechanic tags copy the dataset's parsed keyword
 * abilities; gameplay tags apply include/exclude regexes to the full text.
 */
export function tagCard(card: Card, rules: TagRules): Tag[] {
  const tags: Tag[] = [];
  for (const keyword of card.keywords) {
    tags.push({ tag: keyword.toLowerCase(), by: 'rule' });
  }
  const text = card.text;
  for (const rule of rules.gameplayTags) {
    const included = rule.include.some((p) => new RegExp(p, 'i').test(text));
    if (!included) continue;
    const excluded = rule.exclude.some((p) => new RegExp(p, 'i').test(text));
    if (excluded) continue;
    tags.push({ tag: rule.tag, by: 'rule' });
  }
  return tags;
}

export function applyTags(cards: Card[], rules: TagRules): void {
  for (const card of cards) {
    card.tags = tagCard(card, rules);
  }
}
