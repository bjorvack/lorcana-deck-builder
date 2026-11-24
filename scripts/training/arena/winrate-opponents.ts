/**
 * Emits the shipped opponent pool for the engine-winrate estimator
 * (openspec change engine-winrate): recent tournament decks, selected for
 * mutual diversity, become the baseline decks the user's deck plays against
 * in the browser. The meta drifts — old opponents misrepresent it — and four
 * near-identical decks would measure one matchup four times, so selection is
 * recency-filtered and then greedily diversity-maximized.
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
import { loadCards } from './cards';
import { cardListDistance } from './league';
import { buildPanel, loadCorpus } from './panel';

const ARENA_DIR = import.meta.dirname;
const MAP_PATH = join(ARENA_DIR, 'card-map.json');
const OUT_PATH = resolve(
  ARENA_DIR,
  '..',
  '..',
  '..',
  'public',
  'data',
  'winrate-opponents.json',
);

/** pre-committed selection constants (recency + diversity, per design) */
const OPPONENT_COUNT = 4;
const RECENCY_WINDOW_DAYS = 90;
/** candidate pool size passed to the panel pipeline */
const CANDIDATE_POOL = 200;

async function main(): Promise<void> {
  const cards = loadCards();
  const rows = await loadCorpus();
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as {
    byIdentity: Record<string, { engineId: string }>;
    engineCommit: string;
  };

  // candidates: the panel pipeline's arena-eligible identity decks from the
  // recency window (the meta drifts — old decks misrepresent it)
  const panel = buildPanel(rows, cards, {
    size: CANDIDATE_POOL,
    eraDays: RECENCY_WINDOW_DAYS,
  });

  // greedy farthest-point diversity selection: seed with the most recent
  // candidate, then repeatedly add the deck maximizing its minimum card-list
  // distance to the already-selected set — near-duplicates never cluster
  const byDate = [...panel.decks].sort((a, b) => b.date.localeCompare(a.date));
  const selected: typeof byDate = byDate.length > 0 ? [byDate[0]!] : [];
  const minDistanceToSelected = (d: (typeof byDate)[number]): number =>
    Math.min(...selected.map((s) => cardListDistance(s.cards, d.cards)));
  while (selected.length < OPPONENT_COUNT) {
    let best: (typeof byDate)[number] | null = null;
    let bestDistance = -1;
    for (const d of byDate) {
      if (selected.includes(d)) continue;
      const distance = minDistanceToSelected(d);
      // ties break toward the stronger deck (the panel sorts by win rate)
      if (distance > bestDistance) {
        best = d;
        bestDistance = distance;
      }
    }
    if (!best) break;
    selected.push(best);
  }
  if (selected.length < OPPONENT_COUNT)
    throw new Error(
      `only ${selected.length} diverse opponents from ${panel.decks.length} candidates`,
    );

  const decks = selected.map((deck, index) => {
    const unmapped = Object.keys(deck.cards).filter(
      (id) => !map.byIdentity[id],
    );
    if (unmapped.length > 0)
      throw new Error(
        `${deck.signature} has unmapped identities: ${unmapped.join(', ')}`,
      );
    return {
      id: `opponent-${index}`,
      name: `${deck.source}/${deck.eventId} (${deck.date}) — ${Math.round(deck.winRate * 100)}% WR`,
      inks: deck.inks,
      cards: deck.cards,
      origin: `tournament ${deck.date} (${deck.source}/${deck.eventId})`,
      /** min card-list distance to the other selected opponents — the audit
       * trail for the diversity claim */
      minDistanceToOthers: Math.min(
        ...selected
          .filter((s) => s !== deck)
          .map((s) => cardListDistance(s.cards, deck.cards)),
      ),
    };
  });

  const artifact = {
    format: 1,
    engineCommit: map.engineCommit,
    strategyId: 'best-deck-aware-lore-race',
    generatedOn: new Date().toISOString().slice(0, 10),
    selection: {
      method:
        'recency-filtered (90d) greedy farthest-point by card-list distance',
      recencyWindowDays: RECENCY_WINDOW_DAYS,
      candidatePool: CANDIDATE_POOL,
      candidateCount: panel.decks.length,
      considered: panel.considered,
    },
    decks,
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 1)}\n`);
  console.error(
    `winrate opponents: ${OUT_PATH} (${decks.length} decks from ${panel.decks.length} candidates, engine ${artifact.engineCommit.slice(0, 8)})`,
  );
  for (const d of decks) {
    console.error(
      `  - ${d.name} [${d.inks.join('/')}] min-distance ${d.minDistanceToOthers}`,
    );
  }
}

await main();
