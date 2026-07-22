/**
 * In-memory activity ring buffer.
 *
 * Records every push/pull/adopt/promote/demote/remove the API performs,
 * keyed only in process memory (capped at ACTIVITY_RING_SIZE entries).
 * Persistence is intentionally out of scope for v1 — see PERSIST-01.
 *
 * Two consumers:
 *   1. `GET /api/activity`        — returns listActivity() as JSON
 *   2. The SSE channel            — subscribes once on createApp() and
 *                                   broadcasts each new entry as
 *                                   `event: activity\ndata: {...}\n\n`
 */

import type { ActivityEntry } from "../types/vault.ts";

export const ACTIVITY_RING_SIZE = 200;

type Listener = (entry: ActivityEntry) => void;

const buffer: ActivityEntry[] = [];
const listeners = new Set<Listener>();

/**
 * Record one activity entry. Stamps `at` with the current ISO time,
 * pushes onto the ring (dropping the oldest if at capacity), then
 * fires every subscribed listener synchronously.
 *
 * Listener exceptions are logged and swallowed so a buggy SSE
 * subscriber cannot break the route handler that called record.
 */
export function recordActivity(
  partial: Omit<ActivityEntry, "at">,
): ActivityEntry {
  const entry: ActivityEntry = { at: new Date().toISOString(), ...partial };
  buffer.push(entry);
  if (buffer.length > ACTIVITY_RING_SIZE) {
    buffer.splice(0, buffer.length - ACTIVITY_RING_SIZE);
  }
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (err) {
      console.error("[activity] listener threw:", err);
    }
  }
  return entry;
}

/** Snapshot of the buffer in append order (oldest first). New array each call. */
export function listActivity(): ActivityEntry[] {
  return buffer.slice();
}

/** Subscribe to every future record(). Returns an unsubscribe function. */
export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** TEST-ONLY: clear the buffer and listeners. Not exported in production paths. */
export function __resetActivityForTests(): void {
  buffer.length = 0;
  listeners.clear();
}
