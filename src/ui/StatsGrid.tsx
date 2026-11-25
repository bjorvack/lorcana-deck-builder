import { lazy, type ReactNode, Suspense, useState } from 'react';
import type { CurveConsistency } from '../stats/curve';
import type { DeckStats } from '../stats/stats';
import { InkMatrix } from './charts';
import { StatList } from './components';
import { btnMiniCls, panelCls } from './styles';

const InkSplitDonut = lazy(() =>
  import('./charts/deck-charts').then((m) => ({ default: m.InkSplitDonut })),
);
const CurveConsistencyRich = lazy(() =>
  import('./charts/deck-charts').then((m) => ({
    default: m.CurveConsistencyRich,
  })),
);
const InkCurveBars = lazy(() =>
  import('./charts/deck-charts').then((m) => ({ default: m.InkCurveBars })),
);
const StatHistograms = lazy(() =>
  import('./charts/deck-charts').then((m) => ({ default: m.StatHistograms })),
);

/** the statistics dashboard below the deck editor (presentational) */
export function StatsGrid({
  stats,
  curve,
  distinct,
  franchiseAvailability,
}: {
  stats: DeckStats;
  curve: CurveConsistency | null;
  distinct: number;
  franchiseAvailability?: Record<string, number>;
}): ReactNode {
  const [insight, setInsight] = useState<'tags' | 'rarity' | 'franchises'>(
    'tags',
  );
  return (
    <section className="grid grid-cols-2 gap-3 mb-3 max-[900px]:grid-cols-1 [&_h3]:mt-0">
      <div className={`${panelCls} col-span-full`}>
        <div className="flex flex-wrap gap-2">
          <span className="bg-panel-2 border border-line rounded-[10px] py-[7px] px-[13px] text-sm">
            <strong className="text-gold">{stats.total}</strong> cards ·{' '}
            {distinct} distinct
          </span>
          <span className="bg-panel-2 border border-line rounded-[10px] py-[7px] px-[13px] text-sm">
            <strong className="text-gold">{stats.inkable}</strong> inkable (
            {Math.round(stats.inkablePct * 100)}%)
          </span>
          {curve && (
            <span className="bg-panel-2 border border-line rounded-[10px] py-[7px] px-[13px] text-sm">
              on curve through turn{' '}
              <strong className="text-gold">
                {Math.floor(curve.onCurveThrough)}
              </strong>
              <span className="text-parchment-muted">
                {' '}
                (median of {curve.trials.toLocaleString()} sims)
              </span>
            </span>
          )}
          {stats.avgStrength !== null && (
            <span className="bg-panel-2 border border-line rounded-[10px] py-[7px] px-[13px] text-sm text-parchment-muted">
              avg S/W/L {stats.avgStrength.toFixed(1)}/
              {stats.avgWillpower?.toFixed(1)}/{stats.avgLore?.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      <div className={panelCls}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Ink curve
        </h3>
        <Suspense fallback={<p className="text-parchment-muted">—</p>}>
          <InkCurveBars buckets={stats.inkabilityByCost} />
        </Suspense>
      </div>

      <div className={panelCls}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Curve consistency
        </h3>
        {curve ? (
          <Suspense fallback={<p className="text-parchment-muted">—</p>}>
            <CurveConsistencyRich
              byTurn={curve.byTurn}
              expectedInk={curve.expectedInk}
            />
          </Suspense>
        ) : (
          <p className="text-parchment-muted">—</p>
        )}
      </div>

      <div className={panelCls}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Cost × ink
        </h3>
        {stats.costInkRows.length > 0 ? (
          <InkMatrix rows={stats.costInkRows} maxCost={stats.maxCost} />
        ) : (
          <p className="text-parchment-muted">—</p>
        )}
      </div>

      <div className={panelCls}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Ink split
        </h3>
        <Suspense fallback={<p className="text-parchment-muted">—</p>}>
          <InkSplitDonut byInk={stats.byInk} byInkDual={stats.byInkDual} />
        </Suspense>
      </div>

      <div className={panelCls}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Character stats
        </h3>
        <Suspense fallback={<p className="text-parchment-muted">—</p>}>
          <StatHistograms distributions={stats.distributions} />
        </Suspense>
      </div>

      <div className={panelCls}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Types
        </h3>
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.byType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <span
                key={type}
                className="bg-panel-2 border border-line rounded-xl py-0.5 px-2.5 text-xs text-parchment-muted"
              >
                {count} {type.toLowerCase()}
              </span>
            ))}
        </div>
      </div>

      <div className={`${panelCls} col-span-full`}>
        <h3 className="mt-0 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
          Card insights
        </h3>
        <div
          className="flex gap-1.5 flex-wrap mb-2"
          role="tablist"
          aria-label="Insights"
        >
          {(
            [
              ['tags', 'Tags'],
              ['rarity', 'Rarity'],
              ['franchises', 'Franchises'],
            ] as const
          ).map(([key, tabLabel]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={insight === key}
              className={`${btnMiniCls} ${insight === key ? 'border-gold text-parchment' : ''}`}
              onClick={() => setInsight(key)}
            >
              {tabLabel}
            </button>
          ))}
        </div>
        {insight === 'tags' && (
          <StatList
            title="Tags"
            entries={Object.entries(stats.byTag)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)}
          />
        )}
        {insight === 'rarity' && (
          <StatList
            title="Rarity"
            entries={Object.entries(stats.byRarity).sort((a, b) => b[1] - a[1])}
          />
        )}
        {insight === 'franchises' && (
          <StatList
            title="Franchises"
            entries={Object.entries(stats.byFranchise)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)}
            totals={franchiseAvailability}
            footer="Unique cards available in this deck's format and inks."
          />
        )}
      </div>
    </section>
  );
}
