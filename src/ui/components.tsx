import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../data/types';
import { isNewerPrint } from '../shared/canonical';
import { useApp } from '../state';
import { CostBadge, InkDots } from './charts';

export { CostBadge, INK_COLORS, InkDots } from './charts';

export function CardTile({
  card,
  onOpen,
  formats,
}: {
  card: Card;
  onOpen: (card: Card) => void;
  formats?: { core: boolean; infinity: boolean };
}): ReactNode {
  // walk the image candidates on each failure; placeholder when all fail
  const candidates = [card.images.thumb, card.images.alt].filter(
    (s): s is string => Boolean(s),
  );
  const [failedCount, setFailedCount] = useState(0);
  const src = candidates[failedCount];
  return (
    <button
      type="button"
      className="relative flex flex-col gap-1 bg-panel border border-line rounded-[10px] p-2 cursor-pointer text-parchment text-left overflow-hidden hover:border-gold"
      onClick={() => onOpen(card)}
      title={card.fullName}
    >
      <CostBadge
        card={card}
        size="lg"
        className="absolute top-3 left-3 z-[2]"
      />
      <InkDots inks={card.inks} />
      {src ? (
        <img
          src={src}
          alt={card.fullName}
          loading="lazy"
          className="w-full aspect-[5/7] object-contain rounded-md bg-kelp-deep"
          onError={() => setFailedCount((n) => n + 1)}
        />
      ) : (
        <span className="aspect-[5/7] grid place-items-center text-xs text-parchment-muted bg-kelp-deep rounded-md text-center p-2">
          {card.fullName}
        </span>
      )}
      <span className="text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
        {card.fullName}
      </span>
      <span className="text-[11px] text-parchment-muted">
        {card.setType === 'quest'
          ? `${card.setCode} · ${card.rarity}`
          : `Set ${card.setCode} · ${card.rarity}`}
        {card.isDualInk ? ' · dual' : ''}
        {(() => {
          const supported = formats ?? card.formats;
          const parts = [
            supported.core ? 'Core' : null,
            supported.infinity ? 'Infinity' : null,
          ].filter((s): s is string => Boolean(s));
          return parts.length > 0 ? ` · ${parts.join(' · ')}` : null;
        })()}
      </span>
    </button>
  );
}

