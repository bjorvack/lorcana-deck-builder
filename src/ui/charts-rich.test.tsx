/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchupEstimate } from '../stats/goldfish';
import {
  CurveConsistencyRich,
  InkSplitDonut,
  LoreRaceLines,
  ViabilityRadar,
} from './charts-rich';

afterEach(cleanup);

const label = (): string =>
  document.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';

describe('InkSplitDonut', () => {
  it('renders segments, the center total and dual-ink legend counts', () => {
    render(
      <InkSplitDonut
        byInk={{ Amber: 26, Amethyst: 34 }}
        byInkDual={{ Amethyst: 10 }}
      />,
    );
    expect(label()).toContain('Amber 26');
    expect(label()).toContain('Amethyst 34');
    expect(screen.getByText('60')).toBeTruthy(); // center total
    expect(screen.getByText(/Amethyst 34/)).toBeTruthy();
    expect(screen.getByText(/10 dual/)).toBeTruthy();
    expect(screen.getByText(/count toward both inks/)).toBeTruthy();
  });

  it('falls back to the empty placeholder without ink data', () => {
    render(<InkSplitDonut byInk={{}} byInkDual={{}} />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('ViabilityRadar', () => {
  it('renders all five axes with the midpoint reference ring', () => {
    const { container } = render(
      <ViabilityRadar
        axes={{
          Tempo: 29,
          Consistency: 74,
          Resilience: 31,
          Interaction: 100,
          Reach: 100,
        }}
      />,
    );
    expect(label()).toContain('Tempo 29');
    expect(label()).toContain('Resilience 31');
    expect(label()).toContain('50 midpoint');
    expect(
      container.querySelectorAll('.recharts-polar-angle-axis-tick'),
    ).toHaveLength(5);
    // deck polygon + midpoint reference polygon
    expect(container.querySelectorAll('.recharts-radar-polygon')).toHaveLength(
      2,
    );
  });
});

describe('LoreRaceLines', () => {
  const loreByTurn = Array.from({ length: 15 }, (_, i) => (i + 1) * 1.2);
  const matchups: MatchupEstimate[] = [
    {
      profileId: 'midrange',
      name: 'Midrange baseline',
      winRate: 0.12,
      medianFinish: 10,
      loreByTurn,
    },
    {
      profileId: 'aggressive',
      name: 'Aggressive baseline',
      winRate: 0.05,
      medianFinish: null,
      loreByTurn,
    },
  ];

  it('renders the race for the selected baseline and switches profiles', () => {
    render(<LoreRaceLines matchups={matchups} />);
    expect(label()).toContain('Lore race vs Midrange baseline');
    expect(label()).toContain('win rate 12%');
    expect(screen.getByText(/finishes around turn 10/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Aggressive/ }));
    expect(label()).toContain('Lore race vs Aggressive baseline');
    expect(screen.queryByText(/finishes around turn/)).toBeNull();
  });

  it('marks the selected profile tab', () => {
    render(<LoreRaceLines matchups={matchups} />);
    expect(
      screen
        .getByRole('tab', { name: /Midrange/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen
        .getByRole('tab', { name: /Aggressive/ })
        .getAttribute('aria-selected'),
    ).toBe('false');
  });
});

describe('CurveConsistencyRich', () => {
  it('shows on-curve bars and skips turns without matching costs', () => {
    const { container } = render(
      <CurveConsistencyRich
        byTurn={[null, 0.7, 0.82, null, 0.79]}
        expectedInk={[0, 1, 2, 3, 4]}
      />,
    );
    expect(label()).toContain('turn 1 70% on curve');
    expect(label()).toContain('turn 2 82% on curve');
    expect(label()).toContain('turn 3 no cards');
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(
      3,
    );
  });
});
