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

export function CostBadge({
  card,
  size,
  className,
}: {
  card: Card;
  size?: 'sm' | 'lg';
  className?: string;
}): ReactNode {
  const inkA = INK_COLORS[card.inks[0]!];
  const style =
    card.isDualInk && card.inks.length === 2
      ? {
          background: `linear-gradient(135deg, ${inkA} 0 50%, ${INK_COLORS[card.inks[1]!]} 50% 100%)`,
        }
      : { background: inkA };
  const sizeCls =
    size === 'sm'
      ? 'size-[22px]'
      : size === 'lg'
        ? 'size-[30px]'
        : 'size-[26px]';
  const innerCls =
    size === 'sm' ? 'text-xs' : size === 'lg' ? 'text-sm' : 'text-[13px]';
  return (
    <span
      className={`inline-grid place-items-center rounded-full p-0.5 flex-none ${sizeCls} ${className ?? ''}`}
      style={style}
      title={card.inks.join(' / ')}
    >
      <span
        className={`bg-kelp-deep rounded-full size-full grid place-items-center font-bold text-parchment ${innerCls}`}
      >
        {card.cost}
      </span>
    </span>
  );
}

export function InkDots({
  inks,
  inline,
}: {
  inks: Ink[];
  inline?: boolean;
}): ReactNode {
  const cls = inline
    ? 'static inline-flex gap-[3px]'
    : 'absolute top-3.5 right-3.5 z-[2] flex gap-[3px]';
  if (inks.length === 0)
    return (
      <span className={cls} title="no ink">
        ⌀
      </span>
    );
  return (
    <span className={cls}>
      {inks.map((ink) => (
        <span
          key={ink}
          className="size-3 rounded-full border border-black/50 inline-block"
          style={{ background: INK_COLORS[ink] }}
          title={ink}
        />
      ))}
    </span>
  );
}

/** columns per cost with the count printed inside each segment */
export function CurveChart({ buckets }: { buckets: CostBucket[] }): ReactNode {
  const max = Math.max(1, ...buckets.map((b) => b.inkable + b.notInkable));
  return (
    <div className="flex gap-2 items-stretch min-h-[190px]">
      {buckets.map((b) => (
        <div key={b.cost} className="flex flex-col items-center gap-1 flex-1">
          <span className="text-xs text-parchment-muted">
            {b.inkable + b.notInkable}
          </span>
          <div className="flex flex-col-reverse flex-1 w-[38px] rounded-md overflow-hidden bg-panel-2">
            <div
              className="grid place-items-center text-[13px] font-semibold bg-parchment-muted text-kelp"
              style={{ height: `${(b.notInkable / max) * 100}%` }}
            >
              {b.notInkable > 0 && <span>{b.notInkable}</span>}
            </div>
            <div
              className="grid place-items-center text-[13px] font-semibold bg-gold text-kelp"
              style={{ height: `${(b.inkable / max) * 100}%` }}
            >
              {b.inkable > 0 && <span>{b.inkable}</span>}
            </div>
          </div>
          <span className="text-xs text-parchment-muted">{b.cost}</span>
        </div>
      ))}
      <div className="flex flex-col justify-end gap-1 text-xs text-parchment-muted">
        <span>
          <i className="inline-block w-2.5 h-2.5 rounded-[3px] mr-1 align-[-1px] bg-gold" />{' '}
          inkable
        </span>
        <span>
          <i className="inline-block w-2.5 h-2.5 rounded-[3px] mr-1 align-[-1px] bg-parchment-muted" />{' '}
          not inkable
        </span>
      </div>
    </div>
  );
}

/** heatmap: rows = inks (+ dual combos), columns = costs, cells = copy counts */
export function InkMatrix({
  rows,
  maxCost,
}: {
  rows: CostInkRow[];
  maxCost: number;
}): ReactNode {
  const costs = Array.from({ length: Math.max(maxCost, 1) }, (_, i) => i + 1);
  const maxCount = Math.max(1, ...rows.flatMap((r) => Object.values(r.cells)));
  const rowColor = (row: CostInkRow): string =>
    row.inks.length === 2
      ? `linear-gradient(135deg, ${INK_COLORS[row.inks[0]!]} 0 50%, ${INK_COLORS[row.inks[1]!]} 50% 100%)`
      : INK_COLORS[row.inks[0]!];
  return (
    <div className="grid gap-[3px]">
      <div
        className="grid gap-[3px] items-stretch"
        style={{ gridTemplateColumns: `110px repeat(${costs.length}, 1fr)` }}
      >
        <span />
        {costs.map((c) => (
          <span key={c} className="text-center text-xs text-parchment-muted">
            {c}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          className="grid gap-[3px] items-stretch"
          style={{ gridTemplateColumns: `110px repeat(${costs.length}, 1fr)` }}
        >
          <span
            className="text-xs text-parchment-muted self-center whitespace-nowrap overflow-hidden text-ellipsis"
            title={row.label}
          >
            {row.label}
          </span>
          {costs.map((cost) => {
            const count = row.cells[cost] ?? 0;
            return (
              <span
                key={cost}
                className="relative h-[26px] rounded-[5px] bg-panel-2 grid place-items-center text-xs font-semibold"
                title={
                  count > 0
                    ? `${row.label} · cost ${cost}: ${count}`
                    : undefined
                }
              >
                {count > 0 && (
                  <span
                    className="absolute inset-0 rounded-[5px]"
                    style={{
                      background: rowColor(row),
                      opacity: 0.3 + 0.55 * (count / maxCount),
                    }}
                  />
                )}
                {count > 0 && <span className="relative">{count}</span>}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** three mini column charts: character strength / willpower / lore spread */
export function StatDistributions({
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
        const max = Math.max(1, ...entries.map((e) => e.c));
        return (
          <div key={key}>
            <h5 className="m-0 mb-1.5 text-xs uppercase text-parchment-muted">
              {key}
            </h5>
            <div className="flex gap-1.5 items-end h-[100px]">
              {entries.map((e) => (
                <div
                  key={e.v}
                  className="flex flex-col items-center justify-end gap-[3px] flex-1 h-full"
                  title={`${key} ${e.v}: ${e.c} copies`}
                >
                  <div
                    className="w-full bg-gold rounded-t-[4px] min-h-[2px]"
                    style={{ height: `${(e.c / max) * 100}%` }}
                  />
                  <span className="text-[11px] text-parchment-muted">
                    {e.v}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
