/**
 * Single SSE subscriber for the whole client.
 *
 * Opens one EventSource against /api/events when the app boots.
 * Maps the three server event types into TanStack Query cache
 * mutations:
 *
 *   skill_changed     → invalidate ["skill", name] AND ["skills"]
 *   provider_changed  → invalidate ["skills"]   (drift may have shifted)
 *   activity          → append to ["activity"].entries and invalidate
 *
 * Also tracks readiness (EventSource readyState === 1) and exposes
 * a `useSseReady()` hook so components can gate UI affordances
 * (e.g., the Activity panel's "No recent activity" empty state)
 * on the connection actually being open.
 *
 * The browser's EventSource auto-reconnects on transport drop. v1 has
 * no event ID / replay, so on reconnect the relevant query keys
 * naturally re-fetch via TanStack's invalidation.
 */

import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ActivityEntry } from "./types";

interface OpenedStream {
  readonly source: EventSource;
  close(): void;
}

// ── Readiness state (module-singleton; one EventSource per page) ──

let isReady = false;
const readyListeners = new Set<() => void>();

function setReady(next: boolean): void {
  if (isReady === next) return;
  isReady = next;
  // Fire all subscribers — useSyncExternalStore re-evaluates getSnapshot.
  for (const l of readyListeners) {
    try {
      l();
    } catch (err) {
      console.error("[sse] ready listener threw:", err);
    }
  }
}

function subscribeReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

function getReadySnapshot(): boolean {
  return isReady;
}

/**
 * React hook: returns true once the SSE EventSource is OPEN.
 * Toggles back to false on transport error and back to true on the
 * browser's automatic reconnect.
 *
 * Components MUST be inside the React tree to call this hook.
 */
export function useSseReady(): boolean {
  return useSyncExternalStore(subscribeReady, getReadySnapshot, () => false);
}

// ── Stream open + dispatch ─────────────────────────────────────

/** Open the singleton stream. Safe to call once at app startup. */
export function openEventStream(queryClient: QueryClient): OpenedStream {
  const source = new EventSource("/api/events");

  source.addEventListener("open", () => {
    setReady(true);
  });

  source.addEventListener("skill_changed", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { name: string };
      if (data?.name) {
        queryClient.invalidateQueries({ queryKey: ["skill", data.name] });
      }
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    } catch (err) {
      console.error("[sse] bad skill_changed payload:", err);
    }
  });

  source.addEventListener("provider_changed", (_e) => {
    // Drift may have shifted on any skill targeting this provider —
    // simplest correct invalidation is the whole list.
    queryClient.invalidateQueries({ queryKey: ["skills"] });
  });

  source.addEventListener("activity", (e) => {
    try {
      const entry = JSON.parse((e as MessageEvent).data) as ActivityEntry;
      // Append to the cached list so the Activity panel updates
      // without a network round-trip.
      queryClient.setQueryData<{ entries: ActivityEntry[] } | undefined>(
        ["activity"],
        (prev) => {
          const existing = prev?.entries ?? [];
          return { entries: [...existing, entry] };
        },
      );
      // Belt-and-braces: also invalidate so any consumer that wants
      // a strict re-fetch gets one.
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    } catch (err) {
      console.error("[sse] bad activity payload:", err);
    }
  });

  source.addEventListener("suggestions_changed", () => {
    // Background sweep finished or a dismissal happened in another tab —
    // the panel's "For you" list and the sidebar badge re-fetch.
    queryClient.invalidateQueries({ queryKey: ["assistant-suggestions"] });
  });

  source.onerror = (err) => {
    // EventSource auto-reconnects; flip readiness off until the next
    // 'open' event so UI gates re-engage.
    setReady(false);
    console.warn("[sse] stream error (browser will reconnect):", err);
  };

  return {
    source,
    close() {
      source.close();
      setReady(false);
    },
  };
}
