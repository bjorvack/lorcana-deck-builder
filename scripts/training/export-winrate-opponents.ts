/**
 * Emits the shipped opponent pool for the engine-winrate estimator
 * (openspec change engine-winrate): the league's real held-out tournament
 * members become the baseline decks the user's deck plays against in the
 * browser.
 *
 *   npx tsx scripts/training/export-winrate-opponents.ts
 *
 * Output: public/data/winrate-opponents.json — committed, because the runtime
 * fetches it to learn both the opponent lists and which engine bundle to load
 * (the bundle filename carries the commit8). `cards` entries are OUR canonical
 * print ids (the same id space as DeckState.cards); the engine bundle resolves
 * them against its baked identity map.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCards } from './arena/cards';

const TRAINING_DIR = import.meta.dirname;
const LEAGUE_PATH = join(
  TRAINING_DIR,
  'data',
  'arena',
  'selfplay',
  'league-6de59de1.json',
);
const MAP_PATH = join(TRAINING_DIR, 'arena', 'card-map.json');
const OUT_PATH = resolve(
  TRAINING_DIR,
  '..',
  '..',
  'public',
  'data',
  'winrate-opponents.json',
);

/** how many real held-out members ship as baselines (the pre-committed budget
 * multiplies this by 16 games) */
const OPPONENT_COUNT = 4;

interface LeagueMember {
  id: string;
  kind: string;
  deck: Record<string, number>;
  origin?: string;
}

interface CardLike {
  id: number;
  inks: string[];
}

const tournamentName = (member: LeagueMember): string => {
  // origin: "corpus:lorcanahunter:18084:2026-11-01" → the corpus deck number
  const originId = member.origin?.split(':')[2];
  return originId ? `Tournament deck ${originId}` : member.id;
};

const memberInks = (
  deck: Record<string, number>,
  byId: Map<number, CardLike>,
): string[] => {
  const inks = new Set<string>();
  for (const [id] of Object.entries(deck)) {
    for (const ink of byId.get(Number(id))?.inks ?? []) inks.add(ink);
  }
  return [...inks].sort();
};

async function main(): Promise<void> {
  const league = JSON.parse(readFileSync(LEAGUE_PATH, 'utf8')) as {
    engineCommit: string;
    members: LeagueMember[];
  };
  const cards = loadCards();
  const byId = new Map<number, CardLike>(
    cards.map((c) => [c.id, { id: c.id, inks: [...c.inks] }]),
  );
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as {
    byIdentity: Record<string, { engineId: string }>;
  };

  const real = league.members.filter((m) => m.kind === 'real');
  if (real.length < OPPONENT_COUNT)
    throw new Error(
      `league has ${real.length} real members, expected ${OPPONENT_COUNT}`,
    );

  const decks = real.slice(0, OPPONENT_COUNT).map((member, index) => {
    const total = Object.values(member.deck).reduce((s, c) => s + c, 0);
    if (total !== 60)
      throw new Error(`${member.id} has ${total} cards, expected 60`);
    const unmapped = Object.keys(member.deck).filter(
      (id) => !map.byIdentity[id],
    );
    if (unmapped.length > 0)
      throw new Error(
        `${member.id} has unmapped identities: ${unmapped.join(', ')}`,
      );
    return {
      id: member.id,
      name: tournamentName(member),
      inks: memberInks(member.deck, byId),
      cards: Object.fromEntries(
        Object.entries(member.deck).sort(([a], [b]) => Number(a) - Number(b)),
      ),
      ...(originLabel(member, index) ?? {}),
    };
  });

  const artifact = {
    format: 1,
    engineCommit: league.engineCommit,
    strategyId: 'best-deck-aware-lore-race',
    generatedOn: new Date().toISOString().slice(0, 10),
    decks,
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 1)}\n`);
  console.error(
    `winrate opponents: ${OUT_PATH} (${decks.length} decks, engine ${artifact.engineCommit.slice(0, 8)})`,
  );
}

/** human-readable provenance for the review UI, when the origin parses */
function originLabel(
  member: LeagueMember,
  index: number,
): { origin: string } | null {
  const parts = member.origin?.split(':') ?? [];
  if (parts[0] !== 'corpus' || !parts[3]) return null;
  return { origin: `tournament ${parts[3]}, deck #${index + 1}` };
}

await main();
