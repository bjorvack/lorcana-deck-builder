/**
 * Scripted opponent baselines for the lore-race goldfish.
 *
 * The opponent is an abstract profile, not a real deck: each turn it gains a
 * parameterized amount of lore (its questing pace) and applies interaction to
 * our board — challenges against our exerted (questing) characters and
 * targeted removal, both as per-turn Bernoulli events. Parameters are seeded
 * from the measured official/competitive benchmark curves (73-90% inkable,
 * 1-3 cost mass, finishers at 5+) and tuned for plausibility, not fitted to
 * match data. The race assumes our side never interacts back — matchup
 * outputs are "estimate vs baseline profile", not predictions.
 */

export interface OpponentProfile {
  id: 'aggressive' | 'midrange' | 'control';
  name: string;
  /** lore the opponent gains on each of their turns, indexed from turn 1 */
  lorePerTurn: number[];
  /** chance per turn that each of our exerted characters gets challenged */
  challengeRate: number;
  /** damage a typical opponent challenger deals */
  challengeStrength: number;
  /** share of opponent challenges that can hit Evasive characters */
  evasiveShare: number;
  /** chance per turn of a targeted removal effect banishing one of our characters */
  removalRate: number;
  /** what the baseline represents, shown in tooltips */
  description: string;
}

export const OPPONENT_PROFILES: OpponentProfile[] = [
  {
    id: 'aggressive',
    name: 'Aggressive baseline',
    lorePerTurn: [0, 1, 2, 3, 4, 4, 4, 2, 2, 2, 1, 1, 1, 1, 1],
    challengeRate: 0.5,
    challengeStrength: 2,
    evasiveShare: 0.5,
    removalRate: 0.05,
    description:
      'Cheap evasive bodies racing to 20 lore around turn 8, challenging our questers every turn.',
  },
  {
    id: 'midrange',
    name: 'Midrange baseline',
    lorePerTurn: [0, 0, 1, 2, 3, 3, 4, 3, 2, 2, 1, 1, 1, 1, 1],
    challengeRate: 0.3,
    challengeStrength: 4,
    evasiveShare: 0.2,
    removalRate: 0.15,
    description:
      'Bigger bodies trading with us from turn 3, on pace to win around turn 10, with a removal spell every few turns.',
  },
  {
    id: 'control',
    name: 'Control baseline',
    lorePerTurn: [0, 0, 0, 1, 2, 2, 3, 3, 3, 2, 1, 1, 2, 1, 1],
    challengeRate: 0.05,
    challengeStrength: 5,
    evasiveShare: 0.2,
    removalRate: 0.45,
    description:
      'Slow to start (winning around turn 13), but banishing a character almost every turn until it stabilizes.',
  },
];

export const profileById = (id: OpponentProfile['id']): OpponentProfile =>
  OPPONENT_PROFILES.find((p) => p.id === id)!;
