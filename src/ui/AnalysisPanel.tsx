import type { ReactNode } from 'react';
import type { Fingerprint } from '../stats/fingerprint';
import { AXIS_FORMULAS } from '../stats/fingerprint';
import { OPPONENT_PROFILES } from '../stats/profiles';
import type { Card, DeckState } from '../data/types';
import type { MetaModel } from '../meta/infer';
import { BASIS_FUSED, BASIS_TEXT, metaAdjustedViability, suggestCards } from '../meta/infer';
import { CostBadge, InkDots } from './charts';
import { cardPreviewHandlers } from './CardPreview';

const SIMPLIFICATIONS =
  'Estimates from seeded simulations with greedy policies and scripted opponent profiles — no interactive play. They compare pace and consistency, not real matchups.';

export interface MetaState {
  model: MetaModel | null;
  stale: boolean;
}

/** shared "no artifact" note — the same unavailable state for every meta surface */
function MetaUnavailableNote(): ReactNode {
  return (
    <p className="bar-footnote meta-state" data-testid="meta-unavailable">
      Meta model unavailable — deterministic metrics only. Train and ship <code>data/meta-model.json</code> to enable
      archetype matching, suggestions and the calibrated viability score.
    </p>
  );
}

/** viability profile + matchup bars for a valid deck (does not render otherwise) */
export function AnalysisPanel({ fingerprint, meta, deck, byId }: {
  fingerprint: Fingerprint | null;
  meta: MetaState;
  deck: DeckState;
  byId: Map<number, Card>;
}): ReactNode {
  if (!fingerprint) return null;
  const axes = Object.entries(fingerprint.axes) as [keyof typeof fingerprint.axes, number][];

  return (
    <section className="panel analysis" data-testid="analysis-panel">
      <h3>Deck analysis</h3>
      <div className="analysis-grid">
        <div className="analysis-block">
          <h4>Viability profile</h4>
          {axes.map(([axis, value]) => (
            <div key={axis} className="bar-row" title={`${AXIS_FORMULAS[axis]}. ${SIMPLIFICATIONS}`}>
              <span className="bar-label">{axis}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${value}%` }} />
              </span>
              <span className="bar-value">{value}</span>
            </div>
          ))}
        </div>

        <div className="analysis-block">
          <h4>Lore race vs baselines</h4>
          {fingerprint.matchups.map((m) => {
            const profile = OPPONENT_PROFILES.find((p) => p.id === m.profileId)!;
            return (
              <div
                key={m.profileId}
                className="bar-row"
                title={`${profile.description} Pace, challenge and removal simplified — ${SIMPLIFICATIONS.toLowerCase()}`}
              >
                <span className="bar-label">{profile.id}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${Math.round(m.winRate * 100)}%` }} />
                </span>
                <span className="bar-value">
                  {Math.round(m.winRate * 100)}% · {m.medianFinish ? `win t${m.medianFinish}` : 'no wins'}
                </span>
              </div>
            );
          })}
          <p className="bar-footnote">
            Opening hands keepable: {Math.round(fingerprint.openingHand.keepableRate * 100)}% · on curve through turn{' '}
            {Math.floor(fingerprint.curve.onCurveThrough)} · seed {fingerprint.curve.seed ?? 'fixed'} · {SIMPLIFICATIONS}
          </p>
        </div>
      </div>

      <MetaSection fingerprint={fingerprint} meta={meta} deck={deck} byId={byId} />
    </section>
  );
}

