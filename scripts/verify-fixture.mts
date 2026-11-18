/**
 * Verification fixture for task 4.2 (local only, gitignored output):
 * relation embeddings over REAL card ids (two Amber families from the live
 * snapshot) so the panel renders against plausible data. Not a gate decision —
 * the real corpus still fails both gates (see benchmarks.md).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { quantizeEmbeddings, trainRelations, type RelationDeck } from './training/train';
import { buildCanonicalRegistry } from './training/canonical';
import { encodeDeck } from '../src/deck/codec';
import type { Card, DeckState } from '../src/data/types';

const snap = JSON.parse(await readFile('public/data/cards.min.json', 'utf8')) as { cards: Card[] };
const meta = JSON.parse(await readFile('public/data/meta.json', 'utf8')) as { generatedOn: string };
const alias = buildCanonicalRegistry(snap.cards).alias;
// the real pipeline canonicalizes corpus ids before training (D1) — mirror that
const canon = (id: number): number => alias.get(id) ?? id;

const amberCore = snap.cards.filter(
  (c) => c.formats.core && c.inks.includes('Amber') && c.maxCopies !== 'unlimited' && c.inkwell
);
// one print per group, so 4 copies × 15 distinct cards stays under the copy limit
const seenGroups = new Set<string>();
const distinct: Card[] = [];
for (const c of [...amberCore].sort((a, b) => a.id - b.id)) {
  if (seenGroups.has(c.groupKey)) continue;
  seenGroups.add(c.groupKey);
  distinct.push(c);
}
const familyA = distinct.slice(0, 15);
const familyB = distinct.slice(15, 30);
if (familyB.length < 15) throw new Error('not enough Amber cards for the fixture');

const decks: RelationDeck[] = Array.from({ length: 120 }, () => ({
  // every deck carries family A ×4 plus family B ×1: B co-occurs with A as
  // strongly as A cards co-occur with each other, so B vectors land inside
  // the family-A cluster (fixture-only — the real corpus failed its gate)
  tokens: [
    ...familyA.flatMap((c) => [canon(c.id), canon(c.id), canon(c.id), canon(c.id)]),
    ...familyB.map((c) => canon(c.id)),
  ],
  date: '2026-11-01',
}));

const vectors = trainRelations(decks, { seed: 42 });
const relations = quantizeEmbeddings(32, vectors);

const model = {
  version: '2-verify-fixture',
  dataThroughDate: meta.generatedOn.slice(0, 10),
  cardSchemaVersion: 1,
  capabilities: { relations: true, calibration: true },
  gates: {
    relations: { metric: 'holdout_coherence_ratio', value: 1.51, random: 0.08, threshold: 1.1, passed: true, holdoutDecks: 20, vocab: 30, pairs: 40 },
    calibration: { metric: 'holdout_winrate_mae', value: 0.09, baseline: 0.2, passed: true, holdoutDecks: 20 },
  },
  archetypes: [
    {
      id: 1,
      name: 'Amber Fixture Squad',
      observedWinRate: 0.56,
      sampleSize: 60,
      centroid: Object.fromEntries(familyA.map((c) => [String(c.id), Math.round((1 / 15) * 1000) / 1000])),
    },
  ],
  cardWeights: {},
  relations,
  sources: { fixture: 120 },
};

await writeFile('scripts/training/output/meta-model.json', JSON.stringify(model, null, 1));
console.log('fixture meta-model.json written');

// a valid 60-card Amber deck from family A (4 copies × 15 cards)
const deck: DeckState = {
  title: 'Verification Deck',
  inks: ['Amber'],
  format: 'core',
  cards: Object.fromEntries(familyA.map((c) => [c.id, 4])),
};
console.log('deck url: http://localhost:5173/?d=' + encodeDeck(deck) + '#/deck');
console.log('family A ids:', familyA.map((c) => c.id).join(','));
console.log('family B ids (candidates):', familyB.map((c) => c.id).join(','));
