import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Card } from '../../../src/data/types';

/** The committed card snapshot our catalog (and identity registry) build from. */
export function loadCards(): Card[] {
  const snapshot = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'public',
        'data',
        'cards.min.json',
      ),
      'utf8',
    ),
  ) as { cards?: Card[] } | Card[];
  const cards = Array.isArray(snapshot) ? snapshot : (snapshot.cards ?? []);
  if (cards.length === 0)
    throw new Error(
      'public/data/cards.min.json is empty; run npm run data:build',
    );
  return cards;
}
