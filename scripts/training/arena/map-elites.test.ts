/**
 * MAP-Elites search loop tests (self-play-league, tasks 4.3/4.4) — the loop
 * core against an in-process evaluator backed by a deterministic fake game
 * player: no engine, no real games. Covers the determinism contract layer 1
 * (identical seeds → byte-identical archive + identical promotion
 * decisions), archive legality by construction, the held-out-real-deck
 * guarantee for parent selection, and the promotion offer rules.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../../src/data/types';
import { mulberry32 } from '../prng';
import { DEFAULT_DISTANCE_THRESHOLD, type League } from './league';
import {
  type CandidateEvaluator,
  type ChildPart,
  leagueFingerprint,
  mutantSeedFor,
  runMapElitesSearch,
  scatterSeedFor,
  selectParents,
  selectPromotionOffers,
  sweepOrphanedPartDirs,
} from './map-elites';
import {
  type ElitesArchive,
  emptyArchive,
  place,
  stableStringify,
} from './map-elites-archive';
import { describeDeck } from './map-elites-descriptors';
import {
  deckSignature,
  elitesDeckProblems,
  type LegalPool,
} from './map-elites-mutation';
import {
  type BatchGameResult,
  type BatchPlayer,
  evaluateCandidateVsLeague,
  memberSeedBase,
} from './schedule';

const mkCard = (
  id: number,
  ink: 'Amber' | 'Ruby',
  kind: 'Character' | 'Action' = 'Character',
  cost = 3,
  lore = 2,
): Card => ({
  id,
  name: `Card ${id}`,
  fullName: `Card ${id}`,
  groupKey: `card-${id}`,
  inks: [ink],
  isDualInk: false,
  cost,
  inkwell: kind === 'Character',
  type: kind,
  subtypes: kind === 'Character' ? ['Floodborn'] : [],
  isSong: false,
  franchise: 'test',
  setCode: 'TST',
  setName: 'Test',
  setNumber: 1,
  setType: 'expansion',
  rarity: 'common',
  maxCopies: 3,
  lore: kind === 'Character' ? lore : 0,
  text: '',
  keywords: [],
  tags: [],
  deckRuleEffects: [],
  payoffs: [],
  images: {},
  formats: { core: true, infinity: true },
});

// 25 Amber identities (75 copies) + 13 Ruby identities (39 copies)
const cards: Card[] = [
  ...Array.from({ length: 20 }, (_, i) =>
    mkCard(100 + i, 'Amber', 'Character', 1 + (i % 6), 1 + (i % 3)),
  ),
  ...Array.from({ length: 5 }, (_, i) => mkCard(150 + i, 'Amber', 'Action', 4)),
  ...Array.from({ length: 10 }, (_, i) =>
    mkCard(130 + i, 'Ruby', 'Character', 2 + (i % 4), 1 + (i % 2)),
  ),
  ...Array.from({ length: 3 }, (_, i) => mkCard(170 + i, 'Ruby', 'Action', 5)),
];
const pool: LegalPool = new Map(
  cards.map((card) => [card.id, { maxCopies: 3, inks: card.inks }]),
);

const seq = (start: number, end: number): Record<string, number> => {
  const deck: Record<string, number> = {};
  for (let id = start; id <= end; id++) deck[String(id)] = 3;
  return deck;
};

// 60 Amber cards — the gate-clearing baseline parent
const amberDeck = seq(100, 119);
// 30 Ruby + 30 Amber cards — the held-out real opponent (never a parent)
const realDeck = { ...seq(130, 139), ...seq(100, 109) };

const leagueFixture: League = {
  format: 'core',
  engineCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  seededOn: '2026-01-01T00:00:00.000Z',
  members: [
    {
      id: `real:${deckSignature(realDeck)}`,
      kind: 'real',
      deck: realDeck,
      share: 0.5,
      origin: 'fixture:holdout',
    },
    {
      id: `baseline-random:${deckSignature(amberDeck)}`,
      kind: 'baseline-random',
      deck: amberDeck,
      share: 0.5,
      origin: 'fixture:baseline',
    },
  ],
};

/** win chance depends on the candidate only: Ruby-heavy decks crush the league */
const winProbabilityFor = (deck: Record<string, number>): number => {
  let rubyCopies = 0;
  for (const [id, count] of Object.entries(deck)) {
    if (Number(id) >= 130) rubyCopies += count;
  }
  return rubyCopies >= 20 ? 0.9 : 0.3;
};

