/**
 * Brand chart theme — the single source of chart styling. Every primitive
 * draws with these values; ink-specific series keep the game-data ink colors
 * from INK_COLORS (src/ui/charts.tsx).
 */
export const chartTheme = {
  /** the player's deck series (Illuminary Gold) */
  deck: '#d3ba84',
  /** baseline / opponent series (Steel ink as the neutral) */
  opponent: '#8d99a6',
  /** secondary or alternate opponent series (Lorcana Indigo) */
  opponentAlt: '#373b70',
  /** kelp-derived grid lines */
  grid: '#3b3b34',
  /** axis and legend text (parchment muted) */
  textMuted: '#a7957d',
  /** primary chart text (parchment) */
  text: '#e3caa8',
  /** tooltip surface (panel-2 with a line border) */
  tooltip: {
    background: '#2d2d29',
    border: '1px solid #3b3b34',
    borderRadius: 8,
    color: '#e3caa8',
    fontSize: 12,
  },
  /** segment separators (kelp-deep) */
  segmentStroke: '#121210',
  tick: { fill: '#a7957d', fontSize: 11 },
  polarTick: { fill: '#a7957d', fontSize: 12 },
  legend: { color: '#a7957d', fontSize: 12 },
} as const;
