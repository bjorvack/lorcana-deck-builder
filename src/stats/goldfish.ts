import type { Card, DeckState } from '../data/types';
import {
  OPPONENT_PROFILES,
  type OpponentProfile,
  profileById,
} from './profiles';
import { mulberry32 } from './rng';
import { type TempoEffects, tempoEffects } from './tempo';

export interface RaceResult {
  profileId: OpponentProfile['id'];
  trials: number;
  /** P(reaching 20 lore before the baseline does) */
  winRate: number;
  /** median turn on which we reach 20 lore in won games; null when never won */
  medianFinish: number | null;
  /** mean of our accumulated lore at the end of each of our turns, indexed 1..maxTurns */
  loreByTurn: number[];
}

export interface MatchupEstimate extends Omit<RaceResult, 'trials'> {
  name: string;
}

export const RACE_TRIALS = 10_000;
export const RACE_MAX_TURNS = 15;
export const RACE_SEED = 20261117;

interface PoolCard {
  cost: number;
  inkwell: boolean;
  type: Card['type'];
  strength: number;
  willpower: number;
  lore: number;
  name: string;
  evasive: boolean;
  ward: boolean;
  reckless: boolean;
  singerValue: number | null;
  selfDiscount: number;
  conditionalDiscount: TempoEffects['conditionalDiscount'];
  rampOnPlay: boolean;
  additionalInkOnPlay: boolean;
  additionalInkWhileInPlay: boolean;
  inkDropsOnPlay: number;
  flexibleInk: boolean;
  isSong: boolean;
}

const toPool = (card: Card): PoolCard => {
  const fx = tempoEffects(card);
  return {
    cost: card.cost,
    inkwell: card.inkwell,
    type: card.type,
    strength: card.strength ?? 0,
    willpower: card.willpower ?? 0,
    lore: card.lore ?? 0,
    name: card.name,
    evasive: card.keywords.includes('Evasive'),
    ward: card.keywords.includes('Ward'),
    reckless: card.keywords.includes('Reckless'),
    singerValue: fx.singerValue,
    selfDiscount: fx.selfDiscount,
    conditionalDiscount: fx.conditionalDiscount,
    rampOnPlay: fx.rampOnPlay,
    additionalInkOnPlay: fx.additionalInkOnPlay,
    additionalInkWhileInPlay: fx.additionalInkWhileInPlay,
    inkDropsOnPlay: fx.inkDropsOnPlay,
    flexibleInk: fx.flexibleInk,
    isSong: fx.isSong,
  };
};

/**
 * Lore-race goldfish: plays our deck greedily (ink every turn, flood plays,
 * quest with every dry character) against a scripted opponent baseline, and
 * reports how reliably the deck reaches 20 lore first. Honors the timing and
 * combat rules that shape a race: drying characters quest a turn later,
 * locations pay lore in the Set step, challenges hit only exerted characters
 * with keyword legality (Evasive, Ward vs targeting, Reckless cannot quest),
 * damage persists, the on-the-play player skips the first draw, and ending
 * your turn with an empty deck loses. Our own interaction is not modelled —
 * control-style decks score low in the race by design (see the Interaction
 * axis for that dimension).
 */
