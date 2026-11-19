import { describe, expect, it } from 'vitest';
import { parseDetail } from './lorcanahunter-scrape';

// trimmed detail page with the two observed W-L-D layouts: inline in the
// standing/player cell, and in a separate record cell
const DETAIL_HTML = `<html><body>
<h1>Weekly Lorcana</h1>
<span>CORE</span>
<script type="application/ld+json">{"startDate":"2026-10-04","maximumAttendeeCapacity":16}</script>
<div id="players"><table>
<tr><th>#</th><th>Player</th><th>Record</th></tr>
<tr><td>#1 <a href="/player/42/profile">Alice</a> 5-1-0</td><td></td><td></td>
<td><a href="/player/42/deck?event=99&amp;tab=cards">deck</a></td></tr>
<tr><td>#2 Bob</td><td>ignored</td><td>4-2-0</td></tr>
</table></div>
</body></html>`;

describe('parseDetail', () => {
  it('parses metadata and standings across both W-L-D layouts', () => {
    const detail = parseDetail(DETAIL_HTML);
    expect(detail.name).toBe('Weekly Lorcana');
    expect(detail.date).toBe('2026-10-04');
    expect(detail.playerCount).toBe(16);
    expect(detail.format).toBe('CORE');
    expect(detail.rows).toEqual([
      {
        standing: 1,
        player: 'Alice',
        wins: 5,
        losses: 1,
        draws: 0,
        deckHref: '/player/42/deck?event=99&tab=cards',
      },
      {
        standing: 2,
        player: 'Bob',
        wins: 4,
        losses: 2,
        draws: 0,
        deckHref: null,
      },
    ]);
  });

  it('returns empty rows when the players table is missing', () => {
    const detail = parseDetail('<h1>Empty</h1>');
    expect(detail.rows).toEqual([]);
    expect(detail.date).toBe('');
    expect(detail.format).toBeNull();
  });
});
