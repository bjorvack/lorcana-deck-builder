import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadSyncState,
  markPending,
  PENDING_MAX_ATTEMPTS,
  recordEvent,
  retryablePending,
  type SyncState,
  saveSyncState,
  seedFromDataset,
  windowStart,
} from './sync-state';

const state = (lastEventDate: string): SyncState => ({
  lastSyncedAt: '2026-11-01T00:00:00Z',
  lastEventDate,
  pending: [],
  events: {},
});

describe('windowStart', () => {
  it('subtracts the 7-day overlap across a month boundary', () => {
    expect(windowStart(state('2026-03-01'))).toBe('2026-02-22');
  });

  it('subtracts the 7-day overlap across a year boundary', () => {
    expect(windowStart(state('2026-01-05'))).toBe('2025-12-29');
  });

  it('returns null for a full backfill (no state or no last event date)', () => {
    expect(windowStart(null)).toBeNull();
    expect(windowStart(state(''))).toBeNull();
  });
});

describe('recordEvent / markPending', () => {
  it('advances lastEventDate only forward and clears the pending entry', () => {
    const s = state('2026-01-10');
    s.pending.push({ id: 'e1', reason: 'private', attempts: 2 });
    recordEvent(s, 'e1', {
      date: '2026-01-08',
      decklistCount: 12,
      complete: true,
    });
    expect(s.lastEventDate).toBe('2026-01-10'); // older event: unchanged
    expect(s.pending).toEqual([]);
    recordEvent(s, 'e2', {
      date: '2026-01-20',
      decklistCount: 8,
      complete: true,
    });
    expect(s.lastEventDate).toBe('2026-01-20');
  });

  it('increments attempts and caps retryable pending', () => {
    const s = state('2026-01-01');
    for (let i = 0; i < PENDING_MAX_ATTEMPTS; i++)
      markPending(s, 'e1', 'in-progress');
    expect(s.pending[0]!.attempts).toBe(PENDING_MAX_ATTEMPTS);
    expect(retryablePending(s)).toEqual([]);
    markPending(s, 'e2', 'incomplete');
    expect(retryablePending(s).map((p) => p.id)).toEqual(['e2']);
  });
});

describe('seedFromDataset', () => {
  it('marks every dataset event complete and starts at the newest date', () => {
    const s = seedFromDataset('2026-11-01', [
      { eventId: 'a', date: '2025-12-01', entries: [] },
      { eventId: 'b', date: '2026-02-01', entries: [{}, {}] },
    ]);
    expect(s.lastEventDate).toBe('2026-02-01');
    expect(s.events.a!.complete).toBe(true);
    expect(s.events.b!.decklistCount).toBe(2);
    expect(s.pending).toEqual([]);
    // the first incremental run starts inside the overlap, not a full backfill
    expect(windowStart(s)).toBe('2026-01-25');
  });
});

describe('sync state persistence', () => {
  it('normalizes invalid pending data through a load/save round trip', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ldb-sync-state-'));
    try {
      const stored = {
        lastSyncedAt: '2026-01-01T00:00:00.000Z',
        lastEventDate: '2026-01-01',
        pending: { invalid: true },
        events: {},
      };
      const statePath = path.join(dir, 'state.json');
      await writeFile(statePath, JSON.stringify(stored));

      const loaded = await loadSyncState(dir);
      const expected = { ...stored, pending: [] };
      expect(loaded).toEqual(expected);
      if (!loaded) throw new Error('expected sync state to load');

      await saveSyncState(dir, loaded);

      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(expected);
      expect(await loadSyncState(dir)).toEqual(expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
