import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Card } from '../../src/data/types';
import { makeCard } from '../../src/test/fixtures';
import { buildCanonicalRegistry } from './canonical';

const withRelease = (card: Card, releasedAt: string): Card => ({
  ...card,
  releasedAt,
});

describe('canonical registry', () => {
  it('collapses multi-print full names to the newest print', () => {
    const original = withRelease(
      makeCard({ id: 1, name: 'Ariel', version: 'Spectacular Singer' }),
      '2023-09-01',
    );
    const reprint = withRelease(
      makeCard({ id: 77, name: 'Ariel', version: 'Spectacular Singer' }),
      '2025-05-16',
    );
    const { canonicalByGroup, alias } = buildCanonicalRegistry([
      original,
      reprint,
    ]);
    expect(canonicalByGroup.get(original.groupKey)!.id).toBe(77);
    expect(alias.get(1)).toBe(77);
    expect(alias.get(77)).toBe(77);
  });

  it('resolves single-print cards to themselves', () => {
    const card = makeCard({ id: 5 });
    const { canonicalByGroup, alias } = buildCanonicalRegistry([card]);
    expect(canonicalByGroup.get(card.groupKey)!.id).toBe(5);
    expect(alias.get(5)).toBe(5);
  });

  it('tiebreaks equal release dates by highest set code', () => {
    const set1 = { ...makeCard({ id: 1, name: 'Maleficent' }), setCode: '1' };
    const set9 = { ...makeCard({ id: 2, name: 'Maleficent' }), setCode: '9' };
    const { canonicalByGroup } = buildCanonicalRegistry([set1, set9]);
    expect(canonicalByGroup.get(set1.groupKey)!.id).toBe(2);
  });

  it('prefers the promo print when it released later', () => {
    const core = withRelease(
      { ...makeCard({ id: 10, name: 'Hades' }), setCode: '4' },
      '2024-05-17',
    );
    const promo = withRelease(
      { ...makeCard({ id: 90, name: 'Hades' }), setCode: 'P1' },
      '2024-08-09',
    );
    const { canonicalByGroup } = buildCanonicalRegistry([core, promo]);
    // 2024-08-09 beats 2024-05-17 regardless of set code ordering
    expect(canonicalByGroup.get(core.groupKey)!.id).toBe(90);
  });

  it('snapshot spot-check: every real multi-print group aliases to its newest print', () => {
    const snap = JSON.parse(
      readFileSync(
        path.join(__dirname, '..', '..', 'public', 'data', 'cards.min.json'),
        'utf8',
      ),
    ) as { cards: Card[] };
    const { canonicalByGroup, alias } = buildCanonicalRegistry(snap.cards);
    const groups = new Map<string, Card[]>();
    for (const c of snap.cards)
      (
        groups.get(c.groupKey) ?? groups.set(c.groupKey, []).get(c.groupKey)!
      ).push(c);
    const multi = [...groups.entries()].filter(
      ([, prints]) => prints.length > 1,
    );
    expect(multi.length).toBeGreaterThan(0);
    let compared = 0;
    for (const [groupKey, prints] of multi) {
      const canonical = canonicalByGroup.get(groupKey)!;
      for (const print of prints) {
        expect(alias.get(print.id)).toBe(canonical.id);
        const newer =
          (print.releasedAt ?? '') > (canonical.releasedAt ?? '') ||
          ((print.releasedAt ?? '') === (canonical.releasedAt ?? '') &&
            Number(print.setCode) > Number(canonical.setCode));
        expect(
          newer,
          `print ${print.id} of ${groupKey} is newer than canonical ${canonical.id}`,
        ).toBe(false);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(600); // 661 multi-print groups in the current snapshot
  });
});
