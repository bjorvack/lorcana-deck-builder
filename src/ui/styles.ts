/**
 * Shared utility-class patterns for recurring app chrome (panels, buttons,
 * chips, status text), defined against the brand tokens in src/theme.css.
 * Views extend or override them with their own utilities; view-specific
 * styling stays in the view's own file.
 */
export const panelCls = 'bg-panel border border-line rounded-[10px] p-3 mb-3';

/** h3 inside a panel — the legacy `.panel h3` treatment (explicit per h3 to
 *  keep specificity local; StatsGrid's h3s use mt-0 instead of mt-0.5) */
export const panelHeadingCls =
  'mt-0.5 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted';

export const btnCls =
  'bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-3 cursor-pointer text-sm hover:border-gold';
export const btnMiniCls =
  'bg-panel-2 text-parchment border border-line rounded-lg py-0.5 px-2 cursor-pointer text-xs hover:border-gold';
export const btnPrimaryCls =
  'bg-gold text-kelp font-semibold border border-gold rounded-lg py-[7px] px-3 cursor-pointer text-sm';
export const chipCls =
  'bg-panel-2 border border-line rounded-xl py-0.5 px-2.5 text-xs text-parchment-muted';
export const mutedCls = 'text-parchment-muted';
export const noteCls = 'text-warn text-[13px]';
