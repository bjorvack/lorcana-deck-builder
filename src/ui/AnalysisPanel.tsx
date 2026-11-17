import type { ReactNode } from 'react';
import type { Fingerprint } from '../stats/fingerprint';
import { AXIS_FORMULAS } from '../stats/fingerprint';
import { OPPONENT_PROFILES } from '../stats/profiles';

const SIMPLIFICATIONS =
  'Estimates from seeded simulations with greedy policies and scripted opponent profiles — no interactive play. They compare pace and consistency, not real matchups.';

/** viability profile + matchup bars for a valid deck (does not render otherwise) */
export function AnalysisPanel({ fingerprint }: { fingerprint: Fingerprint | null }): ReactNode {
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
    </section>
  );
}
