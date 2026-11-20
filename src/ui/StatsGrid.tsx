import { lazy, type ReactNode, Suspense } from 'react';
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
  return (
    <section className="statsgrid">
      <div className="panel span2">
        <div className="chips">
          <span className="chip-big">
            <strong>{stats.total}</strong> cards · {distinct} distinct
          </span>
          <span className="chip-big">
            <strong>{stats.inkable}</strong> inkable (
            {Math.round(stats.inkablePct * 100)}%)
          </span>
          {curve && (
            <span className="chip-big">
              on curve through turn{' '}
              <strong>{Math.floor(curve.onCurveThrough)}</strong>
              <span className="muted">
                {' '}
                (median of {curve.trials.toLocaleString()} sims)
              </span>
            </span>
          )}
          {stats.avgStrength !== null && (
            <span className="chip-big muted">
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
        <h4 className="mt">Types</h4>
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

      <div className="panel">
        <h3>Character stats</h3>
        <StatDistributions distributions={stats.distributions} />
      </div>

      <div className="panel span2 morestats">
        <StatList
          title="Tags"
          entries={Object.entries(stats.byTag)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)}
        />
        <StatList
          title="Rarity"
          entries={Object.entries(stats.byRarity).sort((a, b) => b[1] - a[1])}
        />
        <StatList
          title="Franchises"
          entries={Object.entries(stats.byFranchise)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)}
        />
      </div>
    </section>
  );
}