export function CardModal({
  card,
  onClose,
}: {
  card: Card;
  onClose: () => void;
}): ReactNode {
  const { addCard, removeCard, setCount, swapCardVersion, deck, cards, byId } =
    useApp();
  const [activeVersion, setActiveVersion] = useState(card);
  const [note, setNote] = useState<string>();
  const img =
    activeVersion.images.full ??
    activeVersion.images.alt ??
    activeVersion.images.thumb;
  const modalRef = useRef<HTMLDivElement>(null);

  const versions = useMemo(
    () =>
      cards
        .filter((c) => c.groupKey === card.groupKey)
        .sort((a, b) => (isNewerPrint(a, b) ? -1 : isNewerPrint(b, a) ? 1 : 0)),
    [cards, card.groupKey],
  );
  const countInDeck = deck.cards[activeVersion.id] ?? 0;
  const otherVersionInDeck = versions.find(
    (v) => v.id !== activeVersion.id && (deck.cards[v.id] ?? 0) > 0,
  );

  useEffect(() => {
    setActiveVersion(card);
    setNote(undefined);
  }, [card]);

  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleResult = (result: { status: string; reason?: string }): void => {
    setNote(
      result.status === 'refused'
        ? result.reason
        : result.status === 'unknown'
          ? 'Card not found'
          : undefined,
    );
  };

  const labelFor = (c: Card) =>
    `Set ${c.setCode}${c.collectorNumber ? ` · ${c.collectorNumber}` : ''}${c.version ? ` · ${c.version}` : ''}`;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only click-outside-to-close; keyboard users have the Close button and Escape */}
      <div
        className="fixed inset-0 bg-black/[0.67] z-50 grid place-items-center p-4 max-[720px]:p-3"
        role="presentation"
        onClick={onClose}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: not focusable by design, focus stays inside the modal */}
        <div
          className="relative grid grid-cols-[minmax(220px,340px)_minmax(0,1fr)] gap-4 max-[720px]:grid-cols-1 max-[720px]:grid-rows-[auto_minmax(0,1fr)] max-[720px]:gap-3 bg-panel border border-line rounded-xl p-4 max-[720px]:p-3 w-full max-w-[820px] max-h-[90vh] overflow-hidden"
          role="dialog"
          aria-modal="true"
          aria-label={activeVersion.fullName}
          tabIndex={-1}
          ref={modalRef}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label="Close card details"
            className="absolute top-2 right-2 z-10 grid size-8 place-items-center rounded-full bg-panel-2/95 border border-line text-parchment cursor-pointer hover:border-gold"
            onClick={onClose}
          >
            ✕
          </button>
          {img ? (
            <img
              src={img}
              alt={activeVersion.fullName}
              className="w-full self-start rounded-lg object-contain max-h-[calc(90vh-2rem)] max-[720px]:max-h-[38vh]"
            />
          ) : (
            <div className="w-[260px] min-h-[360px] bg-kelp-deep rounded-lg max-[720px]:w-full max-[720px]:min-h-0 max-[720px]:h-[38vh]" />
          )}
          <div className="min-h-0 overflow-y-auto pr-9 max-[720px]:pr-1">
            <h2 className="m-0 mb-1.5">{activeVersion.fullName}</h2>
            <p className="text-parchment-muted text-[13px] my-1">
              <InkDots inks={activeVersion.inks} />{' '}
              {activeVersion.isDualInk ? 'dual-ink · ' : ''}
              {activeVersion.type}
              {activeVersion.subtypes.length > 0
                ? ` · ${activeVersion.subtypes.join(' · ')}`
                : ''}{' '}
              · {activeVersion.rarity}
            </p>
            <p className="text-parchment-muted text-[13px] my-1">
              {activeVersion.setName} ({activeVersion.setCode}) ·{' '}
              {activeVersion.collectorNumber ?? ''} · {activeVersion.franchise}
            </p>
            <p className="my-1.5">
              {activeVersion.type === 'Character' && (
                <>
                  Strength {activeVersion.strength} · Willpower{' '}
                  {activeVersion.willpower} · Lore {activeVersion.lore}
                </>
              )}
              {activeVersion.type === 'Location' && (
                <>
                  Lore {activeVersion.lore} · Move cost {activeVersion.moveCost}
                </>
              )}
            </p>
            <pre className="whitespace-pre-wrap bg-panel-2 rounded-lg p-2.5 text-[13px] border border-line">
              {activeVersion.text || '—'}
            </pre>
            {activeVersion.keywords.length > 0 && (
              <p className="text-parchment-muted text-[13px] my-1">
                Keywords: {activeVersion.keywords.join(', ')}
              </p>
            )}
            {activeVersion.tags.length > 0 && (
              <p className="flex flex-wrap gap-1.5">
                {activeVersion.tags.map((t) => (
                  <span
                    key={t.tag}
                    className="bg-panel-2 border border-line rounded-xl py-0.5 px-2.5 text-xs text-parchment-muted"
                  >
                    {t.tag}
                  </span>
                ))}
              </p>
            )}
            <p className="text-parchment-muted text-[13px] my-1">
              Inkable: {activeVersion.inkwell ? 'yes' : 'no'} · Deck copies:{' '}
              {activeVersion.maxCopies === 'unlimited'
                ? 'unlimited'
                : activeVersion.maxCopies}{' '}
              · Core: {activeVersion.formats.core ? 'legal' : 'not legal'}
            </p>
            {activeVersion.prices &&
              (activeVersion.prices.usd || activeVersion.prices.usdFoil) && (
                <p className="text-parchment-muted text-[13px] my-1">
                  TCGplayer:{' '}
                  {activeVersion.prices.usd
                    ? `$${activeVersion.prices.usd}`
                    : '—'}{' '}
                  · foil{' '}
                  {activeVersion.prices.usdFoil
                    ? `$${activeVersion.prices.usdFoil}`
                    : '—'}
                </p>
              )}

            {versions.length > 1 && (
              <label className="block mt-3">
                <span className="text-parchment-muted text-[13px]">
                  Version
                </span>
                <select
                  className="block w-full mt-1 bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-2 text-sm"
                  value={activeVersion.id}
                  onChange={(e) => {
                    const next = byId.get(Number(e.target.value));
                    if (next) setActiveVersion(next);
                  }}
                >
                  {versions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {labelFor(c)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="flex flex-wrap gap-2.5 items-center mt-3">
              {countInDeck === 0 ? (
                <button
                  type="button"
                  className="bg-gold text-kelp font-semibold border border-gold rounded-lg py-[7px] px-3 cursor-pointer text-sm"
                  onClick={() => handleResult(addCard(activeVersion.id))}
                >
                  Add to deck
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="bg-panel-2 text-parchment border border-line rounded-lg py-0.5 px-2.5 cursor-pointer text-lg leading-none hover:border-gold"
                    aria-label="Remove one copy"
                    onClick={() => setCount(activeVersion.id, countInDeck - 1)}
                  >
                    −
                  </button>
                  <span className="text-sm min-w-[1.5em] text-center">
                    {countInDeck}
                  </span>
                  <button
                    type="button"
                    className="bg-panel-2 text-parchment border border-line rounded-lg py-0.5 px-2.5 cursor-pointer text-lg leading-none hover:border-gold"
                    aria-label="Add one copy"
                    onClick={() => handleResult(addCard(activeVersion.id))}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-3 cursor-pointer text-sm hover:border-gold"
                    onClick={() => removeCard(activeVersion.id)}
                  >
                    Remove all
                  </button>
                </>
              )}
              {otherVersionInDeck && (
                <button
                  type="button"
                  className="bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-3 cursor-pointer text-sm hover:border-gold"
                  onClick={() =>
                    handleResult(
                      swapCardVersion(otherVersionInDeck.id, activeVersion.id),
                    )
                  }
                >
                  Use this version
                </button>
              )}
              {note && <span className="text-warn text-[13px]">{note}</span>}
              <button
                type="button"
                className="bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-3 cursor-pointer text-sm hover:border-gold"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function Bar({
  label,
  value,
  max,
  inkable,
  dual,
  total,
}: {
  label: string;
  value: number;
  max: number;
  inkable?: number;
  dual?: number;
  total?: number;
}): ReactNode {
  const width = max === 0 ? 0 : (value / max) * 100;
  const inkWidth =
    max === 0 || inkable === undefined ? 0 : (inkable / max) * 100;
  const dualWidth = max === 0 || dual === undefined ? 0 : (dual / max) * 100;
  const displayLabel = total !== undefined ? `${label} (${total})` : label;
  return (
    <div className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_minmax(0,34px)] gap-2 items-center my-[3px]">
      <span
        className="text-xs text-parchment-muted whitespace-nowrap overflow-hidden text-ellipsis"
        title={displayLabel}
      >
        {displayLabel}
      </span>
      <span className="relative h-3 bg-panel-2 rounded-md overflow-hidden">
        <span
          className="absolute left-0 top-0 bottom-0 bg-parchment-muted/50"
          style={{ width: `${width}%` }}
        />
        <span
          className="absolute left-0 top-0 bottom-0 bg-gold"
          style={{ width: `${inkWidth}%` }}
        />
        {dualWidth > 0 && (
          <span
            className="absolute left-0 top-0 bottom-0 bg-[repeating-linear-gradient(45deg,transparent_0_4px,color-mix(in_srgb,var(--color-kelp-deep)_80%,transparent)_4px_8px)]"
            style={{ width: `${dualWidth}%` }}
          />
        )}
      </span>
      <span className="text-xs text-right">{value}</span>
    </div>
  );
}

export function StatList({
  entries,
  title,
  duals,
  totals,
  footer,
}: {
  entries: [string, number][];
  title: string;
  duals?: Record<string, number>;
  totals?: Record<string, number>;
  footer?: string;
}): ReactNode {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="mb-3">
      <h4 className="mt-0.5 mb-2.5 text-sm uppercase tracking-[0.6px] text-parchment-muted">
        {title}
      </h4>
      {entries.length === 0 && <p className="text-parchment-muted">—</p>}
      {entries.map(([k, v]) => (
        <Bar
          key={k}
          label={k}
          value={v}
          max={max}
          dual={duals?.[k]}
          total={totals?.[k]}
        />
      ))}
      {footer && entries.length > 0 && (
        <p className="text-parchment-muted text-[11px] mt-1">{footer}</p>
      )}
    </div>
  );
}