/**
 * Deterministic fake player: the winner of game `g` against seed base `s`
 * is a pure function of (deckA signature, s, g) — no Math.random.
 */
const fakePlay: BatchPlayer = (request) => {
  const signature = Number.parseInt(deckSignature(request.deckA), 16);
  const p = winProbabilityFor(request.deckA);
  const results: BatchGameResult[] = [];
  for (let game = request.from; game < request.from + request.count; game++) {
    const rng = mulberry32((request.seedBase + game * 7_919) ^ signature);
    results.push({ winner: rng() < p ? 'p1' : 'p2' });
  }
  return results;
};

/** in-process stand-in for the CLI's per-candidate child processes */
const makeEvaluator =
  (config: {
    masterSeed: number;
    gamesPerMember: number;
    batchSize: number;
    twinPaired: boolean;
  }): CandidateEvaluator =>
  async (candidates, league) =>
    candidates.map((candidate) => {
      const evaluation = evaluateCandidateVsLeague(candidate.deck, league, {
        play: fakePlay,
        masterSeed: config.masterSeed,
        gamesPerMember: config.gamesPerMember,
        batchSize: config.batchSize,
        ...(config.twinPaired ? { twinDeck: candidate.parentDeck } : {}),
      });
      const games = evaluation.results.reduce(
        (sum, member) => sum + member.games,
        0,
      );
      return {
        index: candidate.index,
        fitness: evaluation.score.score,
        games,
        ...(config.twinPaired && evaluation.twin
          ? {
              twinFitness: evaluation.twin.score.score,
              twinGames: evaluation.twin.results.reduce(
                (sum, member) => sum + member.games,
                0,
              ),
            }
          : {}),
      };
    });

const runOnce = (twinPaired = false) =>
  runMapElitesSearch({
    league: structuredClone(leagueFixture),
    pool,
    cards,
    masterSeed: 20261122,
    generations: 2,
    population: 4,
    gamesPerMember: 2,
    twinPaired,
    evaluate: makeEvaluator({
      masterSeed: 20261122,
      gamesPerMember: 2,
      batchSize: 2,
      twinPaired,
    }),
  });

