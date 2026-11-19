import { type ReactNode, useState } from 'react';
import type { Card } from '../data/types';
import { useApp } from '../state';
import { CostBadge, InkDots } from './charts';

export { CostBadge, INK_COLORS, InkDots } from './charts';

export function CardTile({
  card,
  onOpen,
}: {
  card: Card;
  onOpen: (card: Card) => void;
}): ReactNode {
  const [failed, setFailed] = useState(false);
  const src = failed ? card.images.alt : card.images.thumb;
  return (
    <button
      type="button"
      className="tile"
      onClick={() => onOpen(card)}
      title={card.fullName}
    >
      <CostBadge card={card} size="lg" className="tile-cost" />
      <InkDots inks={card.inks} />
      {src ? (
        <img
          src={src}
          alt={card.fullName}
          loading="lazy"
          onError={() =>
            src === card.images.alt
              ? setFailed(true)
              : setFailed(card.images.alt === undefined)
          }
        />
      ) : (
        <span className="tile-placeholder">{card.fullName}</span>
      )}
      <span className="tile-name">{card.fullName}</span>
      <span className="tile-sub">
        {card.setType === 'quest'
          ? `${card.setCode} · ${card.rarity}`
          : `Set ${card.setCode} · ${card.rarity}`}
        {card.isDualInk ? ' · dual' : ''}
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
  const { addCard } = useApp();
  const [note, setNote] = useState<string>();
  const img = card.images.full ?? card.images.alt ?? card.images.thumb;
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only click-outside-to-close; keyboard users have the Close button and Escape */}
      <div
        className="modal-backdrop"
        role="presentation"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: bubble guard, not an interactive control */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: not focusable by design, focus stays inside the modal */}
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {img ? (
            <img src={img} alt={card.fullName} />
          ) : (
            <div className="modal-noimg" />
          )}
          <div className="modal-info">
            <h2>{card.fullName}</h2>
            <p className="modal-sub">
              <InkDots inks={card.inks} /> {card.isDualInk ? 'dual-ink · ' : ''}
              {card.type}
              {card.subtypes.length > 0
                ? ` · ${card.subtypes.join(' · ')}`
                : ''}{' '}
              · {card.rarity}
            </p>
            <p className="modal-sub">
              {card.setName} ({card.setCode}) · {card.collectorNumber ?? ''} ·{' '}
              {card.franchise}
            </p>
            <p className="modal-stats">
              {card.type === 'Character' && (
                <>
                  Strength {card.strength} · Willpower {card.willpower} · Lore{' '}
                  {card.lore}
                </>
              )}
              {card.type === 'Location' && (
                <>
                  Lore {card.lore} · Move cost {card.moveCost}
                </>
              )}
            </p>
            <pre className="modal-text">{card.text || '—'}</pre>
            {card.keywords.length > 0 && (
              <p className="modal-sub">Keywords: {card.keywords.join(', ')}</p>
            )}
            {card.tags.length > 0 && (
              <p className="modal-tags">
                {card.tags.map((t) => (
                  <span key={t.tag} className="chip chip-tag">
                    {t.tag}
                  </span>
                ))}
              </p>
            )}
            <p className="modal-sub">
              Inkable: {card.inkwell ? 'yes' : 'no'} · Deck copies:{' '}
              {card.maxCopies === 'unlimited' ? 'unlimited' : card.maxCopies} ·
              Core: {card.formats.core ? 'legal' : 'not legal'}
            </p>
            {card.prices && (card.prices.usd || card.prices.usdFoil) && (
              <p className="modal-sub">
                TCGplayer: {card.prices.usd ? `$${card.prices.usd}` : '—'} ·
                foil {card.prices.usdFoil ? `$${card.prices.usdFoil}` : '—'}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const result = addCard(card.id);
                  setNote(
                    result.status === 'refused'
                      ? result.reason
                      : result.status === 'unknown'
                        ? 'Card not found'
                        : undefined,
                  );
                }}
              >
                Add to deck
              </button>
              {note && <span className="note">{note}</span>}
              <button type="button" className="btn" onClick={onClose}>
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
}: {
  label: string;
  value: number;
  max: number;
  inkable?: number;
  dual?: number;
}): ReactNode {
  const width = max === 0 ? 0 : (value / max) * 100;
  const inkWidth =
    max === 0 || inkable === undefined ? 0 : (inkable / max) * 100;
  const dualWidth = max === 0 || dual === undefined ? 0 : (dual / max) * 100;
  return (
    <div className="bar-row">
      <span className="bar-label" title={label}>
        {label}
      </span>
      <span className="bar-track">
        <span className="bar-fill bar-notink" style={{ width: `${width}%` }} />
        <span className="bar-fill bar-ink" style={{ width: `${inkWidth}%` }} />
        {dualWidth > 0 && (
          <span
            className="bar-fill bar-dual"
            style={{ width: `${dualWidth}%` }}
          />
        )}
      </span>
      <span className="bar-value">{value}</span>
    </div>
  );
}

export function StatList({
  entries,
  title,
  duals,
  footer,
}: {
  entries: [string, number][];
  title: string;
  duals?: Record<string, number>;
  footer?: string;
}): ReactNode {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="statblock">
      <h4>{title}</h4>
      {entries.length === 0 && <p className="muted">—</p>}
      {entries.map(([k, v]) => (
        <Bar key={k} label={k} value={v} max={max} dual={duals?.[k]} />
      ))}
      {footer && entries.length > 0 && (
        <p className="muted bar-footnote">{footer}</p>
      )}
    </div>
  );
}
