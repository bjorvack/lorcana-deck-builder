import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Engine bundle smoke test (engine-winrate): the committed artifact must
 * match the pinned engine commit, be valid ESM, and actually play a
 * deterministic full-rules game. This imports the real bundle (~1-2 s — the
 * 8 MB artifact parses once per run).
 *
 * If this fails after an engine bump, the bundle is stale: run
 * `npm run engine:bundle` (see PIN.md's bump procedure).
 */
const ARENA_DIR = import.meta.dirname;
const PUBLIC_DATA = resolve(ARENA_DIR, '..', '..', '..', 'public', 'data');
const PIN = readFileSync(join(ARENA_DIR, '..', 'vendor', 'PIN.md'), 'utf8');
const PIN_COMMIT = /Upstream commit: `([0-9a-f]{40})`/.exec(PIN)![1]!;
const COMMIT8 = PIN_COMMIT.slice(0, 8);
const BUNDLE_PATH = join(PUBLIC_DATA, `engine-bundle-${COMMIT8}.js`);

interface BundleModule {
  engineCommit: string;
  strategyId: string;
  attribution: string;
  createGame(input: {
    deckA: Record<string, number>;
    deckB: Record<string, number>;
    seed: string;
  }): Promise<{
    winner: string | null;
    turns: number;
    incomplete: boolean;
    loreTimeline: Array<{ turn: number; p1: number; p2: number }>;
    log: Array<{
      turn: number;
      p1: string[];
      p2: string[];
      lore: { p1: number; p2: number };
    }>;
  }>;
}

const league = JSON.parse(
  readFileSync(
    join(ARENA_DIR, '..', 'data', 'arena', 'selfplay', 'league-6de59de1.json'),
    'utf8',
  ),
) as {
  engineCommit: string;
  members: Array<{ kind: string; deck: Record<string, number> }>;
};

const realDecks = league.members
  .filter((m) => m.kind === 'real')
  .map((m) => m.deck);

describe('engine bundle artifact', () => {
  it('is committed for the pinned engine commit and records the pin', () => {
    expect(
      existsSync(BUNDLE_PATH),
      `missing ${BUNDLE_PATH} — run npm run engine:bundle`,
    ).toBe(true);
    const source = readFileSync(BUNDLE_PATH, 'utf8');
    // provenance travels with the shipped artifact (header comment)
    expect(source).toContain(PIN_COMMIT);
    expect(source).toContain('TheCardGoat/tcg-engines');
    expect(source).toContain('MIT');
    // sidecar records the commit the opponents artifact must agree on
    const meta = JSON.parse(
      readFileSync(join(PUBLIC_DATA, 'engine-bundle.json'), 'utf8'),
    ) as { engineCommit: string; strategyId: string };
    expect(meta.engineCommit).toBe(PIN_COMMIT);
    expect(meta.strategyId).toBe('best-deck-aware-lore-race');
    // the shipped opponent pool targets the same engine era
    const opponents = JSON.parse(
      readFileSync(join(PUBLIC_DATA, 'winrate-opponents.json'), 'utf8'),
    ) as { engineCommit: string; decks: unknown[] };
    expect(opponents.engineCommit).toBe(PIN_COMMIT);
    expect(opponents.decks).toHaveLength(4);
  });

  it('loads as ESM and plays a deterministic full-rules game', async () => {
    const bundle = (await import(
      pathToFileURL(BUNDLE_PATH).href
    )) as BundleModule;
    expect(bundle.engineCommit).toBe(PIN_COMMIT);
    expect(bundle.attribution).toContain('Ravensburger');

    const input = {
      deckA: realDecks[0]!,
      deckB: realDecks[1]!,
      seed: 'engine-bundle-test',
    };
    const game = await bundle.createGame(input);
    expect(game.incomplete).toBe(false);
    expect(['p1', 'p2']).toContain(game.winner);
    expect(game.turns).toBeGreaterThan(0);
    // per-turn review log: lore totals, action lines with card names
    expect(game.log.length).toBeGreaterThan(0);
    expect(game.log[0]!.turn).toBe(1);
    const withActions = game.log.find((t) => t.p1.length + t.p2.length > 0)!;
    expect(withActions.p1.join(' ') + withActions.p2.join(' ')).toMatch(
      /inked|played|quested|challenged|mulliganed|chose/,
    );
    expect(game.loreTimeline[game.loreTimeline.length - 1]!.turn).toBe(
      game.turns,
    );

    // determinism: the same seed replays the identical game
    const replay = await bundle.createGame(input);
    expect(replay).toEqual(game);
  }, 30_000);
});
