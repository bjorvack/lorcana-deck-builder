/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { AnalysisPanel } from './AnalysisPanel';
import { makeCard, byIdMap } from '../test/fixtures';
import type { Card } from '../data/types';
import type { Fingerprint } from '../stats/fingerprint';
import type { MetaModel } from '../meta/infer';
import { BASIS_FUSED } from '../meta/infer';

const fingerprint = {
  version: 1,
  axes: { Tempo: 60, Consistency: 60, Resilience: 40, Interaction: 40, Reach: 40 },
  matchups: [],
  openingHand: { keepableRate: 0.9 },
  curve: { onCurveThrough: 4, seed: 1 },
} as unknown as Fingerprint;

/** little-endian Int16 + scale encoder matching the artifact format */
function embed(dim: number, raw: Record<number, number[]>): MetaModel['relations'] {
  const vectors: Record<string, { b64: string; scale: number }> = {};
  for (const [id, vec] of Object.entries(raw)) {
    const maxAbs = Math.max(...vec.map((v) => Math.abs(v)));
    const scale = maxAbs > 0 ? maxAbs / 32767 : 1;
    const buf = Buffer.alloc(dim * 2);
    vec.forEach((v, d) => buf.writeInt16LE(Math.round(v / scale), d * 2));
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
const deck = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 30 } } as never;

const model = (withRelations: boolean): MetaModel => ({
  version: '2-test',
  dataThroughDate: '2026-11-10',
  capabilities: { relations: withRelations, calibration: true },
  archetypes: [{ id: 1, name: 'Amber Rush', observedWinRate: 0.55, sampleSize: 50, centroid: { 1: 1 } }],
  cardWeights: {},
  relations: withRelations ? embed(2, { 1: [1, 0], 2: [0.9, 0.1] }) : undefined,
});

const renderPanel = (m: MetaModel, onAddCard?: (id: number) => void): ReturnType<typeof render> =>
  render(<AnalysisPanel fingerprint={fingerprint} meta={{ model: m, stale: false }} deck={deck} byId={byId} onAddCard={onAddCard} />);

describe('analysis panel suggestions', () => {
  afterEach(cleanup);

  it('renders suggestions with cost, inks, similarity and affinity basis', () => {
    renderPanel(model(true));
    const section = screen.getByTestId('suggestions-section');
    expect(section).toBeDefined();
    const row = screen.getByTestId('suggestion-row');
    expect(row.textContent).toContain('Suggested Card');
    expect(row.textContent).toContain(BASIS_FUSED.split(' + ')[1]!); // basis label visible
    expect(row.textContent).toMatch(/\d+%/); // similarity value
  });

  it('is hidden when the artifact lacks relation embeddings', () => {
    renderPanel(model(false));
    expect(screen.queryByTestId('suggestions-section')).toBeNull();
    expect(screen.queryByTestId('suggestion-row')).toBeNull();
  });

  it('wires the add button to the deck handler with the suggested card id', () => {
    const onAddCard = vi.fn(() => 'added' as const);
    renderPanel(model(true), onAddCard);
    fireEvent.click(screen.getByTitle('Add Suggested Card'));
    expect(onAddCard).toHaveBeenCalledWith(2); // the legal suggestion, not the off-ink card
  });

  it('shows the quiet empty state when the legal pool exhausts', () => {
    const saturatedDeck = { title: 'T', inks: ['Amber'], format: 'core', cards: { 1: 30, 2: 30 } } as never;
    // both amber cards owned, third candidate off-ink → pool exhausted
    const allOwned = byIdMap([amber(1, 'Deck Member'), amber(2, 'Suggested Card'), amber(3, 'Off Ink', { inks: ['Ruby'] })]);
    render(
      <AnalysisPanel
        fingerprint={fingerprint}
        meta={{ model: model(true), stale: false }}
        deck={saturatedDeck}
        byId={allOwned}
      />
    );
    expect(screen.getByTestId('suggestions-empty').textContent).toContain('No legal additions');
  });
});
