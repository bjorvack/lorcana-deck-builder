/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../data/types';
import type { MetaModel } from '../meta/infer';
import { BASIS_FUSED } from '../meta/infer';
import { validateDeck } from '../rules/engine';
import type { AddResult } from '../state';
import type { Fingerprint } from '../stats/fingerprint';
import { byIdMap, makeCard } from '../test/fixtures';
import { AnalysisPanel, SuggestionsPanel } from './AnalysisPanel';

const fingerprint = {
  version: 1,
  axes: {
    Tempo: 60,
    Consistency: 60,
    Resilience: 40,
    Interaction: 40,
    Reach: 40,
  },
  matchups: [],
  openingHand: { keepableRate: 0.9 },
  curve: { onCurveThrough: 4, seed: 1 },
} as unknown as Fingerprint;

/** little-endian Int16 + scale encoder matching the artifact format */
function embed(
  dim: number,
  raw: Record<number, number[]>,
): MetaModel['relations'] {
  const vectors: Record<string, { b64: string; scale: number }> = {};
  for (const [id, vec] of Object.entries(raw)) {
    const maxAbs = Math.max(...vec.map((v) => Math.abs(v)));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = Buffer.alloc(dim * 2);
    vec.forEach((v, d) => {
      buf.writeInt16LE(Math.round(v / scale), d * 2);
    });
    vectors[id] = { b64: buf.toString('base64'), scale };
  }
  return { dim, quantization: 'int16-le', vectors };
}

const amber = (id: number, name: string, over: Partial<Card> = {}): Card =>
  makeCard({ id, name, inks: ['Amber'], ...over });

const cards: Card[] = [
  amber(1, 'Deck Member'),
  amber(2, 'Suggested Card', { keywords: ['Rush'] }),
  amber(3, 'Off Ink', { inks: ['Ruby'] }),
];
const byId = byIdMap(cards);
const completeDeck = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 30, 2: 30 },
} as never; // legal-complete
const buildingDeck = {
  title: 'T',
  inks: ['Amber'],
  format: 'core',
  cards: { 1: 30 },
} as never; // still building

const model = (withRelations: boolean): MetaModel => ({
  version: '2-test',
  dataThroughDate: '2026-11-10',
  capabilities: { relations: withRelations, calibration: true },
  archetypes: [
    {
      id: 1,
      name: 'Amber Rush',
      observedWinRate: 0.55,
      sampleSize: 50,
      centroid: { 1: 1 },
    },
  ],
  cardWeights: {},
  relations: withRelations ? embed(2, { 1: [1, 0], 2: [0.9, 0.1] }) : undefined,
});

const renderPanel = (m: MetaModel): ReturnType<typeof render> =>
  render(
    <AnalysisPanel
      fingerprint={fingerprint}
      meta={{ model: m, stale: false }}
      deck={completeDeck}
      byId={byId}
    />,
  );

const renderSuggestions = (
  m: MetaModel,
  onAddCard?: (id: number) => AddResult | undefined,
): ReturnType<typeof render> =>
  render(
    <SuggestionsPanel
      meta={{ model: m, stale: false }}
      deck={buildingDeck}
      byId={byId}
      onAddCard={onAddCard}
    />,
  );

