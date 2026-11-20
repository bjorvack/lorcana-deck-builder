/**
 * Reusable chart primitives (Recharts). App charts are thin configurations
 * of these — adding a chart of an existing type needs only data and config.
 * Explicit dimensions (no ResponsiveContainer) keep tests deterministic; CSS
 * scales the SVG down on small panels (max-width: 100%; height: auto).
 */
import type { ReactNode } from 'react';
import {
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  Bar as RechartsBar,
  RadarChart as RechartsRadarChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { chartTheme } from './theme';

export interface DonutDatum {
  label: string;
  value: number;
  color: string;
}

export interface DonutLegendItem {
  /** stable identity for the legend row */
  id: string;
  /** swatch color; omit for a text-only legend entry */
  swatch?: string;
  content: ReactNode;
}

/** donut with optional centered total and a data-driven legend */
export function Donut({
  data,
  ariaLabel,
  center,
  legend,
  footnote,
  size = 200,
  innerRadius = 62,
  outerRadius = 92,
}: {
  data: DonutDatum[];
  ariaLabel: string;
  center?: { value: ReactNode; caption: string };
  legend?: DonutLegendItem[];
  footnote?: ReactNode;
  size?: number;
  innerRadius?: number;
  outerRadius?: number;
}): ReactNode {
  return (
    <div
      className="flex flex-col items-center gap-2"
      role="img"
      aria-label={ariaLabel}
    >
      <div className="relative [&_.recharts-wrapper]:max-w-full [&_svg]:max-w-full [&_svg]:h-auto">
        <PieChart width={size} height={size}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            innerRadius={innerRadius}
            outerRadius={outerRadius}
            paddingAngle={2}
            stroke={chartTheme.segmentStroke}
            strokeWidth={2}
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell key={d.label} fill={d.color} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ ...chartTheme.tooltip }} />
        </PieChart>
        {center && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
            aria-hidden="true"
          >
            <strong className="text-[22px]">{center.value}</strong>
            <span className="text-parchment-muted text-[11px]">
              {center.caption}
            </span>
          </div>
        )}
      </div>
      {legend && (
        <div className="flex flex-wrap gap-3 text-xs text-parchment-muted mt-2">
          {legend.map((item) => (
            <span key={item.id} className="flex items-center gap-1">
              {item.swatch && (
                <i
                  className="inline-block w-[9px] h-[9px] rounded-full"
                  style={{ background: item.swatch }}
                />
              )}{' '}
              {item.content}
            </span>
          ))}
        </div>
      )}
      {footnote && (
        <p className="text-parchment-muted text-[11px] mt-1">{footnote}</p>
      )}
    </div>
  );
}

export interface RadarSeries {
  name: string;
  /** one value per axis, parallel to `axes` */
  values: number[];
  color: string;
  /** dashed outline without fill — for reference rings / baselines */
  reference?: boolean;
}

/** radar over named axes with an optional dashed midpoint reference ring */
export function RadarChart({
  axes,
  series,
  max = 100,
  midpoint,
  ariaLabel,
  width = 300,
  height = 240,
}: {
  axes: string[];
  series: RadarSeries[];
  max?: number;
  midpoint?: number;
  ariaLabel: string;
  width?: number;
  height?: number;
}): ReactNode {
  const data = axes.map((axis, i) => {
    const row: Record<string, string | number> = { axis };
    for (const s of series) row[s.name] = s.values[i] ?? 0;
    if (midpoint !== undefined) row.__midpoint = midpoint;
    return row;
  });
  return (
    <div
      className="flex justify-center [&_.recharts-wrapper]:max-w-full [&_svg]:max-w-full [&_svg]:h-auto"
      role="img"
      aria-label={ariaLabel}
    >
      <RechartsRadarChart width={width} height={height} data={data}>
        <PolarGrid stroke={chartTheme.grid} />
        <PolarAngleAxis dataKey="axis" tick={{ ...chartTheme.polarTick }} />
        <PolarRadiusAxis domain={[0, max]} tick={false} axisLine={false} />
        {midpoint !== undefined && (
          <Radar
            name="Midpoint reference"
            dataKey="__midpoint"
            stroke={chartTheme.textMuted}
            strokeDasharray="4 4"
            fill="none"
            fillOpacity={0}
            isAnimationActive={false}
          />
        )}
        {series.map((s) => (
          <Radar
            key={s.name}
            name={s.name}
            dataKey={s.name}
            stroke={s.color}
            strokeDasharray={s.reference ? '4 4' : undefined}
            fill={s.reference ? 'none' : s.color}
            fillOpacity={s.reference ? 0 : 0.35}
            isAnimationActive={false}
          />
        ))}
        <Legend wrapperStyle={{ ...chartTheme.legend }} />
        <Tooltip contentStyle={{ ...chartTheme.tooltip }} />
      </RechartsRadarChart>
    </div>
  );
}