function MetaSection({ fingerprint, meta, deck, byId }: {
  fingerprint: Fingerprint;
  meta: MetaState;
  deck: DeckState;
  byId: Map<number, Card>;
}): ReactNode {
  if (!meta.model) {
    return <MetaUnavailableNote />;
  }
  const { model, stale } = meta;
  const viability = metaAdjustedViability(fingerprint, deck, byId, model, [...byId.values()]);
  return (
    <div className="meta-block" data-testid="meta-section">
      <h4>Meta fit</h4>
      {!model.capabilities.calibration && (
        <p className="meta-line" data-testid="meta-calibration-unavailable">
          Calibration gate not passed — archetype matching and the meta adjustment are unavailable.
        </p>
      )}
      {viability.match && (
        <p className="meta-line">
          Archetype match: <strong>{viability.match.archetype.name}</strong> (
          {Math.round(viability.match.similarity * 100)}% similar) · observed win rate{' '}
          {Math.round(viability.match.archetype.observedWinRate * 100)}% across{' '}
          {viability.match.archetype.sampleSize} tournament decks
        </p>
      )}
      <p className="meta-line" data-testid="meta-score">
        Viability <strong>{viability.total}</strong> = sim {viability.simStrength} · meta{' '}
        {viability.metaAlignment >= 0 ? `+${viability.metaAlignment}` : viability.metaAlignment}
        {stale && <span className="meta-stale"> · stale: data through {model.dataThroughDate}</span>}
      </p>
      <p className="bar-footnote">
        Sim strength: weighted fingerprint axes. Meta alignment: archetype-anchored until the trained calibrator
        ships. Data through {model.dataThroughDate}. Sources: Lorcanahunter · TopDeck.gg.
      </p>
    </div>
  );
}

/**
 * "Suggested additions" for the building phase (D5): top-8 fused-similarity
 * candidates with visible affinity basis and add-on-click. Rendered while the
 * deck is not yet a legal complete deck — additions only make sense while
 * building; a finished deck gets the full analysis panel instead. Hidden when
 * the artifact lacks relation embeddings; quiet empty state when the legal
 * candidate pool exhausts (narrow ink pairs).
 */
export function SuggestionsPanel({ meta, deck, byId, onAddCard }: {
  meta: MetaState;
  deck: DeckState;
  byId: Map<number, Card>;
  /** existing deck handler, wired to the suggestions' add buttons */
  onAddCard?: (cardId: number) => void;
}): ReactNode {
  const model = meta.model;
  const relationsReady = model?.capabilities.relations && model.relations;
  return (
    <section className="panel" data-testid="suggestions-panel">
      <h3>Suggested additions</h3>
      {!relationsReady ? (
        <MetaUnavailableNote />
      ) : (
        <SuggestionsBody deck={deck} byId={byId} model={model} onAddCard={onAddCard} />
      )}
      <p className="bar-footnote">Suggestions show while your deck is incomplete and hide once it is legal.</p>
    </section>
  );
}

function SuggestionsBody({ deck, byId, model, onAddCard }: {
  deck: DeckState;
  byId: Map<number, Card>;
  model: MetaModel;
  onAddCard?: (cardId: number) => void;
}): ReactNode {
  const suggestions = suggestCards(deck, [...byId.values()], model);
  return (
    <div className="suggestions" data-testid="suggestions-section">
      {suggestions.length === 0 ? (
        <p className="bar-footnote" data-testid="suggestions-empty">
          No legal additions found — the candidate pool for these inks and this format is exhausted.
        </p>
      ) : (
        suggestions.map((s) => (
          <div key={s.card.id} className="suggestion-row" data-testid="suggestion-row" {...cardPreviewHandlers(s.card)}>
            <CostBadge card={s.card} size="sm" />
            <InkDots inks={s.card.inks} inline />
            <span className="suggestion-name">
              {s.card.fullName}
              <span className="suggestion-basis">{s.basis}</span>
            </span>
            <span className="suggestion-score" title={`${BASIS_FUSED} / ${BASIS_TEXT}: fused 60% co-occurrence + 40% content`}>
              {Math.round(s.score * 100)}%
            </span>
            <button className="btn btn-mini" onClick={() => onAddCard?.(s.card.id)} title={`Add ${s.card.fullName}`}>
              +
            </button>
          </div>
        ))
      )}
      <p className="bar-footnote">
        Fused ranking: 60% tournament co-occurrence + 40% card-content similarity, filtered to this deck's inks,
        format and copy limits. Basis: “{BASIS_FUSED}” or “{BASIS_TEXT}” for cards outside the tournament space.
      </p>
    </div>
  );
}