describe('analysis panel suggestions', () => {
  afterEach(cleanup);

  it('keeps suggestions out of the analysis panel for a legal-complete deck', () => {
    renderPanel(model(true));
    expect(screen.getByTestId('meta-section')).toBeDefined();
    expect(screen.queryByTestId('suggestions-section')).toBeNull();
    expect(screen.queryByTestId('suggestions-panel')).toBeNull();
  });

  it('renders suggestions for a building deck with cost, inks, similarity and affinity basis', () => {
    renderSuggestions(model(true));
    const section = screen.getByTestId('suggestions-section');
    expect(section).toBeDefined();
    const row = screen.getByTestId('suggestion-row');
    expect(row.textContent).toContain('Suggested Card');
    expect(row.textContent).toContain(BASIS_FUSED.split(' + ')[1]!); // basis label visible
    expect(row.textContent).toMatch(/\d+%/); // similarity value
  });

  it('shows the unavailable state when the artifact lacks relation embeddings', () => {
    renderSuggestions(model(false));
    expect(screen.queryByTestId('suggestion-row')).toBeNull();
    expect(screen.getByTestId('meta-unavailable')).toBeDefined();
  });

  it('wires the add button to the deck handler with the suggested card id', () => {
    const onAddCard = vi.fn((): AddResult => ({ status: 'added' }));
    renderSuggestions(model(true), onAddCard);
    fireEvent.click(screen.getByTitle('Add Suggested Card'));
    expect(onAddCard).toHaveBeenCalledWith(2); // the legal suggestion, not the off-ink card
  });

  it('shows the quiet empty state when the legal pool exhausts', () => {
    const saturatedDeck = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 1: 30, 2: 30 },
    } as never;
    // both amber cards owned, third candidate off-ink → pool exhausted
    const allOwned = byIdMap([
      amber(1, 'Deck Member'),
      amber(2, 'Suggested Card'),
      amber(3, 'Off Ink', { inks: ['Ruby'] }),
    ]);
    render(
      <SuggestionsPanel
        meta={{ model: model(true), stale: false }}
        deck={saturatedDeck}
        byId={allOwned}
      />,
    );
    expect(screen.getByTestId('suggestions-empty').textContent).toContain(
      'No legal additions',
    );
  });
});

describe('payoff coverage (informational)', () => {
  afterEach(cleanup);

  const shiftCard = (): Card => ({
    ...amber(10, 'Hiro - Band Leader', {
      keywords: ['Shift'],
      text: 'Shift 3 (You may pay 3 to play this on top of one of your characters named Hiro.)',
      maxCopies: 'unlimited',
    }),
    payoffs: [
      {
        kind: 'shift',
        variant: 'named',
        cost: { mode: 'ink', amount: 3 },
        names: ['Hiro'],
      },
    ],
  });
  const shiftTarget = (): Card =>
    amber(11, 'Hiro - Armor Designer', { maxCopies: 'unlimited' });

  const deckWith = (
    ...extra: Card[]
  ): { deck: never; byId: Map<number, Card> } => {
    const list = [
      amber(1, 'Deck Member', { maxCopies: 'unlimited' }),
      shiftCard(),
      ...extra,
    ];
    const deckCards: Record<number, number> = { 1: 30, 10: 30 };
    if (extra.length > 0) {
      deckCards[1] = 20;
      deckCards[10] = 20;
      for (const c of extra) deckCards[c.id] = 20;
    }
    return {
      deck: {
        title: 'T',
        inks: ['Amber'],
        format: 'core',
        cards: deckCards,
      } as never,
      byId: byIdMap(list),
    };
  };

  it('reports a missing shift target as information while validation stays clean', () => {
    const { deck, byId } = deckWith();
    render(
      <AnalysisPanel
        fingerprint={fingerprint}
        meta={{ model: model(true), stale: false }}
        deck={deck}
        byId={byId}
      />,
    );
    const line = screen.getByTestId('payoff-coverage');
    expect(line.textContent).toContain('no shift target in deck');
    expect(line.textContent).toContain('never gate legality');
    expect(validateDeck(deck, byId)).toEqual([]); // informational only — no violation
  });

  it('reports the target as present when the named character is in the deck', () => {
    const { deck, byId } = deckWith(shiftTarget());
    render(
      <AnalysisPanel
        fingerprint={fingerprint}
        meta={{ model: model(true), stale: false }}
        deck={deck}
        byId={byId}
      />,
    );
    expect(screen.getByTestId('payoff-coverage').textContent).toContain(
      'shift target present for all 1',
    );
  });

  it('hides the line for decks without shift cards', () => {
    const deck = {
      title: 'T',
      inks: ['Amber'],
      format: 'core',
      cards: { 1: 30, 2: 30 },
    } as never;
    render(
      <AnalysisPanel
        fingerprint={fingerprint}
        meta={{ model: model(true), stale: false }}
        deck={deck}
        byId={byId}
      />,
    );
    expect(screen.queryByTestId('payoff-coverage')).toBeNull();
  });
});
