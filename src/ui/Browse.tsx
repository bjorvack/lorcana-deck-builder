import { type ReactNode, useMemo, useState } from 'react';
import type { Card } from '../data/types';
import { type MetaModel, suggestCards } from '../meta/infer';
import { useApp } from '../state';
import { CardModal, CardTile, INK_COLORS } from './components';
import { payoffHint, SuggestionRow, useRowRefusal } from './SuggestionRow';
import { btnCls, mutedCls } from './styles';
import { useMetaModel } from './useMetaModel';

const PAGE_SIZE = 60;

const selectCls =
  'bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-[9px] text-sm leading-[normal]';
const inkChipCls =
  'bg-transparent border-2 border-line rounded-[14px] px-2.5 py-[3px] text-xs leading-[normal] cursor-pointer';

interface Filters {
  franchise: string;
  inks: string[];
  setCode: string;
  type: string;
  cost: string;
  rarity: string;
  tag: string;
  query: string;
}

const EMPTY: Filters = {
  franchise: '',
  inks: [],
  setCode: '',
  type: '',
  cost: '',
  rarity: '',
  tag: '',
  query: '',
};

export function Browse(): ReactNode {
  const { cards, deck, addCard, byId } = useApp();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Card | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const activeFilterCount = [
    filters.franchise,
    filters.setCode,
    filters.type,
    filters.cost,
    filters.rarity,
    filters.tag,
  ].filter((v) => v !== '').length;
  const metaModel = useMetaModel();
  const { refusals, handleResult } = useRowRefusal();

  const options = useMemo(() => {
    const franchises = new Set<string>();
    const tags = new Set<string>();
    const rarities = new Set<string>();
    const setOptions = new Map<string, string>();
    for (const c of cards) {
      if (c.franchise) franchises.add(c.franchise);
      for (const t of c.tags) tags.add(t.tag);
      rarities.add(c.rarity);
      if (!setOptions.has(c.setCode)) setOptions.set(c.setCode, c.setName);
    }
    return {
      franchises: [...franchises].sort(),
      tags: [...tags].sort(),
      rarities: [...rarities].sort(),
      sets: [...setOptions.entries()].sort(
        (a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]),
      ),
    };
  }, [cards]);

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    return cards.filter((c) => {
      if (filters.franchise && c.franchise !== filters.franchise) return false;
      if (filters.setCode && c.setCode !== filters.setCode) return false;
      if (filters.type && c.type !== filters.type) return false;
      if (filters.cost && c.cost !== Number(filters.cost)) return false;
      if (filters.rarity && c.rarity !== filters.rarity) return false;
      if (filters.tag && !c.tags.some((t) => t.tag === filters.tag))
        return false;
      if (
        filters.inks.length > 0 &&
        !c.inks.some((ink) => filters.inks.includes(ink))
      )
        return false;
      if (
        q &&
        !c.fullName.toLowerCase().includes(q) &&
        !c.text.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [cards, filters]);

  const toggleInk = (ink: string): void => {
    setVisible(PAGE_SIZE);
    setFilters((f) => ({
      ...f,
      inks: f.inks.includes(ink)
        ? f.inks.filter((i) => i !== ink)
        : [...f.inks, ink],
    }));
  };

  const update = (patch: Partial<Filters>): void => {
    setVisible(PAGE_SIZE);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const suggestions = useMemo(() => {
    if (Object.keys(deck.cards).length === 0) return [];
    // text-only scoring when no artifact is available; payoff hints are
    // snapshot-derived and work regardless
    const model: MetaModel = metaModel ?? {
      version: '0',
      dataThroughDate: '0000-00-00',
      capabilities: { relations: false, calibration: false },
    };
    return suggestCards(deck, cards, model);
  }, [deck, cards, metaModel]);

  return (
    <div>
      {suggestions.length > 0 && (
        <section className="panel" data-testid="browse-suggestions">
          <button
            type="button"
            className={`${btnCls} min-w-[180px] text-left`}
            onClick={() => setShowSuggestions((v) => !v)}
            data-testid="browse-suggestions-toggle"
          >
            Suggested additions for your deck (
            {Object.values(deck.cards).reduce((s, c) => s + c, 0)} cards)
            <span className={mutedCls}>{showSuggestions ? ' ▲' : ' ▼'}</span>
          </button>
          {showSuggestions && (
            <div className="mt-3">
              {suggestions.slice(0, 5).map((s) => (
                <SuggestionRow
                  key={s.card.id}
                  card={s.card}
                  score={s.score}
                  basis={s.basis}
                  hint={payoffHint(s.card, deck, byId)}
                  refusal={refusals[s.card.id]}
                  onAdd={(cardId) => handleResult(cardId, addCard(cardId))}
                />
              ))}
            </div>
          )}
        </section>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-2.5">
        <input
          type="search"
          placeholder="Search name or text…"
          value={filters.query}
          onChange={(e) => update({ query: e.target.value })}
          className={`${selectCls} min-w-[220px] flex-1`}
        />
        <button
          type="button"
          className={`${btnCls} hidden max-[720px]:inline-block`}
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>
        <div
          className={`max-[720px]:flex-col max-[720px]:gap-2 ${showFilters ? 'max-[720px]:flex' : 'max-[720px]:hidden'}`}
        >
          <select
            value={filters.franchise}
            onChange={(e) => update({ franchise: e.target.value })}
            className={selectCls}
          >
            <option value="">All franchises</option>
            {options.franchises.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select
            value={filters.setCode}
            onChange={(e) => update({ setCode: e.target.value })}
            className={selectCls}
          >
            <option value="">All sets</option>
            {options.sets.map(([code, name]) => (
              <option key={code} value={code}>
                {code} · {name}
              </option>
            ))}
          </select>
          <select
            value={filters.type}
            onChange={(e) => update({ type: e.target.value })}
            className={selectCls}
          >
            <option value="">All types</option>
            {['Character', 'Action', 'Item', 'Location'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={filters.cost}
            onChange={(e) => update({ cost: e.target.value })}
            className={selectCls}
          >
            <option value="">Any cost</option>
            {[...new Set(cards.map((c) => c.cost))]
              .sort((a, b) => a - b)
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
          <select
            value={filters.rarity}
            onChange={(e) => update({ rarity: e.target.value })}
            className={selectCls}
          >
            <option value="">All rarities</option>
            {options.rarities.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            value={filters.tag}
            onChange={(e) => update({ tag: e.target.value })}
            className={selectCls}
          >
            <option value="">All tags</option>
            {options.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(INK_COLORS).map(([ink, color]) => (
            <button
              type="button"
              key={ink}
              className={`${inkChipCls} ${filters.inks.includes(ink) ? 'text-parchment bg-white/[0.06]' : 'text-parchment-muted'}`}
              aria-pressed={filters.inks.includes(ink)}
              style={{
                borderColor: filters.inks.includes(ink) ? color : undefined,
              }}
              onClick={() => toggleInk(ink)}
            >
              {ink}
            </button>
          ))}
        </div>
      </div>

      <p className="text-parchment-muted text-[13px] mt-1 mx-0.5 mb-2.5">
        {filtered.length} card{filtered.length === 1 ? '' : 's'}
      </p>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        {filtered.slice(0, visible).map((card) => (
          <CardTile key={card.id} card={card} onOpen={setSelected} />
        ))}
      </div>
      {visible < filtered.length && (
        <button
          type="button"
          className={`${btnCls} block my-3.5 mx-auto`}
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
        >
          Show {Math.min(PAGE_SIZE, filtered.length - visible)} more
        </button>
      )}
      {selected && (
        <CardModal card={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
