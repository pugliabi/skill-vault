/**
 * App-level endpoints (about the app itself, not the vault):
 *
 *   GET  /api/health           — who is serving: pid, port, build version, mode.
 *                                scripts/launch.ps1 uses it to reuse a running
 *                                server; the client uses it to spot the new
 *                                process after an update.
 *   GET  /api/app/update       — update status (services/appUpdate.ts)
 *   POST /api/app/update/check — fetch now and return the fresh status
 *   POST /api/app/update       — apply; streams NDJSON ApplyEvents, ending
 *                                with {step:"restart"} on success
 */
import { Router } from "express";
import type { AppUpdater } from "../services/appUpdate.ts";

export interface HealthInfo {
  ok: true;
  pid: number;
  port: number | null;
  version: string;
  mode: "development" | "production";
}

export function appRouter(opts: { health: () => HealthInfo; updater: AppUpdater }): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json(opts.health());
  });

  router.get("/app/update", (_req, res) => {
    res.json(opts.updater.status());
  });

  router.post("/app/update/check", async (_req, res) => {
    res.json(await opts.updater.check());
  });

  router.post("/app/update", async (_req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    await opts.updater.apply((e) => res.write(`${JSON.stringify(e)}\n`));
    res.end();
  });

  return router;
}
