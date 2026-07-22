/**
 * GET /api/activity
 *
 * Returns a snapshot of the in-memory activity ring buffer
 * (at most ACTIVITY_RING_SIZE entries, oldest first).
 *
 * The client uses this on first load to seed the Activity panel,
 * then subscribes to `/api/events` for live updates (Plan 05).
 *
 * The ring buffer itself lives in `services/activity.ts` (Plan 01).
 * This router only adapts it to the HTTP boundary.
 */

import { Router } from "express";
import { listActivity } from "../services/activity.ts";

export function activityRouter(): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.json({ entries: listActivity() });
  });
  return router;
}
