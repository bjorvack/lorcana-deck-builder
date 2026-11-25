import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { Ink } from '../data/types';
import { INKS } from '../data/types';
import { franchiseUniqueCounts, generateDeck } from '../generate/generator';
import {
  type GeneratorModelArtifact,
  loadLearnedModelForSite,
} from '../generate/learned-fill';
import { useApp } from '../state';
import { INK_COLORS } from './components';
import { btnCls, btnMiniCls, panelCls, panelHeadingCls } from './styles';
import { useMetaModel } from './useMetaModel';

/** slider default: the middle position (D4) */
const DEFAULT_NOVELTY = 0.5;

function MultiSelectPanel({
  label,
  options,
  selected,
  onToggle,
  onClear,
  open,
  onOpenChange,
}: {
  label: string;
  options: { value: string; text: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactNode {
  return (
    <div className="relative flex gap-1.5 items-center">
      <button
        type="button"
        className={`${btnCls} min-w-[180px] text-left`}
        onClick={() => onOpenChange(!open)}
      >
        {label}
        {selected.length > 0 ? ` (${selected.length})` : ''}
        <span className="text-parchment-muted">{open ? ' ▲' : ' ▼'}</span>
      </button>
      {selected.length > 0 && (
        <button type="button" className={btnMiniCls} onClick={onClear}>
          clear
        </button>
      )}
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 z-20 w-80 max-h-60 overflow-auto bg-panel-2 border border-line rounded-lg p-1.5 grid grid-cols-2 gap-0.5">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-1.5 text-[13px] py-[3px] px-1.5 rounded-md cursor-pointer text-parchment hover:bg-white/[0.05]"
            >
              <input
                type="checkbox"
                className="accent-gold"
                checked={selected.includes(opt.value)}
                onChange={() => onToggle(opt.value)}
              />
              {opt.text}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const noveltyLabel = (novelty: number): string =>
  novelty < 0.3 ? 'Meta' : novelty > 0.7 ? 'Novel' : 'Balanced';

const formRowCls = 'flex items-center gap-3 my-3 flex-wrap';
const formLabelCls = 'min-w-[170px] text-parchment-muted text-sm';
const selectCls =
  'max-w-full bg-panel-2 text-parchment border border-line rounded-lg py-[7px] px-[9px] text-sm leading-[normal]';
const inkChipCls =
  'bg-transparent border-2 border-line rounded-[14px] px-2.5 py-[3px] text-xs leading-[normal] cursor-pointer';

export function GeneratorView({
  onGenerated,
}: {
  onGenerated: () => void;
}): ReactNode {
  const { cards, sets, deck, replaceDeck } = useApp();
  const [inks, setInks] = useState<Ink[]>([]);
  const [format, setFormat] = useState<'core' | 'infinity'>('core');
  const [franchises, setFranchises] = useState<string[]>([]);
  const [setCodes, setSetCodes] = useState<string[]>([]);
  const [usePartial, setUsePartial] = useState(false);
  const [novelty, setNovelty] = useState(DEFAULT_NOVELTY);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  // live trial (user decision 2026-11-23): always load the artifact and
  // bypass its A/B gate flag locally — see loadLearnedModelForSite
  const [learnedModel, setLearnedModel] = useState<
    GeneratorModelArtifact | null | undefined
  >(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadLearnedModelForSite().then((m) => {
      if (!cancelled) setLearnedModel(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const metaModel = useMetaModel();
  const [result, setResult] = useState<{ error?: string; notes: string[] }>();
  const [openPanel, setOpenPanel] = useState<'franchises' | 'sets' | null>(
    null,
  );

  const franchiseCounts = useMemo(
    () => franchiseUniqueCounts(cards, format, inks),
    [cards, format, inks],
  );
  const franchiseOptions = useMemo(
    () =>
      [...new Set(cards.map((c) => c.franchise))]
        .filter(Boolean)
        .sort()
        .map((f) => ({
          value: f,
          text: `${f} (${franchiseCounts.get(f) ?? 0})`,
        })),
    [cards, franchiseCounts],
  );
  const setOptions = useMemo(
    () =>
      [...new Map(sets.map((s) => [s.code, s])).values()]
        .sort(
          (a, b) =>
            Number(a.code) - Number(b.code) || a.code.localeCompare(b.code),
        )
        .map((s) => ({ value: s.code, text: `${s.code} · ${s.name}` })),
    [sets],
  );

  const toggleInk = (ink: Ink): void => {
    setInks((cur) =>
      cur.includes(ink)
        ? cur.filter((i) => i !== ink)
        : [...cur, ink].slice(-2),
    );
  };
  const toggleFrom = (
    list: string[],
    setList: (v: string[]) => void,
    value: string,
  ): void => {
    setList(
      list.includes(value) ? list.filter((v) => v !== value) : [...list, value],
    );
  };

  const run = (): void => {
    const result = generateDeck({
      cards,
      inks,
      format,
      franchises: franchises.length > 0 ? franchises : undefined,
      sets: setCodes.length > 0 ? setCodes : undefined,
      partial: usePartial ? deck.cards : undefined,
      novelty,
      seed,
      model: metaModel,
      learnedModel,
    });
    if (result.deck) {
      const inkLabel =
        result.deck.inks.length > 0 ? result.deck.inks.join('/') : 'Auto';
      replaceDeck({
        ...result.deck,
        title: usePartial
          ? deck.title
          : `${noveltyLabel(novelty)} ${inkLabel} deck`,
      });
      onGenerated();
    }
    setResult({
      error: result.error,
      notes: [...result.notes.relaxations, ...result.notes.notes],
    });
  };

  return (
    <div className="max-w-[720px]">
      <section className={panelCls}>
        <h3 className={panelHeadingCls}>Deck generator</h3>
        <div className={formRowCls}>
          <span className={formLabelCls}>Inks (0–2)</span>
          <div className="flex flex-wrap gap-1">
            {INKS.map((ink) => (
              <button
                type="button"
                key={ink}
                className={`${inkChipCls} ${inks.includes(ink) ? 'text-parchment bg-white/[0.06]' : 'text-parchment-muted'}`}
                aria-pressed={inks.includes(ink)}
                style={{
                  borderColor: inks.includes(ink) ? INK_COLORS[ink] : undefined,
                }}
                onClick={() => toggleInk(ink)}
              >
                {ink}
              </button>
            ))}
          </div>
        </div>
        <div className={formRowCls}>
          <span className="text-parchment-muted" data-testid="ink-mode-hint">
            {inks.length === 0
              ? 'Auto — inks emerge from your cards.'
              : inks.length === 1
                ? `Constrained to ${inks[0]} + one more ink (or leave Auto).`
                : `Constrained to ${inks.join('/')}.`}
          </span>
        </div>
        <div className={formRowCls}>
          <span className={formLabelCls}>Format</span>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as 'core' | 'infinity')}
            className={selectCls}
          >
            <option value="core">Core Constructed</option>
            <option value="infinity">Infinity</option>
          </select>
        </div>
        <div className={formRowCls}>
          <span className={formLabelCls}>Franchises (optional)</span>
          <MultiSelectPanel
            label="Franchises"
            options={franchiseOptions}
            selected={franchises}
            onToggle={(v) => toggleFrom(franchises, setFranchises, v)}
            onClear={() => setFranchises([])}
            open={openPanel === 'franchises'}
            onOpenChange={(open) => setOpenPanel(open ? 'franchises' : null)}
          />
        </div>
        <div className={formRowCls}>
          <span className={formLabelCls}>Sets (optional)</span>
          <MultiSelectPanel
            label="Sets"
            options={setOptions}
            selected={setCodes}
            onToggle={(v) => toggleFrom(setCodes, setSetCodes, v)}
            onClear={() => setSetCodes([])}
            open={openPanel === 'sets'}
            onOpenChange={(open) => setOpenPanel(open ? 'sets' : null)}
          />
        </div>
        <div className={formRowCls}>
          <span className={formLabelCls}>Meta ↔ Novel</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={novelty}
            onChange={(e) => setNovelty(Number(e.target.value))}
            aria-label="Novelty slider"
          />
          <span className="text-parchment-muted">{noveltyLabel(novelty)}</span>
        </div>
        <div className={formRowCls}>
          <span className={formLabelCls}>Seed</span>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            aria-label="Generation seed"
          />
          <button
            type="button"
            className={btnMiniCls}
            onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
          >
            New seed
          </button>
        </div>
        <div className={formRowCls}>
          <label className={formLabelCls}>
            <input
              type="checkbox"
              className="accent-gold"
              checked={usePartial}
              onChange={(e) => setUsePartial(e.target.checked)}
            />{' '}
            Complete my current deck (
            {Object.values(deck.cards).reduce((s, c) => s + c, 0)} cards)
            instead of starting fresh
          </label>
        </div>
        <button
          type="button"
          className="bg-gold text-kelp font-semibold border border-gold rounded-lg py-[7px] px-3 cursor-pointer text-sm"
          onClick={run}
        >
          {inks.length === 0
            ? 'Generate 60-card deck (auto inks)'
            : 'Generate 60-card deck'}
        </button>
        {result?.error && <p className="text-error">{result.error}</p>}
        {result?.notes.map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: notes have no stable identity and the list re-renders fully each time
          <p key={i} className="text-warn text-[13px]">
            {n}
          </p>
        ))}
        {/* no success note here: a successful run switches to the Deck tab
            via onGenerated in the same batch, so it would never paint */}
      </section>
    </div>
  );
}
