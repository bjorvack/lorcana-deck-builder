/**
 * Deck-statistics charts as configurations of the chart kit primitives.
 * Loaded in the lazy charts chunk (see StatsGrid).
 */
import type { ReactNode } from 'react';
import type { Ink } from '../../data/types';
import type { CostBucket } from '../../stats/stats';
import { INK_COLORS } from '../charts';
import { BarsWithLine, Donut, StackedBars } from './primitives';
import { chartTheme } from './theme';

/** ink split — one segment per ink, total copies centered, duals in the legend */
export function InkSplitDonut({
  byInk,
  byInkDual,
}: {
  byInk: Partial<Record<Ink, number>>;
  byInkDual: Partial<Record<Ink, number>>;
}): ReactNode {
  const entries = (Object.entries(byInk) as [Ink, number][]).filter(
    ([, v]) => v > 0,
  );
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return <p className="text-parchment-muted">—</p>;
  const dualTotal = entries.reduce((s, [ink]) => s + (byInkDual[ink] ?? 0), 0);
  const label = `Ink split: ${entries.map(([ink, v]) => `${ink} ${v}`).join(', ')}`;
  return (
    <Donut
      data={entries.map(([ink, value]) => ({
        label: ink,
        value,
        color: INK_COLORS[ink],
      }))}
      ariaLabel={label}
      center={{ value: total, caption: 'ink copies' }}
      legend={entries.map(([ink, v]) => ({
        id: ink,
        swatch: INK_COLORS[ink],
        content: (
          <>
            {ink} {v}
            {(byInkDual[ink] ?? 0) > 0 && (
              <span className="text-parchment-muted">
                {' '}
                ({byInkDual[ink]} dual)
              </span>
            )}
          </>
        ),
      }))}
      footnote={
        dualTotal > 0 ? 'dual-ink cards count toward both inks' : undefined
      }
    />
  );
}

/** curve consistency — on-curve % bars with the spendable-ink ramp as a line */
export function CurveConsistencyRich({
  byTurn,
  expectedInk,
}: {
  byTurn: (number | null)[];
  expectedInk: number[];
}): ReactNode {
  const data = byTurn.slice(1).map((p, i) => ({
    turn: i + 1,
    onCurve: p === null ? null : Math.round(p * 100),
    ink: Math.round((expectedInk[i + 1] ?? 0) * 100) / 100,
  }));
  return (
    <BarsWithLine
      data={data}
      xKey="turn"
      bar={{
        dataKey: 'onCurve',
        name: 'on curve (% of games)',
        color: chartTheme.deck,
      }}
      line={{
        dataKey: 'ink',
        name: 'spendable ink',
        color: chartTheme.opponentAlt,
      }}
      yLeftMax={100}
      yRightMax={8}
      yLeftFormatter={(v) => `${v}%`}
      tooltipLabelFormatter={(t) => `turn ${t}`}
      ariaLabel={`Curve consistency by turn: ${data
        .map(
          (d) =>
            `turn ${d.turn} ${d.onCurve === null ? 'no cards' : `${d.onCurve}% on curve`}`,
        )
        .join(', ')}`}
    />
  );
}

/** ink curve — inkable vs not-inkable copies stacked per cost, totals on top */
export function InkCurveBars({
  buckets,
}: {
  buckets: CostBucket[];
}): ReactNode {
  const data = buckets.map((b) => ({
    cost: b.cost,
    inkable: b.inkable,
    notInkable: b.notInkable,
    total: b.inkable + b.notInkable,
  }));
  return (
    <StackedBars
      data={data}
      xKey="cost"
      series={[
        {
          key: 'notInkable',
          name: 'not inkable',
          color: chartTheme.opponent,
          labelInSegment: true,
        },
        {
          key: 'inkable',
          name: 'inkable',
          color: chartTheme.deck,
          labelInSegment: true,
        },
      ]}
      totalsKey="total"
      legendOrder={['inkable', 'notInkable']}
      barSize={30}
      ariaLabel={`Ink curve by cost: ${data
        .map(
          (d) =>
            `cost ${d.cost}: ${d.inkable} inkable, ${d.notInkable} not inkable`,
        )
        .join(', ')}`}
    />
  );
}

/** character stat histograms — strength / willpower / lore spreads */
export function StatHistograms({
  distributions,
}: {
  distributions: {
    strength: Record<number, number>;
    willpower: Record<number, number>;
    lore: Record<number, number>;
  };
}): ReactNode {
  const keys = ['strength', 'willpower', 'lore'] as const;
  return (
    <div className="grid grid-cols-3 gap-3">
      {keys.map((key) => {
        const entries = Object.entries(distributions[key])
          .map(([v, c]) => ({ v: Number(v), c }))
          .sort((a, b) => a.v - b.v);
        return (
          <div key={key}>
            <h5 className="m-0 mb-1.5 text-xs uppercase text-parchment-muted">
              {key}
            </h5>
            <StackedBars
              data={entries.map((e) => ({ value: e.v, copies: e.c }))}
              xKey="value"
              series={[
                { key: 'copies', name: 'copies', color: chartTheme.deck },
              ]}
              showLegend={false}
              barSize={18}
              height={140}
              ariaLabel={`${key} distribution: ${entries
                .map((e) => `${e.v}: ${e.c} copies`)
                .join(', ')}`}
            />
          </div>
        );
      })}
    </div>
  );
}