export interface LineSeriesSpec {
  name: string;
  dataKey: string;
  color: string;
  dashed?: boolean;
  dotRadius?: number;
}

/** multi-series line chart (e.g. accumulated lore per turn vs a baseline) */
export function MultiLineChart({
  data,
  xKey,
  series,
  yMin = 0,
  yMax,
  ariaLabel,
  tooltipValueFormatter,
  tooltipLabelFormatter,
  legendFormatter,
  width = 340,
  height = 220,
  xTickFontSize = 11,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  series: LineSeriesSpec[];
  yMin?: number;
  yMax?: number;
  ariaLabel: string;
  tooltipValueFormatter?: (value: unknown, name: unknown) => [string, string];
  tooltipLabelFormatter?: (label: unknown) => string;
  legendFormatter?: (value: string) => string;
  width?: number;
  height?: number;
  xTickFontSize?: number;
}): ReactNode {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="[&_.recharts-wrapper]:max-w-full [&_svg]:max-w-full [&_svg]:h-auto"
    >
      <LineChart width={width} height={height} data={data}>
        <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey={xKey}
          tick={{ fill: chartTheme.textMuted, fontSize: xTickFontSize }}
          stroke={chartTheme.grid}
        />
        <YAxis
          domain={[yMin, yMax ?? 'auto']}
          tick={{ ...chartTheme.tick }}
          stroke={chartTheme.grid}
          width={28}
        />
        <Tooltip
          contentStyle={{ ...chartTheme.tooltip }}
          formatter={tooltipValueFormatter}
          labelFormatter={tooltipLabelFormatter}
        />
        <Legend
          wrapperStyle={{ ...chartTheme.legend }}
          formatter={legendFormatter}
        />
        {series.map((s) => (
          <Line
            key={s.dataKey}
            type="monotone"
            dataKey={s.dataKey}
            name={s.name}
            stroke={s.color}
            strokeWidth={s.dashed ? 1.5 : 2.5}
            strokeDasharray={s.dashed ? '5 4' : undefined}
            dot={s.dotRadius ? { r: s.dotRadius, fill: s.color } : false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </div>
  );
}

/** composed bars with an optional line on a secondary axis */
export function BarsWithLine({
  data,
  xKey,
  bar,
  line,
  yLeftMax = 100,
  yRightMax,
  yLeftFormatter,
  ariaLabel,
  tooltipLabelFormatter,
  width = 360,
  height = 220,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  bar: { dataKey: string; name: string; color: string };
  line?: { dataKey: string; name: string; color: string };
  yLeftMax?: number;
  yRightMax?: number;
  yLeftFormatter?: (value: number) => string;
  ariaLabel: string;
  tooltipLabelFormatter?: (label: unknown) => string;
  width?: number;
  height?: number;
}): ReactNode {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="[&_.recharts-wrapper]:max-w-full [&_svg]:max-w-full [&_svg]:h-auto"
    >
      <ComposedChart width={width} height={height} data={data}>
        <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey={xKey}
          tick={{ ...chartTheme.tick }}
          stroke={chartTheme.grid}
        />
        <YAxis
          yAxisId="left"
          domain={[0, yLeftMax]}
          tick={{ ...chartTheme.tick }}
          stroke={chartTheme.grid}
          width={32}
          tickFormatter={yLeftFormatter}
        />
        {line && (
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, yRightMax ?? 'auto']}
            tick={{ ...chartTheme.tick }}
            stroke={chartTheme.grid}
            width={24}
          />
        )}
        <Tooltip
          contentStyle={{ ...chartTheme.tooltip }}
          labelFormatter={tooltipLabelFormatter}
        />
        <Legend wrapperStyle={{ ...chartTheme.legend }} />
        <RechartsBar
          yAxisId="left"
          dataKey={bar.dataKey}
          name={bar.name}
          fill={bar.color}
          fillOpacity={0.85}
          radius={[3, 3, 0, 0]}
          isAnimationActive={false}
        />
        {line && (
          <Line
            yAxisId="right"
            type="monotone"
            dataKey={line.dataKey}
            name={line.name}
            stroke={line.color}
            strokeWidth={2}
            dot={{ r: 2, fill: line.color }}
            isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </div>
  );
}

export interface StackedSeries {
  key: string;
  name: string;
  color: string;
  /** dark text inside segments (light segment fills) */
  labelInSegment?: boolean;
}

/** stacked (or single-series) column bars with optional column totals */
export function StackedBars({
  data,
  xKey,
  series,
  totalsKey,
  ariaLabel,
  barSize = 38,
  height = 190,
  width,
  legendOrder,
  showLegend = true,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  series: StackedSeries[];
  /** data property holding the per-column total, labeled above each column */
  totalsKey?: string;
  ariaLabel: string;
  barSize?: number;
  height?: number;
  /** explicit width; defaults to fitting the columns */
  width?: number;
  /** legend display order (defaults to the series order) */
  legendOrder?: string[];
  showLegend?: boolean;
}): ReactNode {
  const w = width ?? data.length * (barSize + 6) + 48;
  const ordered = legendOrder
    ? [...series].sort(
        (a, b) => legendOrder.indexOf(a.key) - legendOrder.indexOf(b.key),
      )
    : series;
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="[&_.recharts-wrapper]:max-w-full [&_svg]:max-w-full [&_svg]:h-auto"
    >
      <BarChart width={w} height={height} data={data} margin={{ top: 14 }}>
        <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
        <XAxis
          dataKey={xKey}
          tick={{ ...chartTheme.tick }}
          stroke={chartTheme.grid}
        />
        <YAxis
          tick={{ ...chartTheme.tick }}
          stroke={chartTheme.grid}
          width={24}
        />
        <Tooltip contentStyle={{ ...chartTheme.tooltip }} />
        {series.map((s, i) => (
          <RechartsBar
            key={s.key}
            dataKey={s.key}
            name={s.name}
            stackId="stack"
            fill={s.color}
            isAnimationActive={false}
          >
            {i === series.length - 1 && totalsKey && (
              <LabelList
                dataKey={totalsKey}
                position="top"
                className="fill-parchment-muted"
                fontSize={11}
              />
            )}
            {s.labelInSegment && (
              <LabelList
                dataKey={s.key}
                position="center"
                content={(props: {
                  value?: unknown;
                  x?: number | string;
                  y?: number | string;
                  width?: number | string;
                  height?: number | string;
                }) => {
                  const v = typeof props.value === 'number' ? props.value : 0;
                  const num = (n: number | string | undefined): number =>
                    typeof n === 'number' ? n : 0;
                  return v > 0 ? (
                    <text
                      x={num(props.x) + num(props.width) / 2}
                      y={num(props.y) + num(props.height) / 2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-kelp"
                      fontSize={13}
                      fontWeight={600}
                    >
                      {v}
                    </text>
                  ) : null;
                }}
              />
            )}
          </RechartsBar>
        ))}
      </BarChart>
      {showLegend && (
        <div className="flex flex-wrap gap-3 text-xs text-parchment-muted mt-2 justify-center">
          {ordered.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <i
                className="inline-block w-[9px] h-[9px] rounded-[3px]"
                style={{ background: s.color }}
              />{' '}
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
