import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Committed sync state for the incremental tournament fetchers. Lives in the
 * repo (not .data-cache) because the weekly sync runs in GitHub Actions where
 * the workspace is ephemeral — git is the persistence layer.
 *
 * Event caches (events/<id>.json) are the immutable source of truth: once an
 * event's decklists are public and final they never change, so completed
 * events are never refetched. The derived dataset is rebuilt by merging the
 * cached events.
 */

export interface PendingEvent {
  id: string;
  /** why it is pending: in-progress, private, incomplete */
  reason: 'in-progress' | 'private' | 'incomplete';
  attempts: number;
}

export interface SyncEventInfo {
  date: string;
  decklistCount: number;
  complete: boolean;
}

export interface SyncState {
  lastSyncedAt: string;
  /** newest event date seen — the listing window starts here minus the overlap */
  lastEventDate: string;
  pending: PendingEvent[];
  events: Record<string, SyncEventInfo>;
}

export const PENDING_MAX_ATTEMPTS = 5;
export const OVERLAP_DAYS = 7;

export async function loadSyncState(dir: string): Promise<SyncState | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as SyncState;
    if (typeof raw.lastEventDate !== 'string' || typeof raw.events !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export async function saveSyncState(dir: string, state: SyncState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 1));
}

/**
 * Fresh state seeded from an existing dataset, so the first incremental run
 * after a full backfill does not re-enumerate history: every dataset event
 * becomes a completed cache entry and the window starts at the newest date.
 */
export function seedFromDataset(
  fetchedOn: string,
  tournaments: { eventId: string; date: string; entries: unknown[] }[]
): SyncState {
  const events: Record<string, SyncEventInfo> = {};
  let lastEventDate = '';
  for (const t of tournaments) {
    events[t.eventId] = { date: t.date, decklistCount: t.entries.length, complete: true };
    if (t.date > lastEventDate) lastEventDate = t.date;
  }
  return { lastSyncedAt: fetchedOn, lastEventDate, pending: [], events };
}

/** listing window start: newest seen event minus the overlap; null = full backfill */
export function windowStart(state: SyncState | null, overlapDays = OVERLAP_DAYS): string | null {
  if (!state || !state.lastEventDate) return null;
  const d = new Date(`${state.lastEventDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - overlapDays);
  return d.toISOString().slice(0, 10);
}

export function recordEvent(state: SyncState, id: string, info: SyncEventInfo): void {
  state.events[id] = info;
  state.pending = state.pending.filter((p) => p.id !== id);
  if (info.date > state.lastEventDate) state.lastEventDate = info.date;
}

export function markPending(state: SyncState, id: string, reason: PendingEvent['reason']): void {
  const existing = state.pending.find((p) => p.id === id);
  if (existing) {
    existing.attempts++;
    existing.reason = reason;
  } else {
    state.pending.push({ id, reason, attempts: 1 });
  }
}

/** pending events still worth retrying (under the attempt cap) */
export const retryablePending = (state: SyncState): PendingEvent[] =>
  state.pending.filter((p) => p.attempts < PENDING_MAX_ATTEMPTS);