describe('map-elites determinism (fake players, task 4.4 layer 1)', () => {
  it('two identical-seed runs produce byte-identical archives and identical promotion decisions', async () => {
    const first = await runOnce();
    const second = await runOnce();
    expect(stableStringify(first.archive)).toBe(
      stableStringify(second.archive),
    );
    expect(first.generations).toEqual(second.generations);
    expect(first.league).toEqual(second.league);
    expect(first.totals).toEqual(second.totals);
  });

  it('twin-paired runs are equally deterministic and only offer mutants that beat their parent', async () => {
    const first = await runOnce(true);
    const second = await runOnce(true);
    expect(stableStringify(first.archive)).toBe(
      stableStringify(second.archive),
    );
    expect(first.generations).toEqual(second.generations);
    for (const record of first.generations.flatMap(
      (generation) => generation.promotionsDetail,
    )) {
      expect(record.twinFitness).toBeDefined();
      if (record.promoted) {
        expect(record.fitness).toBeGreaterThan(record.twinFitness!);
      }
    }
  });

  it('every archived deck passes the full elites legality gate and fills its 60 cards', async () => {
    const { archive } = await runOnce();
    expect(Object.keys(archive.cells).length).toBeGreaterThan(0);
    for (const entry of Object.values(archive.cells)) {
      expect(elitesDeckProblems(entry.deck, pool, cards)).toEqual([]);
      expect(Object.values(entry.deck).reduce((a, b) => a + b, 0)).toBe(60);
      expect([0, 1]).toContain(entry.updatedOn);
    }
  });

  it('never derives candidates from held-out real decks; promotions follow the distance rule', async () => {
    const run = await runOnce();
    const origins = run.generations.flatMap(
      (generation) => generation.parentOrigins,
    );
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(origin.startsWith('league:real:')).toBe(false);
    }
    const records = run.generations.flatMap(
      (generation) => generation.promotionsDetail,
    );
    const promoted = records.filter((record) => record.promoted);
    for (const record of promoted) {
      expect(record.reason).toBeUndefined();
      expect(record.distance).toBeGreaterThan(DEFAULT_DISTANCE_THRESHOLD);
    }
    for (const record of records.filter((record) => !record.promoted)) {
      expect(record.reason).toBe('near-duplicate');
    }
    expect(
      run.league.members.filter((member) => member.kind === 'selfplay'),
    ).toHaveLength(promoted.length);
    // the holdout opponent itself is untouched by promotion
    expect(
      run.league.members.find((member) => member.kind === 'real')?.deck,
    ).toEqual(realDeck);
  });

  it('promotion offers are fitness-desc, cell-key-asc, floored, and twin-gated', () => {
    const offers = selectPromotionOffers([
      { cellKey: 'b', fitness: 0.7, deck: {} },
      { cellKey: 'a', fitness: 0.7, deck: {} },
      { cellKey: 'c', fitness: 0.4, deck: {} },
      { cellKey: 'd', fitness: 0.9, deck: {}, twinFitness: 0.95 },
    ]);
    expect(offers.map((offer) => offer.cellKey)).toEqual(['d', 'a', 'b']);
    expect(
      selectPromotionOffers(
        [{ cellKey: 'x', fitness: 0.9, deck: {}, twinFitness: 0.95 }],
        { twinPaired: true },
      ),
    ).toEqual([]);
    expect(
      selectPromotionOffers(
        [{ cellKey: 'x', fitness: 0.9, deck: {}, twinFitness: 0.5 }],
        { twinPaired: true },
      ),
    ).toHaveLength(1);
  });

  it('selectParents: generation 0 uses baselines + scatter, never real members; later generations use archive elites', () => {
    const parents0 = selectParents({
      archive: emptyArchive('core', 'a'.repeat(40), 1),
      league: leagueFixture,
      pool,
      cards,
      masterSeed: 20261122,
      generation: 0,
      population: 4,
    });
    expect(parents0).toHaveLength(4);
    expect(parents0[0]!.origin).toBe(
      `league:baseline-random:${deckSignature(amberDeck)}`,
    );
    for (const parent of parents0) {
      expect(elitesDeckProblems(parent.deck, pool, cards)).toEqual([]);
    }
    let archive = emptyArchive('core', 'a'.repeat(40), 1);
    archive = place(archive, 'cell-b', {
      descriptor: describeDeck(amberDeck, cards),
      deck: amberDeck,
      fitness: 0.6,
      games: 2,
      updatedOn: 0,
    }).archive;
    archive = place(archive, 'cell-a', {
      descriptor: describeDeck(realDeck, cards),
      deck: realDeck,
      fitness: 0.5,
      games: 2,
      updatedOn: 0,
    }).archive;
    const parents1 = selectParents({
      archive,
      league: leagueFixture,
      pool,
      cards,
      masterSeed: 20261122,
      generation: 1,
      population: 3,
    });
    expect(parents1.map((parent) => parent.origin)).toEqual([
      'archive:cell-a',
      'archive:cell-b',
      'archive:cell-a',
    ]);
  });

  it('mutant and scatter seeds are deterministic and disjoint from league game seed bases', () => {
    expect(mutantSeedFor(20261122, 0, 0)).toBe(mutantSeedFor(20261122, 0, 0));
    expect(mutantSeedFor(20261122, 1, 2)).not.toBe(
      mutantSeedFor(20261122, 1, 3),
    );
    expect(scatterSeedFor(20261122, 0)).toBe(scatterSeedFor(20261122, 0));
    const maxMemberBase = memberSeedBase(20261122, 999);
    for (let index = 0; index < 8; index++) {
      expect(mutantSeedFor(20261122, 0, index)).toBeGreaterThan(maxMemberBase);
    }
    expect(scatterSeedFor(20261122, 0)).toBeGreaterThan(maxMemberBase);
  });
});