export function simulateRace(
  deck: DeckState,
  byId: Map<number, Card>,
  profileId: OpponentProfile['id'],
  opts: {
    trials?: number;
    seed?: number;
    maxTurns?: number;
    onThePlay?: boolean;
  } = {},
): RaceResult | null {
  const profile = profileById(profileId);
  const trials = opts.trials ?? RACE_TRIALS;
  const maxTurns = opts.maxTurns ?? RACE_MAX_TURNS;
  const onThePlay = opts.onThePlay ?? true;
  const rng = mulberry32(opts.seed ?? RACE_SEED);

  const pool: PoolCard[] = [];
  for (const [id, count] of Object.entries(deck.cards)) {
    const card = byId.get(Number(id));
    if (!card || count <= 0) continue;
    for (let i = 0; i < count; i++) pool.push(toPool(card));
  }
  if (pool.length === 0) return null;

  let wins = 0;
  const finishTurns: number[] = [];
  const loreSum = new Array<number>(maxTurns + 1).fill(0);

  for (let trial = 0; trial < trials; trial++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    const hand = pool.slice(0, Math.min(7, pool.length));
    let deckIdx = hand.length;
    let inkwell = 0;
    let spent = 0;
    let rampExerted = 0;
    let drops = 0;
    let flexible = false;
    let extraInk = false;
    let inkedThisTurn = 0;
    let oneShotExtraInk = false;
    const board: {
      c: PoolCard;
      damage: number;
      playedTurn: number;
      exerted: boolean;
      sangTurn: number;
    }[] = [];
    const locations: { lore: number; playedTurn: number }[] = [];
    let ourLore = 0;
    let oppLore = 0;
    let finished: number | null = null;
    let lost = false;

    const allowance = (): number =>
      1 + (extraInk ? 1 : 0) + (oneShotExtraInk ? 1 : 0);
    const available = (): number => inkwell - spent - rampExerted + drops;
    const effCost = (c: PoolCard): number => {
      const cond = c.conditionalDiscount;
      if (cond === null) return Math.max(0, c.cost - c.selfDiscount);
      const met = board.some(
        (b) => b.c.name.toLowerCase() === cond.target.toLowerCase(),
      );
      return Math.max(0, c.cost - c.selfDiscount - (met ? cond.amount : 0));
    };
    const pay = (eff: number): void => {
      const d = Math.min(drops, eff);
      drops -= d;
      spent += eff - d;
    };
    const canSing = (eff: number, turn: number): boolean =>
      board.some(
        (b) =>
          b.playedTurn < turn &&
          b.sangTurn < turn &&
          (b.c.cost >= eff || (b.c.singerValue ?? 0) >= eff),
      );
    const exertSinger = (eff: number, turn: number): void => {
      const i = board.findIndex(
        (b) =>
          b.playedTurn < turn &&
          b.sangTurn < turn &&
          (b.c.cost >= eff || (b.c.singerValue ?? 0) >= eff),
      );
      // singing exerts: the singer cannot also quest this turn, and it is a
      // legal challenge target until the next ready step
      board[i]!.sangTurn = turn;
      board[i]!.exerted = true;
    };
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
    const playable = (idx: number, turn: number): boolean => {
      const c = hand[idx]!;
      const eff = effCost(c);
      return available() >= eff || (c.isSong && canSing(eff, turn));
    };
    const play = (idx: number, turn: number): boolean => {
      const c = hand[idx]!;
      const eff = effCost(c);
      let viaSing = false;
      if (c.isSong && available() < eff) {
        if (!canSing(eff, turn)) return false;
        viaSing = true;
        exertSinger(eff, turn);
      }
      if (available() >= eff) pay(eff);
      else if (!viaSing) return false;
      hand.splice(idx, 1);
      if (c.rampOnPlay) {
        inkwell++;
        rampExerted++;
      }
      if (c.additionalInkOnPlay) oneShotExtraInk = true;
      if (c.additionalInkWhileInPlay) extraInk = true;
      if (c.inkDropsOnPlay) drops += c.inkDropsOnPlay;
      if (c.flexibleInk) flexible = true;
      // every character joins the board — the inkwell icon only gates inking,
      // never questing, singing or being challenged (555 characters lack it)
      if (c.type === 'Character')
        board.push({
          c,
          damage: 0,
          playedTurn: turn,
          exerted: false,
          sangTurn: -1,
        });
      else if (c.type === 'Location')
        locations.push({ lore: c.lore, playedTurn: turn });
      return true;
    };

    for (let turn = 1; turn <= maxTurns && finished === null && !lost; turn++) {
      // our turn: ready everything we exerted last turn
      spent = 0;
      rampExerted = 0;
      inkedThisTurn = 0;
      oneShotExtraInk = false;
      for (const b of board) b.exerted = false;

      // Set step: locations pay their lore automatically; characters dry up
      for (const loc of locations)
        if (loc.playedTurn < turn) ourLore += loc.lore;

      if (!(turn === 1 && onThePlay) && deckIdx < pool.length)
        hand.push(pool[deckIdx++]!);

      while (inkedThisTurn < allowance()) {
        const idx = pickInk(available());
        if (idx === -1) break;
        inkwell++;
        inkedThisTurn++;
        hand.splice(idx, 1);
      }

      // main phase: flood everything affordable, most expensive first
      for (;;) {
        let idx = -1;
        let best = -1;
        for (let i = 0; i < hand.length; i++) {
          if (!playable(i, turn)) continue;
          const eff = effCost(hand[i]!);
          if (eff > best) {
            best = eff;
            idx = i;
          }
        }
        if (idx === -1 || !play(idx, turn)) break;
        while (inkedThisTurn < allowance()) {
          const k = pickInk(available());
          if (k === -1) break;
          inkwell++;
          inkedThisTurn++;
          hand.splice(k, 1);
        }
      }

      // quest with every dry, non-reckless character (Reckless cannot quest)
      for (const b of board) {
        if (b.playedTurn < turn && !b.exerted && !b.c.reckless) {
          b.exerted = true;
          ourLore += b.c.lore;
        }
      }
      loreSum[turn]! += ourLore;

      if (ourLore >= 20) {
        finished = turn;
        break;
      }
      // end of our turn: an empty library loses the game
      if (deckIdx >= pool.length) {
        lost = true;
        break;
      }

      // opponent turn: scripted pace + interaction
      oppLore +=
        profile.lorePerTurn[
          Math.min(turn - 1, profile.lorePerTurn.length - 1)
        ]!;
      if (oppLore >= 20) {
        lost = true;
        break;
      }
      for (const b of board) {
        if (!b.exerted) continue; // challenges target only exerted characters
        if (rng() > profile.challengeRate) continue;
        if (b.c.evasive && rng() > profile.evasiveShare) continue;
        b.damage += profile.challengeStrength;
      }
      if (rng() < profile.removalRate) {
        // targeted removal cannot choose Ward characters; kills the biggest lore threat
        const targets = board.filter((b) => !b.c.ward);
        if (targets.length > 0) {
          const target = targets.reduce((a, b) =>
            b.c.lore > a.c.lore ? b : a,
          );
          board.splice(board.indexOf(target), 1);
        }
      }
      // persistent damage banishes
      for (let i = board.length - 1; i >= 0; i--) {
        if (
          board[i]!.c.willpower > 0 &&
          board[i]!.damage >= board[i]!.c.willpower
        )
          board.splice(i, 1);
      }
    }

    if (finished !== null) {
      wins++;
      finishTurns.push(finished);
    }
    // games that finish neither way count as our loss: the profile out-scales a stalled board
  }

  const sorted = [...finishTurns].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianFinish = sorted.length
    ? sorted.length % 2
      ? sorted[mid]!
      : (sorted[mid - 1]! + sorted[mid]!) / 2
    : null;

  return {
    profileId,
    trials,
    winRate: wins / trials,
    medianFinish,
    loreByTurn: loreSum.slice(1).map((s) => s / trials),
  };
}

/** run the race against every baseline; null when no deck card resolves to the catalog */
export function matchupEstimates(
  deck: DeckState,
  byId: Map<number, Card>,
  opts: {
    trials?: number;
    seed?: number;
    maxTurns?: number;
    onThePlay?: boolean;
  } = {},
): MatchupEstimate[] | null {
  // guard on resolvable cards, not raw counts: a deck of only unknown ids
  // would make every race null (e.g. stale ids in saved storage)
  const anyCards = Object.entries(deck.cards).some(
    ([id, c]) => c > 0 && byId.has(Number(id)),
  );
  if (!anyCards) return null;
  return OPPONENT_PROFILES.map((p) => {
    const r = simulateRace(deck, byId, p.id, opts)!;
    return {
      profileId: r.profileId,
      name: p.name,
      winRate: r.winRate,
      medianFinish: r.medianFinish,
      loreByTurn: r.loreByTurn,
    };
  });
}
