/**
 * App-level endpoints (about the app itself, not the vault):
 *
 *   GET /api/health — who is serving: pid, port, build version, mode.
 *                     scripts/launch.ps1 uses it to reuse a running server;
 *                     the client uses it to spot the new process after an update.
 */
import { Router } from "express";

export interface HealthInfo {
  ok: true;
  pid: number;
  port: number | null;
  version: string;
  mode: "development" | "production";
}

export function appRouter(opts: { health: () => HealthInfo }): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json(opts.health());
  });
  return router;
}
