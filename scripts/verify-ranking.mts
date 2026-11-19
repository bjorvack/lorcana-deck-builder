/** offline ranking for the verification deck (task 4.2 cross-check) */
import { readFile } from 'node:fs/promises';
import type { Card, DeckState } from '../src/data/types';
import { suggestCards } from '../src/meta/infer';

const snap = JSON.parse(
  await readFile('public/data/cards.min.json', 'utf8'),
) as { cards: Card[] };
const model = JSON.parse(
  await readFile('public/data/meta-model.json', 'utf8'),
) as Parameters<typeof suggestCards>[2];
const deck: DeckState = {
  title: 'Verification Deck',
  inks: ['Amber'],
  format: 'core',
  cards: Object.fromEntries(
    [3, 12, 14, 21, 23, 25, 206, 231, 236, 243, 247, 448, 453, 455, 456].map(
      (id) => [id, 4],
    ),
  ),
};
const suggestions = suggestCards(deck, snap.cards, model);
for (const s of suggestions) {
  console.log(
    `${s.card.fullName} — score ${Math.round(s.score * 100)}% (rel ${s.relationSim === null ? '–' : `${Math.round(s.relationSim * 100)}%`}, text ${Math.round(s.textSim * 100)}%) — ${s.basis}`,
  );
}
