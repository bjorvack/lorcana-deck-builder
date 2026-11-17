import { useState, type ReactNode } from 'react';
import type { Card, Ink } from '../data/types';
import { useApp } from '../state';

export const INK_COLORS: Record<Ink, string> = {
  Amber: '#d9a520',
  Amethyst: '#8e4fd0',
  Emerald: '#1fa86a',
  Ruby: '#d0453c',
  Sapphire: '#3a6fd8',
  Steel: '#8d99a6',
};

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

export function CardTile({ card, onOpen }: { card: Card; onOpen: (card: Card) => void }): ReactNode {
  const [failed, setFailed] = useState(false);
  const src = failed ? card.images.alt : card.images.thumb;
  return (
    <button className="tile" onClick={() => onOpen(card)} title={card.fullName}>
      <span className="tile-cost" data-ink={card.inks[0] ?? 'none'}>{card.cost}</span>
      <InkDots inks={card.inks} />
      {src ? (
        <img
          src={src}
          alt={card.fullName}
          loading="lazy"
          onError={() => (src === card.images.alt ? setFailed(true) : setFailed(card.images.alt === undefined))}
        />
      ) : (
        <span className="tile-placeholder">{card.fullName}</span>
      )}
      <span className="tile-name">{card.fullName}</span>
      <span className="tile-sub">
        {card.setType === 'quest' ? `${card.setCode} · ${card.rarity}` : `Set ${card.setCode} · ${card.rarity}`}
        {card.isDualInk ? ' · dual' : ''}
      </span>
    </button>
  );
}

export function CardModal({ card, onClose }: { card: Card; onClose: () => void }): ReactNode {
  const { addCard } = useApp();
  const [note, setNote] = useState<string>();
  const img = card.images.full ?? card.images.alt ?? card.images.thumb;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {img ? <img src={img} alt={card.fullName} /> : <div className="modal-noimg" />}
        <div className="modal-info">
          <h2>{card.fullName}</h2>
          <p className="modal-sub">
            <InkDots inks={card.inks} /> {card.isDualInk ? 'dual-ink · ' : ''}
            {card.type}
            {card.subtypes.length > 0 ? ` · ${card.subtypes.join(' · ')}` : ''} · {card.rarity}
          </p>
          <p className="modal-sub">
            {card.setName} ({card.setCode}) · {card.collectorNumber ?? ''} · {card.franchise}
          </p>
          <p className="modal-stats">
            {card.type === 'Character' && <>Strength {card.strength} · Willpower {card.willpower} · Lore {card.lore}</>}
            {card.type === 'Location' && <>Lore {card.lore} · Move cost {card.moveCost}</>}
          </p>
          <pre className="modal-text">{card.text || '—'}</pre>
          {card.keywords.length > 0 && <p className="modal-sub">Keywords: {card.keywords.join(', ')}</p>}
          {card.tags.length > 0 && (
            <p className="modal-tags">
              {card.tags.map((t) => (
                <span key={t.tag} className="chip chip-tag">{t.tag}</span>
              ))}
            </p>
          )}
          <p className="modal-sub">
            Inkable: {card.inkwell ? 'yes' : 'no'} · Deck copies: {card.maxCopies === 'unlimited' ? 'unlimited' : card.maxCopies} · Core: {card.formats.core ? 'legal' : 'not legal'}
          </p>
          {card.prices && (card.prices.usd || card.prices.usdFoil) && (
            <p className="modal-sub">TCGplayer: {card.prices.usd ? `$${card.prices.usd}` : '—'} · foil {card.prices.usdFoil ? `$${card.prices.usdFoil}` : '—'}</p>
          )}
          <div className="modal-actions">
            <button
              className="btn btn-primary"
              onClick={() => {
                const result = addCard(card.id);
                setNote(result === 'limit' ? `Copy limit reached (${card.maxCopies})` : undefined);
              }}
            >
              Add to deck
            </button>
            {note && <span className="note">{note}</span>}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Bar({ label, value, max, inkable }: { label: string; value: number; max: number; inkable?: number }): ReactNode {
  const width = max === 0 ? 0 : (value / max) * 100;
  const inkWidth = max === 0 || inkable === undefined ? 0 : (inkable / max) * 100;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className="bar-fill bar-notink" style={{ width: `${width}%` }} />
        <span className="bar-fill bar-ink" style={{ width: `${inkWidth}%` }} />
      </span>
      <span className="bar-value">{value}</span>
    </div>
  );
}

export function StatList({ entries, title }: { entries: [string, number][]; title: string }): ReactNode {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return (
    <div className="statblock">
      <h4>{title}</h4>
      {entries.length === 0 && <p className="muted">—</p>}
      {entries.map(([k, v]) => (
        <Bar key={k} label={k} value={v} max={max} />
      ))}
    </div>
  );
}
