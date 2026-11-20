import type { ReactNode } from 'react';
import type { Card, Ink } from '../data/types';
import type { CostInkRow } from '../stats/stats';

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
        style={{
          gridTemplateColumns: `minmax(56px,110px) repeat(${costs.length}, minmax(14px,1fr))`,
        }}
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
          style={{
            gridTemplateColumns: `minmax(56px,110px) repeat(${costs.length}, minmax(14px,1fr))`,
          }}
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
