import type { ReactNode } from 'react';
import type { Card, Ink } from '../data/types';
import type { CostBucket, CostInkRow } from '../stats/stats';

export const INK_COLORS: Record<Ink, string> = {
  Amber: '#d9a520',
  Amethyst: '#8e4fd0',
  Emerald: '#1fa86a',
  Ruby: '#d0453c',
  Sapphire: '#3a6fd8',
  Steel: '#8d99a6',
};

export function CostBadge({ card, size, className }: { card: Card; size?: 'sm' | 'lg'; className?: string }): ReactNode {
  const inkA = INK_COLORS[card.inks[0]!];
  const style =
    card.isDualInk && card.inks.length === 2
      ? { background: `linear-gradient(135deg, ${inkA} 0 50%, ${INK_COLORS[card.inks[1]!]} 50% 100%)` }
      : { background: inkA };
  return (
    <span className={`costbadge ${size ?? ''} ${className ?? ''}`} style={style} title={card.inks.join(' / ')}>
      <span className="costbadge-inner">{card.cost}</span>
    </span>
  );
}

export function InkDots({ inks, inline }: { inks: Ink[]; inline?: boolean }): ReactNode {
  if (inks.length === 0) return <span className="inkdots" title="no ink">⌀</span>;
  return (
    <span className={inline ? 'inkdots inkdots-inline' : 'inkdots'}>
      {inks.map((ink) => (
        <span key={ink} className="inkdot" style={{ background: INK_COLORS[ink] }} title={ink} />
      ))}
    </span>
  );
}

/** columns per cost with the count printed inside each segment */
export function CurveChart({ buckets }: { buckets: CostBucket[] }): ReactNode {
  const max = Math.max(1, ...buckets.map((b) => b.inkable + b.notInkable));
  return (
    <div className="curve2">
      {buckets.map((b) => (
        <div key={b.cost} className="curve2-col">
          <span className="curve2-total">{b.inkable + b.notInkable}</span>
          <div className="curve2-stack">
            <div className="curve2-seg curve2-notink" style={{ height: `${(b.notInkable / max) * 100}%` }}>
              {b.notInkable > 0 && <span>{b.notInkable}</span>}
            </div>
            <div className="curve2-seg curve2-ink" style={{ height: `${(b.inkable / max) * 100}%` }}>
              {b.inkable > 0 && <span>{b.inkable}</span>}
            </div>
          </div>
          <span className="curve2-cost">{b.cost}</span>
        </div>
      ))}
      <div className="curve2-legend">
        <span><i className="dot dot-ink" /> inkable</span>
        <span><i className="dot dot-notink" /> not inkable</span>
      </div>
    </div>
  );
}

/** heatmap: rows = inks (+ dual combos), columns = costs, cells = copy counts */
export function InkMatrix({ rows, maxCost }: { rows: CostInkRow[]; maxCost: number }): ReactNode {
  const costs = Array.from({ length: Math.max(maxCost, 1) }, (_, i) => i + 1);
  const maxCount = Math.max(1, ...rows.flatMap((r) => Object.values(r.cells)));
  const rowColor = (row: CostInkRow): string =>
    row.inks.length === 2
      ? `linear-gradient(135deg, ${INK_COLORS[row.inks[0]!]} 0 50%, ${INK_COLORS[row.inks[1]!]} 50% 100%)`
      : INK_COLORS[row.inks[0]!];
  return (
    <div className="inkmatrix">
      <div className="inkmatrix-row" style={{ gridTemplateColumns: `110px repeat(${costs.length}, 1fr)` }}>
        <span />
        {costs.map((c) => (
          <span key={c} className="inkmatrix-cost">{c}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.key} className="inkmatrix-row" style={{ gridTemplateColumns: `110px repeat(${costs.length}, 1fr)` }}>
          <span className="inkmatrix-label" title={row.label}>{row.label}</span>
          {costs.map((cost) => {
            const count = row.cells[cost] ?? 0;
            return (
              <span key={cost} className="inkmatrix-cell" title={count > 0 ? `${row.label} · cost ${cost}: ${count}` : undefined}>
                {count > 0 && (
                  <span
                    className="inkmatrix-fill"
                    style={{ background: rowColor(row), opacity: 0.3 + 0.55 * (count / maxCount) }}
                  />
                )}
                {count > 0 && <span className="inkmatrix-count">{count}</span>}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** per-turn bars: % of simulated games where a cost-t card was played on turn t */
export function CurveConsistencyChart({ byTurn, expectedInk }: {
  byTurn: (number | null)[];
  expectedInk: number[];
}): ReactNode {
  return (
    <div className="consist">
      {byTurn.slice(1).map((p, i) => {
        const turn = i + 1;
        return (
          <div
            key={turn}
            className="consist-col"
            title={p === null ? `turn ${turn}: no ${turn}-cost cards in the deck` : `turn ${turn}: ${Math.round(p * 100)}% on curve · avg ${expectedInk[turn]?.toFixed(2)} ink`}
          >
            {p === null ? (
              <span className="consist-skip">–</span>
            ) : (
              <>
                <span className="consist-v">{Math.round(p * 100)}%</span>
                <div className="consist-barwrap"><div className="consist-bar" style={{ height: `${p * 100}%` }} /></div>
              </>
            )}
            <span className="consist-t">{turn}</span>
          </div>
        );
      })}
    </div>
  );
}

/** one 100% stacked bar showing the deck's ink identity; hatched = dual-ink copies */
export function InkSplitBar({ byInk, byInkDual }: {
  byInk: Partial<Record<Ink, number>>;
  byInkDual: Partial<Record<Ink, number>>;
}): ReactNode {
  const entries = Object.entries(byInk) as [Ink, number][];
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (sum === 0) return <p className="muted">—</p>;
  return (
    <div>
      <div className="inksplit">
        {entries.map(([ink, v]) => {
          const dual = byInkDual[ink] ?? 0;
          return (
            <span
              key={ink}
              className="inksplit-seg"
              style={{ width: `${(v / sum) * 100}%`, background: INK_COLORS[ink] }}
              title={`${ink}: ${v}${dual > 0 ? ` (${dual} dual-ink copies)` : ''}`}
            >
              {dual > 0 && <span className="inksplit-dual" style={{ width: `${(dual / v) * 100}%` }} />}
            </span>
          );
        })}
      </div>
      <div className="inksplit-legend">
        {entries.map(([ink, v]) => (
          <span key={ink}><i className="dot" style={{ background: INK_COLORS[ink] }} /> {ink} {v}</span>
        ))}
      </div>
    </div>
  );
}

/** three mini column charts: character strength / willpower / lore spread */
export function StatDistributions({ distributions }: {
  distributions: { strength: Record<number, number>; willpower: Record<number, number>; lore: Record<number, number> };
}): ReactNode {
  const keys = ['strength', 'willpower', 'lore'] as const;
  return (
    <div className="distrow">
      {keys.map((key) => {
        const entries = Object.entries(distributions[key])
          .map(([v, c]) => ({ v: Number(v), c }))
          .sort((a, b) => a.v - b.v);
        const max = Math.max(1, ...entries.map((e) => e.c));
        return (
          <div key={key} className="dist">
            <h5>{key}</h5>
            <div className="dist-bars">
              {entries.map((e) => (
                <div key={e.v} className="dist-col" title={`${key} ${e.v}: ${e.c} copies`}>
                  <div className="dist-bar" style={{ height: `${(e.c / max) * 100}%` }} />
                  <span className="dist-v">{e.v}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