describe('map-elites resume (fake players, task 2.1)', () => {
  const masterSeed = 20261123;
  const generations = 3;
  const searchOpts = {
    pool,
    cards,
    masterSeed,
    population: 4,
    gamesPerMember: 2,
  };
  const fakeEval = makeEvaluator({
    masterSeed,
    gamesPerMember: 2,
    batchSize: 2,
    twinPaired: false,
  });

  /** part-file content exactly as the CLI's child processes write it */
  const partFor = (
    evaluation: { index: number; fitness: number; games: number },
    generation: number,
    candidateDeck: Record<string, number>,
    league: League,
  ): ChildPart => ({
    index: evaluation.index,
    fitness: evaluation.fitness,
    games: evaluation.games,
    generation,
    masterSeed,
    deckSignature: deckSignature(candidateDeck),
    leagueFingerprint: leagueFingerprint(league),
  });

  const uninterruptedRun = async () =>
    runMapElitesSearch({
      ...searchOpts,
      league: structuredClone(leagueFixture),
      generations,
      evaluate: fakeEval,
    });

  /**
   * Run 3 generations and "kill" the process during generation 2's
   * evaluation: two candidates' parts land on disk (in the child-part
   * format), then the parent dies. Returns the persisted archive + league
   * state (post-generation-1) and the work dir holding the orphaned parts.
   */
  const interruptedRun = async (options: {
    parts: 'valid' | 'stale-seed' | 'none';
  }): Promise<{ workDir: string; archive: ElitesArchive; league: League }> => {
    const workDir = mkdtempSync(join(tmpdir(), 'map-elites-resume-'));
    let archive = emptyArchive('core', leagueFixture.engineCommit, masterSeed);
    let league: League = structuredClone(leagueFixture);
    const evaluator: CandidateEvaluator = async (
      candidates,
      currentLeague,
      generation,
    ) => {
      if (generation < 2)
        return fakeEval(candidates, currentLeague, generation);
      if (options.parts !== 'none') {
        for (const candidate of candidates.slice(0, 2)) {
          const [evaluation] = await fakeEval(
            [candidate],
            currentLeague,
            generation,
          );
          const part = partFor(
            evaluation!,
            generation,
            candidate.deck,
            currentLeague,
          );
          // a part from another seed config must be validated away on resume
          const partToWrite =
            options.parts === 'stale-seed'
              ? { ...part, masterSeed: 111 }
              : part;
          const partDir = join(workDir, `.parts-999999-${generation}`);
          mkdirSync(partDir, { recursive: true });
          writeFileSync(
            join(partDir, `part-${candidate.index}.json`),
            JSON.stringify(partToWrite),
          );
        }
      }
      throw new Error('simulated kill');
    };
    await expect(
      runMapElitesSearch({
        ...searchOpts,
        league: structuredClone(leagueFixture),
        generations,
        evaluate: evaluator,
        onArchiveUpdated: async (updated) => {
          archive = updated;
        },
        onLeagueChanged: async (updated) => {
          league = updated;
        },
      }),
    ).rejects.toThrow('simulated kill');
    return { workDir, archive, league };
  };

  it('a kill mid-generation resumes from archive + orphaned parts to a byte-identical archive', async () => {
    const uninterrupted = await uninterruptedRun();
    const killed = await interruptedRun({ parts: 'valid' });
    expect(killed.archive.generationsCompleted).toBe(2);

    const resumeParts = sweepOrphanedPartDirs(killed.workDir, {
      isProcessAlive: () => false,
    });
    expect([...resumeParts.keys()].sort()).toEqual(['2:0', '2:1']);
    expect(existsSync(join(killed.workDir, '.parts-999999-2'))).toBe(false);

    const evaluated: Record<number, number[]> = {};
    const resumed = await runMapElitesSearch({
      ...searchOpts,
      league: killed.league,
      generations,
      initialArchive: killed.archive,
      resumeParts,
      evaluate: async (candidates, league, generation) => {
        evaluated[generation] = candidates.map((candidate) => candidate.index);
        return fakeEval(candidates, league, generation);
      },
    });
    // generations 0–1 are checkpointed and skipped; generation 2 only
    // simulates the candidates whose parts never landed
    expect(Object.keys(evaluated).map(Number)).toEqual([2]);
    expect(evaluated[2]).toEqual([2, 3]);
    expect(resumed.archive.generationsCompleted).toBe(3);
    expect(stableStringify(resumed.archive)).toBe(
      stableStringify(uninterrupted.archive),
    );
    expect(resumed.league).toEqual(uninterrupted.league);
    rmSync(killed.workDir, { recursive: true, force: true });
  });

  it('a kill before any part landed resumes from the archive alone, byte-identically', async () => {
    const uninterrupted = await uninterruptedRun();
    const killed = await interruptedRun({ parts: 'none' });

    const evaluated: Record<number, number[]> = {};
    const resumed = await runMapElitesSearch({
      ...searchOpts,
      league: killed.league,
      generations,
      initialArchive: killed.archive,
      evaluate: async (candidates, league, generation) => {
        evaluated[generation] = candidates.map((candidate) => candidate.index);
        return fakeEval(candidates, league, generation);
      },
    });
    expect(Object.keys(evaluated).map(Number)).toEqual([2]);
    expect(evaluated[2]).toEqual([0, 1, 2, 3]);
    expect(stableStringify(resumed.archive)).toBe(
      stableStringify(uninterrupted.archive),
    );
    rmSync(killed.workDir, { recursive: true, force: true });
  });

  it('parts from a foreign seed are validated away and re-evaluated, not trusted', async () => {
    const uninterrupted = await uninterruptedRun();
    const killed = await interruptedRun({ parts: 'stale-seed' });

    const resumeParts = sweepOrphanedPartDirs(killed.workDir, {
      isProcessAlive: () => false,
    });
    expect(resumeParts.size).toBe(2);

    const evaluated: Record<number, number[]> = {};
    const resumed = await runMapElitesSearch({
      ...searchOpts,
      league: killed.league,
      generations,
      initialArchive: killed.archive,
      resumeParts,
      evaluate: async (candidates, league, generation) => {
        evaluated[generation] = candidates.map((candidate) => candidate.index);
        return fakeEval(candidates, league, generation);
      },
    });
    // the stale-seed parts were rejected: every candidate re-evaluates and
    // the final archive still matches the uninterrupted run
    expect(evaluated[2]).toEqual([0, 1, 2, 3]);
    expect(stableStringify(resumed.archive)).toBe(
      stableStringify(uninterrupted.archive),
    );
    rmSync(killed.workDir, { recursive: true, force: true });
  });

  it('re-invoking a completed search with the same flags runs zero generations', async () => {
    const complete = await runMapElitesSearch({
      ...searchOpts,
      league: structuredClone(leagueFixture),
      generations: 2,
      evaluate: fakeEval,
    });
    let evaluatorCalls = 0;
    const again = await runMapElitesSearch({
      ...searchOpts,
      league: complete.league,
      generations: 2,
      initialArchive: complete.archive,
      evaluate: async () => {
        evaluatorCalls += 1;
        return [];
      },
    });
    expect(evaluatorCalls).toBe(0);
    expect(again.generations).toHaveLength(0);
    expect(stableStringify(again.archive)).toBe(
      stableStringify(complete.archive),
    );
    expect(again.league).toEqual(complete.league);
  });
});
