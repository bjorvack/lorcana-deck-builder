import type { Card, DeckState } from '../data/types';
import { type TempoEffects, tempoEffects } from './tempo';

export interface CurveConsistency {
  trials: number;
  /** the seed used, for reproducible display */
  seed: number;
  /** per turn 1..maxTurns: P(a cost-t card was played on turn t); null when the deck has no cost-t cards */
  byTurn: (number | null)[];
  /** mean spendable resources (ready ink + ink drops) on each turn, indexed 1..maxTurns */
  expectedInk: number[];
  /** mean songs played via singers on each turn, indexed 1..maxTurns (ahead-of-curve plays) */
  singsByTurn: number[];
  /** median consecutive on-curve turns starting at turn 1; turns the deck has no matching cost for are skipped */
  onCurveThrough: number;
}

export const CURVE_TRIALS = 20_000;
export const CURVE_MAX_TURNS = 7;
/** fixed so the dashboard shows stable numbers between renders */
export const CURVE_SEED = 20261117;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PoolCard extends TempoEffects {
  cost: number;
  inkwell: boolean;
  name: string;
}

interface BoardChar {
  name: string;
  cost: number;
  singerValue: number | null;
  playedTurn: number;
  /** last turn this character sang — exerted until the next ready step */
  sangTurn: number;
}

/**
 * Monte Carlo estimate of how reliably a deck plays "on curve" (a cost-t card on
 * turn t), honouring the tempo rules that change it: the inkwell is persistent
 * (exert to pay, ready again next turn), songs are sung by dry in-play
 * characters, printed self-discounts apply, ramp ink arrives exerted (spendable
 * the following turn), additional-ink effects raise the once-per-turn inking
 * limit, ink drop counters pay one ink each, flexible inking converts cards
 * without the inkwell icon, and leftover resources flood into additional plays.
 * Each trial shuffles the deck, deals 7, then per turn draws (the on-the-play
 * player skips the first draw), inks with a greedy policy — ink the
 * highest-cost card that is unaffordable this turn, else the cheapest
 * affordable — and plays the best affordable card, preferring an exact
 * curve-cost match.
 */
