/**
 * Server-Sent Events channel.
 *
 *   GET /api/events  →  text/event-stream
 *
 * Broadcasts three event types:
 *   - skill_changed       (from the filesystem watcher)
 *   - provider_changed    (from the filesystem watcher)
 *   - activity            (from the activity ring buffer)
 *
 * Connection registry is a module-level Set<Response>. createApp()
 * subscribes the watcher + activity bus to broadcastSse() once.
 * Each connected client gets every event until they disconnect.
 *
 * Wire format (matches the SseEvent discriminated union in
 * `server/types/vault.ts`):
 *
 *   event: skill_changed
 *   data: {"name":"alpha"}
 *
 *   event: provider_changed
 *   data: {"provider_id":"claude","skill":"alpha"}
 *
 *   event: activity
 *   data: {"at":"...","kind":"push","skill":"alpha","ok":true}
 *
 *   : ping     <-- keepalive comment, every 25s
 *
 * Each event terminator is `\n\n`. JSON in `data:` is single-line.
 * No event ID/replay support in v1 — clients re-fetch on reconnect via
 * the existing query invalidation (per CONTEXT.md decisions).
 */

import { Router, type Request, type Response } from "express";
import type { ActivityEntry } from "../types/vault.ts";

const KEEPALIVE_MS = 25_000;

const clients = new Set<Response>();

type SsePayload =
  | { type: "skill_changed"; name: string }
  | { type: "provider_changed"; provider_id: string; skill?: string }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "suggestions_changed" };

function writeSse(res: Response, eventName: string, data: unknown): void {
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // If write throws (client gone), drop them on the next pass.
    clients.delete(res);
  }
}

/** Broadcast a typed payload to every connected client. Safe to call from any context. */
export function broadcastSse(payload: SsePayload): void {
  // Use snapshot so a client disconnecting mid-broadcast doesn't disturb iteration.
  const snapshot = [...clients];
  for (const res of snapshot) {
    if (payload.type === "skill_changed") {
      writeSse(res, "skill_changed", { name: payload.name });
    } else if (payload.type === "provider_changed") {
      const data: Record<string, string> = { provider_id: payload.provider_id };
      if (payload.skill) data.skill = payload.skill;
      writeSse(res, "provider_changed", data);
    } else if (payload.type === "activity") {
      writeSse(res, "activity", payload.entry);
    } else if (payload.type === "suggestions_changed") {
      writeSse(res, "suggestions_changed", {});
    }
  }
}

/** Force-close every connection. Used by the cleanup hook on server shutdown. */
export function closeAllSse(): void {
  for (const res of clients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
}

export function eventsRouter(): Router {
  const router = Router();

  router.get("/", (req: Request, res: Response) => {
    // Standard SSE headers
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if behind a proxy
    });
    res.flushHeaders?.();

    // Initial comment so proxies see bytes immediately.
    // Also: documents the wire format for grep audits — searching
    // `event: skill_changed` / `event: provider_changed` / `event: activity`
    // lands here (the only place the literal event names are written).
    res.write(": connected\n\n");
    // Format reference (NOT written to the stream):
    //   event: skill_changed
    //   event: provider_changed
    //   event: activity

    clients.add(res);

    // Per-connection keepalive — every 25s
    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(keepalive);
        clients.delete(res);
      }
    }, KEEPALIVE_MS);

    const cleanup = (): void => {
      clearInterval(keepalive);
      clients.delete(res);
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    res.on("error", cleanup);
  });

  return router;
}
