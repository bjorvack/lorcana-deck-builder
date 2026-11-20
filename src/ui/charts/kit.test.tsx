/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchupEstimate } from '../../stats/goldfish';
import { LoreRaceLines, ViabilityRadar } from './analysis-charts';
import {
  CurveConsistencyRich,
  InkCurveBars,
  InkSplitDonut,
  StatHistograms,
} from './deck-charts';
import { BarsWithLine, Donut, MultiLineChart, StackedBars } from './primitives';

afterEach(cleanup);

const label = (): string =>
  document.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';

describe('Donut primitive', () => {
  it('renders segments, the centered total and data-driven legend', () => {
    render(
      <Donut
        data={[
          { label: 'Amber', value: 26, color: '#d9a520' },
          { label: 'Amethyst', value: 34, color: '#8e4fd0' },
        ]}
        ariaLabel="Ink split: Amber 26, Amethyst 34"
        center={{ value: 60, caption: 'copies' }}
        legend={[
          { id: 'amber', swatch: '#d9a520', content: <>Amber 26</> },
          { id: 'amethyst', swatch: '#8e4fd0', content: <>Amethyst 34</> },
        ]}
        footnote="a footnote"
      />,
    );
    expect(label()).toContain('Amber 26');
    expect(label()).toContain('Amethyst 34');
    expect(screen.getByText('60')).toBeTruthy();
    expect(screen.getByText('copies')).toBeTruthy();
    expect(screen.getByText(/Amber 26/)).toBeTruthy();
    expect(screen.getByText('a footnote')).toBeTruthy();
  });
});

describe('InkSplitDonut config', () => {
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

describe('RadarChart primitive + ViabilityRadar config', () => {
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

describe('MultiLineChart primitive + LoreRaceLines config', () => {
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

  it('renders series for both the deck and the baseline', () => {
    render(
      <MultiLineChart
        data={[
          { turn: 1, ours: 2, theirs: 1 },
          { turn: 2, ours: 3, theirs: 2 },
        ]}
        xKey="turn"
        series={[
          {
            name: 'this deck',
            dataKey: 'ours',
            color: '#d3ba84',
            dotRadius: 2,
          },
          {
            name: 'Midrange',
            dataKey: 'theirs',
            color: '#8d99a6',
            dashed: true,
          },
        ]}
        yMax={20}
        ariaLabel="test chart"
      />,
    );
    const { container } = { container: document.body };
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(2);
    expect(screen.getByText('this deck')).toBeTruthy();
    expect(screen.getByText('Midrange')).toBeTruthy();
  });

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

describe('BarsWithLine primitive + CurveConsistencyRich config', () => {
  it('renders bars plus a line series', () => {
    const { container } = render(
      <BarsWithLine
        data={[
          { turn: 1, pct: 70, ramp: 1 },
          { turn: 2, pct: 82, ramp: 2 },
        ]}
        xKey="turn"
        bar={{ dataKey: 'pct', name: 'pct', color: '#d3ba84' }}
        line={{ dataKey: 'ramp', name: 'ramp', color: '#373b70' }}
        yLeftMax={100}
        ariaLabel="test"
      />,
    );
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(
      2,
    );
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(1);
  });

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

describe('StackedBars primitive', () => {
  it('stacks the series and labels column totals', () => {
    const { container } = render(
      <StackedBars
        data={[
          { cost: 1, a: 2, b: 1, total: 3 },
          { cost: 2, a: 0, b: 4, total: 4 },
        ]}
        xKey="cost"
        series={[
          { key: 'a', name: 'a', color: '#d3ba84', labelInSegment: true },
          { key: 'b', name: 'b', color: '#8d99a6', labelInSegment: true },
        ]}
        totalsKey="total"
        showLegend={false}
        ariaLabel="test"
      />,
    );
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(
      3, // two a-segments (one zero) + two b-segments
    );
  });
});

describe('InkCurveBars config', () => {
  it('renders one stacked column per cost bucket', () => {
    const { container } = render(
      <InkCurveBars
        buckets={[
          { cost: 1, inkable: 3, notInkable: 1 },
          { cost: 2, inkable: 4, notInkable: 0 },
        ]}
      />,
    );
    expect(label()).toContain('cost 1: 3 inkable, 1 not inkable');
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(
      3,
    );
  });
});

describe('StatHistograms config', () => {
  it('renders a mini histogram per stat', () => {
    const { container } = render(
      <StatHistograms
        distributions={{
          strength: { 2: 5, 3: 7 },
          willpower: { 4: 9 },
          lore: { 1: 2, 2: 3 },
        }}
      />,
    );
    expect(screen.getByText('strength')).toBeTruthy();
    expect(screen.getByText('willpower')).toBeTruthy();
    expect(screen.getByText('lore')).toBeTruthy();
    expect(container.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(
      5,
    );
  });
});
