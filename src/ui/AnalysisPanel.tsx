import type { ReactNode } from 'react';
import type { Fingerprint } from '../stats/fingerprint';
import { AXIS_FORMULAS } from '../stats/fingerprint';
import { OPPONENT_PROFILES } from '../stats/profiles';
import type { Card, DeckState } from '../data/types';
import type { MetaModel } from '../meta/infer';
import { metaAdjustedViability } from '../meta/infer';

const SIMPLIFICATIONS =
  'Estimates from seeded simulations with greedy policies and scripted opponent profiles — no interactive play. They compare pace and consistency, not real matchups.';

export interface MetaState {
  model: MetaModel | null;
  stale: boolean;
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
    return (
      <p className="bar-footnote meta-state" data-testid="meta-unavailable">
        Meta model unavailable — deterministic metrics only. Train and ship <code>data/model.json</code> to enable
        archetype matching and the calibrated viability score.
      </p>
    );
  }
  const { model, stale } = meta;
  const viability = metaAdjustedViability(fingerprint, deck, byId, model);
  return (
    <div className="meta-block" data-testid="meta-section">
      <h4>Meta fit</h4>
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
