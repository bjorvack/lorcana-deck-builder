import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApp } from '../state';
import { generateDeck } from '../generate/generator';
import { loadMetaModel, type MetaModel } from '../meta/infer';
import { INK_COLORS } from './components';
import type { Ink } from '../data/types';

const ALL_INKS: Ink[] = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
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
    <div className="multiselect">
      <button type="button" className="btn multiselect-toggle" onClick={() => onOpenChange(!open)}>
        {label}{selected.length > 0 ? ` (${selected.length})` : ''}
        <span className="muted">{open ? ' ▲' : ' ▼'}</span>
      </button>
      {selected.length > 0 && (
        <button type="button" className="btn btn-mini" onClick={onClear}>clear</button>
      )}
      {open && (
        <div className="multiselect-list">
          {options.map((opt) => (
            <label key={opt.value} className="multiselect-option">
              <input
                type="checkbox"
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

export function GeneratorView({ onGenerated }: { onGenerated: () => void }): ReactNode {
  const { cards, sets, deck, replaceDeck } = useApp();
  const [inks, setInks] = useState<Ink[]>([]);
  const [format, setFormat] = useState<'core' | 'infinity'>('core');
  const [franchises, setFranchises] = useState<string[]>([]);
  const [setCodes, setSetCodes] = useState<string[]>([]);
  const [usePartial, setUsePartial] = useState(false);
  const [novelty, setNovelty] = useState(DEFAULT_NOVELTY);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [polish, setPolish] = useState(false);
  const [metaModel, setMetaModel] = useState<MetaModel | null>(null);
  const [result, setResult] = useState<{ error?: string; notes: string[] }>();
  const [openPanel, setOpenPanel] = useState<'franchises' | 'sets' | null>(null);

  useEffect(() => {
    let alive = true;
    loadMetaModel().then((m) => {
      if (alive) setMetaModel(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  const franchiseOptions = useMemo(
    () => [...new Set(cards.map((c) => c.franchise))].filter(Boolean).sort()
      .map((f) => ({ value: f, text: f })),
    [cards]
  );
  const setOptions = useMemo(
    () => [...new Map(sets.map((s) => [s.code, s])).values()]
      .sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code))
      .map((s) => ({ value: s.code, text: `${s.code} · ${s.name}` })),
    [sets]
  );

  const toggleInk = (ink: Ink): void => {
    setInks((cur) => (cur.includes(ink) ? cur.filter((i) => i !== ink) : [...cur, ink].slice(-2)));
  };
  const toggleFrom = (list: string[], setList: (v: string[]) => void, value: string): void => {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
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
      polish,
    });
    if (result.deck) {
      replaceDeck({ ...result.deck, title: usePartial ? deck.title : `${noveltyLabel(novelty)} ${inks.join('/')} deck` });
      onGenerated();
    }
    setResult({
      error: result.error,
      notes: [...result.notes.relaxations, ...result.notes.notes],
    });
  };

  return (
    <div className="generator">
      <section className="panel">
        <h3>Deck generator</h3>
        <div className="formrow">
          <span className="formlabel">Inks (1–2)</span>
          <div className="inkpicker">
            {ALL_INKS.map((ink) => (
              <button
                key={ink}
                className={`inkchip ${inks.includes(ink) ? 'active' : ''}`}
                style={{ borderColor: inks.includes(ink) ? INK_COLORS[ink] : undefined }}
                onClick={() => toggleInk(ink)}
              >
                {ink}
              </button>
            ))}
          </div>
        </div>
        <div className="formrow">
          <span className="formlabel">Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as 'core' | 'infinity')}>
            <option value="core">Core Constructed</option>
            <option value="infinity">Infinity</option>
          </select>
        </div>
        <div className="formrow">
          <span className="formlabel">Franchises (optional)</span>
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
        <div className="formrow">
          <span className="formlabel">Sets (optional)</span>
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
        <div className="formrow">
          <span className="formlabel">Meta ↔ Novel</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={novelty}
            onChange={(e) => setNovelty(Number(e.target.value))}
            aria-label="Novelty slider"
          />
          <span className="muted">{noveltyLabel(novelty)}</span>
        </div>
        <div className="formrow">
          <span className="formlabel">Seed</span>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            aria-label="Generation seed"
          />
          <button type="button" className="btn btn-mini" onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}>
            New seed
          </button>
        </div>
        <div className="formrow">
          <label className="formlabel">
            <input type="checkbox" checked={polish} onChange={(e) => setPolish(e.target.checked)} />{' '}
            Goldfish polish (slow — hill-climbs swaps against the lore race)
          </label>
        </div>
        <div className="formrow">
          <label className="formlabel">
            <input type="checkbox" checked={usePartial} onChange={(e) => setUsePartial(e.target.checked)} />{' '}
            Complete my current deck ({Object.values(deck.cards).reduce((s, c) => s + c, 0)} cards) instead of starting fresh
          </label>
        </div>
        <button className="btn btn-primary" onClick={run} disabled={inks.length === 0}>
          Generate 60-card deck
        </button>
        {result?.error && <p className="error">{result.error}</p>}
        {result?.notes.map((n, i) => (
          <p key={i} className="note">{n}</p>
        ))}
        {result && !result.error && <p className="ok">Generated — see the Deck tab.</p>}
      </section>
    </div>
  );
}
