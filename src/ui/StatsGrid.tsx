import { lazy, type ReactNode, Suspense, useState } from 'react';
import type { CurveConsistency } from '../stats/curve';
import type { DeckStats } from '../stats/stats';
import { CurveChart, InkMatrix, StatDistributions } from './charts';
import { StatList } from './components';

const InkSplitDonut = lazy(() =>
  import('./charts-rich').then((m) => ({ default: m.InkSplitDonut })),
);
const CurveConsistencyRich = lazy(() =>
  import('./charts-rich').then((m) => ({ default: m.CurveConsistencyRich })),
);

/** the statistics dashboard below the deck editor (presentational) */
export function StatsGrid({
  stats,
  curve,
  distinct,
}: {
  stats: DeckStats;
  curve: CurveConsistency | null;
  distinct: number;
}): ReactNode {
  const [insight, setInsight] = useState<'tags' | 'rarity' | 'franchises'>(
    'tags',
  );
  const chipBigCls =
    'bg-panel-2 border border-line rounded-[10px] py-[7px] px-[13px] text-sm';
  return (
    <section className="grid grid-cols-2 gap-3 mb-3 max-[900px]:grid-cols-1 [&_h3]:mt-0">
      <div className="panel col-span-full">
        <div className="chips">
          <span className={chipBigCls}>
            <strong className="text-gold">{stats.total}</strong> cards ·{' '}
            {distinct} distinct
          </span>
          <span className={chipBigCls}>
            <strong className="text-gold">{stats.inkable}</strong> inkable (
            {Math.round(stats.inkablePct * 100)}%)
          </span>
          {curve && (
            <span className={chipBigCls}>
              on curve through turn{' '}
              <strong className="text-gold">
                {Math.floor(curve.onCurveThrough)}
              </strong>
              <span className="muted">
                {' '}
                (median of {curve.trials.toLocaleString()} sims)
              </span>
            </span>
          )}
          {stats.avgStrength !== null && (
            <span className={`${chipBigCls} muted`}>
              avg S/W/L {stats.avgStrength.toFixed(1)}/
              {stats.avgWillpower?.toFixed(1)}/{stats.avgLore?.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>Ink curve</h3>
        <CurveChart buckets={stats.inkabilityByCost} />
      </div>

      <div className="panel">
        <h3>Curve consistency</h3>
        {curve ? (
          <Suspense fallback={<p className="muted">—</p>}>
            <CurveConsistencyRich
              byTurn={curve.byTurn}
              expectedInk={curve.expectedInk}
            />
          </Suspense>
        ) : (
          <p className="muted">—</p>
        )}
      </div>

      <div className="panel">
        <h3>Cost × ink</h3>
        {stats.costInkRows.length > 0 ? (
          <InkMatrix rows={stats.costInkRows} maxCost={stats.maxCost} />
        ) : (
          <p className="muted">—</p>
        )}
      </div>

      <div className="panel">
        <h3>Ink split</h3>
        <Suspense fallback={<p className="muted">—</p>}>
          <InkSplitDonut byInk={stats.byInk} byInkDual={stats.byInkDual} />
        </Suspense>
      </div>

      <div className="panel">
        <h3>Character stats</h3>
        <StatDistributions distributions={stats.distributions} />
      </div>

      <div className="panel">
        <h3>Types</h3>
        <div className="chips">
          {Object.entries(stats.byType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <span key={type} className="chip">
                {count} {type.toLowerCase()}
              </span>
            ))}
        </div>
      </div>

      <div className="panel col-span-full">
        <h3>Card insights</h3>
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
              className={`btn btn-mini ${insight === key ? 'border-gold text-parchment' : ''}`}
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
          />
        )}
      </div>
    </section>
  );
}
