import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Ink } from '../data/types';
import type { AxisName } from '../stats/fingerprint';
import type { MatchupEstimate } from '../stats/goldfish';
import { OPPONENT_PROFILES } from '../stats/profiles';
import { INK_COLORS } from './charts';
import { mutedCls } from './styles';

/**
 * Rich SVG charts (Recharts, lazy-loaded) for the shapes divs cannot express
 * well: donuts, radar, multi-series lines. Ink-branded colors and the dark
 * panel palette are shared with the CSS charts via INK_COLORS and the
 * :root variables below.
 */
const AXIS = '#8a94a6';
const GRID = '#2a3342';
const TEXT = '#e8ecf3';
const AMBER = INK_COLORS.Amber;
const STEEL = INK_COLORS.Steel;

const TOOLTIP_STYLE = {
  background: '#1f2735',
  border: `1px solid ${GRID}`,
  borderRadius: 8,
  color: TEXT,
  fontSize: 12,
} as const;

const legendStyle = { color: AXIS, fontSize: 12 } as const;

/** cumulative opponent lore from the scripted per-turn pace */
const cumulative = (perTurn: number[]): number[] => {
  let sum = 0;
  return perTurn.map((v) => (sum += v));
};

// ---------------------------------------------------------------------------
// Ink split — donut with per-ink segments, dual-ink counts in the legend
// ---------------------------------------------------------------------------

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
  if (total === 0) return <p className={mutedCls}>—</p>;
  const dualTotal = entries.reduce((s, [ink]) => s + (byInkDual[ink] ?? 0), 0);
  const label = `Ink split: ${entries.map(([ink, v]) => `${ink} ${v}`).join(', ')}`;
  return (
    <div
      className="flex flex-col items-center gap-2 [&_svg]:max-w-full [&_svg]:h-auto"
      role="img"
      aria-label={label}
    >
      <div className="relative [&_svg]:max-w-full [&_svg]:h-auto">
        <PieChart width={200} height={200}>
          <Pie
            data={entries.map(([ink, value]) => ({ ink, value }))}
            dataKey="value"
            nameKey="ink"
            innerRadius={62}
            outerRadius={92}
            paddingAngle={2}
            stroke="#10141c"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {entries.map(([ink]) => (
              <Cell key={ink} fill={INK_COLORS[ink]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => [
              `${value} copies${(byInkDual[name as Ink] ?? 0) > 0 ? ` · ${byInkDual[name as Ink]} dual-ink` : ''}`,
              name,
            ]}
          />
        </PieChart>
        <div
          className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
          aria-hidden="true"
        >
          <strong className="text-[22px]">{total}</strong>
          <span className="text-parchment-muted text-[11px]">ink copies</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-parchment-muted mt-2">
        {entries.map(([ink, v]) => (
          <span key={ink}>
            <i
              className="inline-block w-[9px] h-[9px] rounded-full mr-1"
              style={{ background: INK_COLORS[ink] }}
            />{' '}
            {ink} {v}
            {(byInkDual[ink] ?? 0) > 0 && (
              <span className="text-parchment-muted">
                {' '}
                ({byInkDual[ink]} dual)
              </span>
            )}
          </span>
        ))}
        {dualTotal > 0 && (
          <span className="text-parchment-muted text-[11px] mt-1">
            dual-ink cards count toward both inks
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Viability profile — radar over the five axes with a midpoint reference ring
// ---------------------------------------------------------------------------

const AXES: AxisName[] = [
  'Tempo',
  'Consistency',
  'Resilience',
  'Interaction',
  'Reach',
];

export function ViabilityRadar({
  axes,
}: {
  axes: Record<AxisName, number>;
}): ReactNode {
  const data = AXES.map((axis) => ({
    axis,
    deck: axes[axis],
    midpoint: 50,
  }));
  return (
    <div
      className="flex justify-center [&_svg]:max-w-full [&_svg]:h-auto"
      role="img"
      aria-label={`Viability profile: ${AXES.map((a) => `${a} ${axes[a]}`).join(', ')} (dotted ring marks the 50 midpoint)`}
    >
      <RadarChart width={300} height={240} data={data}>
        <PolarGrid stroke={GRID} />
        <PolarAngleAxis dataKey="axis" tick={{ fill: AXIS, fontSize: 12 }} />
        <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
        <Radar
          name="Midpoint reference"
          dataKey="midpoint"
          stroke={AXIS}
          strokeDasharray="4 4"
          fill="none"
          fillOpacity={0}
          isAnimationActive={false}
        />
        <Radar
          name="This deck"
          dataKey="deck"
          stroke={AMBER}
          fill={AMBER}
          fillOpacity={0.35}
          isAnimationActive={false}
        />
        <Legend wrapperStyle={legendStyle} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
      </RadarChart>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lore race — our accumulated lore per turn vs the selected scripted baseline
// ---------------------------------------------------------------------------

export function LoreRaceLines({
  matchups,
}: {
  matchups: MatchupEstimate[];
}): ReactNode {
  const [selected, setSelected] = useState(matchups[0]?.profileId);
  const match = matchups.find((m) => m.profileId === selected) ?? matchups[0];
  if (!match) return null;
  const profile = OPPONENT_PROFILES.find((p) => p.id === match.profileId)!;
  const theirs = cumulative(profile.lorePerTurn);
  const data = match.loreByTurn.map((lore, i) => ({
    turn: i + 1,
    ours: Math.round(lore * 10) / 10,
    theirs: Math.round((theirs[i] ?? 0) * 10) / 10,
  }));
  return (
    <div className="[&_svg]:max-w-full [&_svg]:h-auto">
      <div
        className="flex gap-1.5 flex-wrap mb-2"
        role="tablist"
        aria-label="Baseline"
      >
        {matchups.map((m) => (
          <button
            key={m.profileId}
            type="button"
            role="tab"
            aria-selected={m.profileId === match.profileId}
            className={`bg-panel-2 text-parchment border rounded-lg py-0.5 px-2 cursor-pointer text-xs hover:border-gold ${m.profileId === match.profileId ? 'border-gold text-parchment' : 'border-line'}`}
            onClick={() => setSelected(m.profileId)}
          >
            {m.name.replace(' baseline', '')} · {Math.round(m.winRate * 100)}%
          </button>
        ))}
      </div>
      <div
        role="img"
        aria-label={`Lore race vs ${profile.name}: our mean accumulated lore per turn against the baseline's scripted pace; win rate ${Math.round(match.winRate * 100)}%`}
      >
        <LineChart width={340} height={220} data={data}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
          <XAxis
            dataKey="turn"
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
          />
          <YAxis
            domain={[0, 20]}
            tick={{ fill: AXIS, fontSize: 11 }}
            stroke={GRID}
            width={28}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => [
              `${value} lore`,
              name === 'ours' ? 'this deck' : profile.name,
            ]}
            labelFormatter={(t) => `turn ${t}`}
          />
          <Legend
            wrapperStyle={legendStyle}
            formatter={(value) =>
              value === 'ours' ? 'this deck' : profile.name
            }
          />
          <Line
            type="monotone"
            dataKey="theirs"
            stroke={STEEL}
            strokeWidth={1.5}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="ours"
            stroke={AMBER}
            strokeWidth={2.5}
            dot={{ r: 2, fill: AMBER }}
            isAnimationActive={false}
          />
        </LineChart>
      </div>
      <p className="text-parchment-muted text-[11px] mt-1">
        Mean accumulated lore at the end of each of our turns vs the baseline's
        scripted pace — 20 lore wins.
        {match.medianFinish !== null &&
          ` This deck finishes around turn ${match.medianFinish}.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Curve consistency — on-curve % bars + expected ink as a line (right axis)
// ---------------------------------------------------------------------------

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
    <div
      role="img"
      aria-label={`Curve consistency by turn: ${data
        .map(
          (d) =>
            `turn ${d.turn} ${d.onCurve === null ? 'no cards' : `${d.onCurve}% on curve`}`,
        )
        .join(', ')}`}
    >
      <ComposedChart width={360} height={220} data={data}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        <XAxis
          dataKey="turn"
          tick={{ fill: AXIS, fontSize: 11 }}
          stroke={GRID}
        />
        <YAxis
          yAxisId="pct"
          domain={[0, 100]}
          tick={{ fill: AXIS, fontSize: 11 }}
          stroke={GRID}
          width={32}
          tickFormatter={(v) => `${v}%`}
        />
        <YAxis
          yAxisId="ink"
          orientation="right"
          domain={[0, 8]}
          tick={{ fill: AXIS, fontSize: 11 }}
          stroke={GRID}
          width={24}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value, name) =>
            name === 'onCurve'
              ? [`${value}% of games`, 'cost-t card played on curve']
              : [`${value} ink available`, 'mean spendable ink']
          }
          labelFormatter={(t) => `turn ${t}`}
        />
        <Legend
          wrapperStyle={legendStyle}
          formatter={(value) =>
            value === 'onCurve' ? 'on curve (% of games)' : 'spendable ink'
          }
        />
        <Bar
          yAxisId="pct"
          dataKey="onCurve"
          fill={AMBER}
          fillOpacity={0.85}
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
        />
        <Line
          yAxisId="ink"
          type="monotone"
          dataKey="ink"
          stroke={STEEL}
          strokeWidth={2}
          dot={{ r: 2, fill: STEEL }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </div>
  );
}
