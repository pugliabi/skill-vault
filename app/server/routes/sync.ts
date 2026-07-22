import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { computeSyncPlan } from "../services/syncPlan.ts";

/**
 * GET /api/sync/plan[?include_pulls=true]
 *   → { push: [...], pull: [...], adopt: [...], promote: [...] }
 *
 * The UI runs each item via the existing /api/push, /api/pull,
 * /api/adopt/import, and /api/skills/:name PATCH endpoints — there's
 * no /api/sync execute route on purpose. Letting the client orchestrate
 * keeps the server stateless and lets the user pick-and-choose.
 */
export function syncRouter(): Router {
  const router = Router();

  router.get("/plan", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const includePulls = req.query.include_pulls === "true";
    res.json(computeSyncPlan(cfg.vault_path, cfg.providers, includePulls));
  });

  return router;
}