export function curveConsistency(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: {
    trials?: number;
    maxTurns?: number;
    seed?: number;
    onThePlay?: boolean;
  } = {},
): CurveConsistency | null {
  const trials = opts.trials ?? CURVE_TRIALS;
  const maxTurns = opts.maxTurns ?? CURVE_MAX_TURNS;
  const onThePlay = opts.onThePlay ?? true;
  const rng = mulberry32(opts.seed ?? CURVE_SEED);

  const pool: PoolCard[] = [];
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card || count <= 0) continue;
    const fx = tempoEffects(card);
    for (let i = 0; i < count; i++)
      pool.push({
        ...fx,
        cost: card.cost,
        inkwell: card.inkwell,
        name: card.name,
      });
  }
  if (pool.length === 0) return null;
  const hasCost = new Set(pool.map((c) => c.cost));

  const onCurveCount = new Array<number>(maxTurns + 1).fill(0);
  const inkSum = new Array<number>(maxTurns + 1).fill(0);
  const singSum = new Array<number>(maxTurns + 1).fill(0);
  const streaks: number[] = [];

  for (let trial = 0; trial < trials; trial++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const hand = pool.slice(0, Math.min(7, pool.length));
    let deckIdx = hand.length;
    // persistent inkwell (every inked card stays), exerted this turn, ramp ink
    // that arrived exerted, one-use ink drops
    let inkwell = 0;
    let spent = 0;
    let rampExerted = 0;
    let drops = 0;
    let flexible = false;
    let extraInk = false;
    const board: BoardChar[] = [];
    let inkedThisTurn = 0;
    let oneShotExtraInk = false;
    let streak = 0;
    let broken = false;

    const allowance = (): number =>
      1 + (extraInk ? 1 : 0) + (oneShotExtraInk ? 1 : 0);
    const available = (): number => inkwell - spent - rampExerted + drops;
    /** printed cost minus unconditional and (board-conditioned) discounts */
    const effCost = (c: PoolCard): number => {
      const cond = c.conditionalDiscount;
      if (cond === null) return Math.max(0, c.cost - c.selfDiscount);
      const met = board.some(
        (b) => b.name.toLowerCase() === cond.target.toLowerCase(),
      );
      return Math.max(0, c.cost - c.selfDiscount - (met ? cond.amount : 0));
    };
    const pay = (eff: number): void => {
      const fromDrops = Math.min(drops, eff);
      drops -= fromDrops;
      spent += eff - fromDrops;
    };
    const canSing = (eff: number, turn: number): boolean =>
      board.some(
        (b) =>
          b.playedTurn < turn &&
          b.sangTurn < turn &&
          (b.cost >= eff || (b.singerValue ?? 0) >= eff),
      );
    const exertSinger = (eff: number, turn: number): void => {
      const idx = board.findIndex(
        (b) =>
          b.playedTurn < turn &&
          b.sangTurn < turn &&
          (b.cost >= eff || (b.singerValue ?? 0) >= eff),
      );
      board[idx]!.sangTurn = turn;
    };

    /** cheapest inkable hand card by the greedy policy; -1 when nothing qualifies */
    const pickInk = (avail: number): number => {
      let unaff = -1;
      let unaffCost = -1;
      let cheap = -1;
      let cheapCost = Infinity;
      for (let i = 0; i < hand.length; i++) {
        const c = hand[i]!;
        if (!c.inkwell && !flexible) continue;
        if (c.cost > avail) {
          if (c.cost > unaffCost) {
            unaffCost = c.cost;
            unaff = i;
          }
        } else if (c.cost < cheapCost) {
          cheapCost = c.cost;
          cheap = i;
        }
      }
      return unaff !== -1 ? unaff : cheap;
    };

    for (let turn = 1; turn <= maxTurns; turn++) {
      // ready step: everything readies — spent and last turn's ramp ink become spendable
      spent = 0;
      rampExerted = 0;
      inkedThisTurn = 0;
      oneShotExtraInk = false;

      if (!(turn === 1 && onThePlay) && deckIdx < pool.length)
        hand.push(pool[deckIdx++]!);

      // ink step (greedy); repeated in the flood loop when the allowance grows mid-turn
      while (inkedThisTurn < allowance()) {
        const idx = pickInk(available());
        if (idx === -1) break;
        inkwell++;
        inkedThisTurn++;
        hand.splice(idx, 1);
      }
      inkSum[turn]! += available();

      /** play a hand card at effective cost, paying ink or singing; false when unaffordable */
      const play = (idx: number, turn: number): boolean => {
        const c = hand[idx]!;
        const eff = effCost(c);
        let viaSing = false;
        if (c.isSong && available() < eff) {
          if (!canSing(eff, turn)) return false;
          viaSing = true;
          exertSinger(eff, turn);
        }
        if (available() >= eff) {
          pay(eff);
        } else if (!viaSing) {
          return false;
        }
        hand.splice(idx, 1);
        if (viaSing) singSum[turn]!++;
        if (c.rampOnPlay) {
          inkwell++; // arrives exerted: spendable from next turn
          rampExerted++;
        }
        if (c.additionalInkOnPlay) oneShotExtraInk = true;
        if (c.additionalInkWhileInPlay) extraInk = true;
        if (c.inkDropsOnPlay) drops += c.inkDropsOnPlay;
        if (c.flexibleInk) flexible = true;
        if (!c.isSong && c.inkwell)
          board.push({
            name: c.name,
            cost: c.cost,
            singerValue: c.singerValue,
            playedTurn: turn,
            sangTurn: -1,
          });
        return true;
      };
      const playable = (idx: number, turn: number): boolean => {
        const c = hand[idx]!;
        const eff = effCost(c);
        return available() >= eff || (c.isSong && canSing(eff, turn));
      };

      // play step: best affordable card, exact curve cost wins
      let curveIdx = -1;
      let bestIdx = -1;
      let bestEff = -1;
      for (let i = 0; i < hand.length; i++) {
        const c = hand[i]!;
        if (!playable(i, turn)) continue;
        const eff = effCost(c);
        if (c.cost === turn) {
          if (
            curveIdx === -1 ||
            eff >
              Math.max(0, hand[curveIdx]!.cost - hand[curveIdx]!.selfDiscount)
          )
            curveIdx = i;
        } else if (eff > bestEff) {
          bestEff = eff;
          bestIdx = i;
        }
      }
      let played: number | null = null;
      if (curveIdx !== -1) {
        const curveCost = hand[curveIdx]!.cost;
        if (play(curveIdx, turn)) played = curveCost;
      } else if (bestIdx !== -1) {
        const bestCost = hand[bestIdx]!.cost;
        if (play(bestIdx, turn)) played = bestCost;
      }

      // flood: spend leftover resources on additional plays, most expensive first
      for (;;) {
        let floodIdx = -1;
        let floodEff = -1;
        for (let i = 0; i < hand.length; i++) {
          const c = hand[i]!;
          if (!playable(i, turn)) continue;
          const eff = effCost(c);
          if (eff > floodEff) {
            floodEff = eff;
            floodIdx = i;
          }
        }
        if (floodIdx === -1) break;
        if (!play(floodIdx, turn)) break;
        // a mid-turn allowance gain (e.g. Sail the Azurite Sea) enables one more ink
        while (inkedThisTurn < allowance()) {
          const idx = pickInk(available());
          if (idx === -1) break;
          inkwell++;
          inkedThisTurn++;
          hand.splice(idx, 1);
        }
      }

      if (played === turn) onCurveCount[turn]!++;
      if (!broken) {
        if (played === turn) streak++;
        else if (hasCost.has(turn)) broken = true; // no matching cost in deck → skipped, not a miss
      }
    }
    streaks.push(streak);
  }

  const sorted = [...streaks].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;

  return {
    trials,
    seed: opts.seed ?? CURVE_SEED,
    // index 0 is an unused placeholder so array index === turn number
    byTurn: [
      null,
      ...Array.from({ length: maxTurns }, (_, i) =>
        hasCost.has(i + 1) ? onCurveCount[i + 1]! / trials : null,
      ),
    ],
    expectedInk: [
      0,
      ...Array.from({ length: maxTurns }, (_, i) => inkSum[i + 1]! / trials),
    ],
    singsByTurn: [
      0,
      ...Array.from({ length: maxTurns }, (_, i) => singSum[i + 1]! / trials),
    ],
    onCurveThrough: median,
  };
}
