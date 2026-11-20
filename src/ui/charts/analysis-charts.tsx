/**
 * Analysis-panel charts as configurations of the chart kit primitives
 * (lazy charts chunk — see AnalysisPanel).
 */
import { type ReactNode, useState } from 'react';
import type { AxisName } from '../../stats/fingerprint';
import type { MatchupEstimate } from '../../stats/goldfish';
import { OPPONENT_PROFILES } from '../../stats/profiles';
import { MultiLineChart, RadarChart } from './primitives';
import { chartTheme } from './theme';

const AXES: AxisName[] = [
  'Tempo',
  'Consistency',
  'Resilience',
  'Interaction',
  'Reach',
];

/** viability profile radar with the dotted 50-midpoint reference ring */
export function ViabilityRadar({
  axes,
}: {
  axes: Record<AxisName, number>;
}): ReactNode {
  return (
    <RadarChart
      axes={AXES}
      series={[
        {
          name: 'This deck',
          values: AXES.map((a) => axes[a]),
          color: chartTheme.deck,
        },
      ]}
      midpoint={50}
      ariaLabel={`Viability profile: ${AXES.map((a) => `${a} ${axes[a]}`).join(', ')} (dotted ring marks the 50 midpoint)`}
    />
  );
}

/** lore race — accumulated lore per turn vs the selected baseline's pace */
export function LoreRaceLines({
  matchups,
}: {
  matchups: MatchupEstimate[];
}): ReactNode {
  const [selected, setSelected] = useState(matchups[0]?.profileId);
  const match = matchups.find((m) => m.profileId === selected) ?? matchups[0];
  if (!match) return null;
  const profile = OPPONENT_PROFILES.find((p) => p.id === match.profileId)!;
  const theirs = cumulative(profile.lorePerTurn);
  const data = match.loreByTurn.map((lore, i) => ({
    turn: i + 1,
    ours: Math.round(lore * 10) / 10,
    theirs: Math.round((theirs[i] ?? 0) * 10) / 10,
  }));
  return (
    <div>
      <div
        className="flex gap-1.5 flex-wrap mb-2"
        role="tablist"
        aria-label="Baseline"
      >
        {matchups.map((m) => (
          <button
            key={m.profileId}
            type="button"
            role="tab"
            aria-selected={m.profileId === match.profileId}
            className={`bg-panel-2 text-parchment border rounded-lg py-0.5 px-2 cursor-pointer text-xs hover:border-gold ${m.profileId === match.profileId ? 'border-gold text-parchment' : 'border-line'}`}
            onClick={() => setSelected(m.profileId)}
          >
            {m.name.replace(' baseline', '')} · {Math.round(m.winRate * 100)}%
          </button>
        ))}
      </div>
      <MultiLineChart
        data={data}
        xKey="turn"
        series={[
          {
            name: 'this deck',
            dataKey: 'ours',
            color: chartTheme.deck,
            dotRadius: 2,
          },
          {
            name: profile.name,
            dataKey: 'theirs',
            color: chartTheme.opponent,
            dashed: true,
          },
        ]}
        yMax={20}
        tooltipValueFormatter={(value, name) => [
          `${String(value)} lore`,
          name === 'ours' ? 'this deck' : profile.name,
        ]}
        tooltipLabelFormatter={(t) => `turn ${t}`}
        ariaLabel={`Lore race vs ${profile.name}: our mean accumulated lore per turn against the baseline's scripted pace; win rate ${Math.round(match.winRate * 100)}%`}
      />
      <p className="text-parchment-muted text-[11px] mt-1">
        Mean accumulated lore at the end of each of our turns vs the baseline's
        scripted pace — 20 lore wins.
        {match.medianFinish !== null &&
          ` This deck finishes around turn ${match.medianFinish}.`}
      </p>
    </div>
  );
}

/** cumulative opponent lore from the scripted per-turn pace */
const cumulative = (perTurn: number[]): number[] => {
  let sum = 0;
  return perTurn.map((v) => (sum += v));
};
