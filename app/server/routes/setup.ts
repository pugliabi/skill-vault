/**
 * First-run setup guide endpoints (mounted at /api/setup). Design:
 * docs/superpowers/specs/2026-10-27-setup-guide-design.md. Every write is
 * refused when a browser marks it as coming from another site.
 *
 *   GET  /capabilities   { folder_dialog } — Windows + a request from this PC
 */
import { Router } from "express";
import { isLoopbackRequest, refuseCrossSiteWrites } from "./sameOrigin.ts";

export interface SetupRouterDeps {
  platform?: NodeJS.Platform;
}

export function setupRouter(deps: SetupRouterDeps = {}): Router {
  const router = Router();
  const platform = deps.platform ?? process.platform;
  router.use(refuseCrossSiteWrites);

  router.get("/capabilities", (req, res) => {
    res.json({ folder_dialog: platform === "win32" && isLoopbackRequest(req) });
  });

  return router;
}
