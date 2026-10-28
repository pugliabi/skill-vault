/**
 * First-run setup guide endpoints (mounted at /api/setup). Design:
 * docs/superpowers/specs/2026-10-27-setup-guide-design.md. Every write is
 * refused when a browser marks it as coming from another site.
 *
 *   GET    /capabilities   { folder_dialog } — Windows + a request from this PC
 *   GET    /draft          { draft, stale } — the saved draft, and whether config changed since
 *   POST   /draft/start    { draft } — start a draft pre-filled from config
 *   PUT    /draft          { draft } — save the draft (400 if malformed)
 *   DELETE /draft          204 — discard the draft
 *   POST   /inspect        { path } — what a picked folder holds (empty, vault, git repo, ...)
 *   GET    /targets        { targets } — the known tools and whether each is on this PC
 *   POST   /clone-preview  { url } → { candidates } — look inside a vault repo, keeping no copy
 */
import os from "node:os";
import { Router } from "express";
import { readAppConfig, readSetupBase } from "../services/appConfig.ts";
import { defaultRun, type Run } from "../services/appUpdate.ts";
import { configFingerprint, deleteDraft, normalizeDraft, readDraft, startDraft, writeDraft } from "../services/setup/draft.ts";
import { CloneError, isCloneUrl, previewClone } from "../services/setup/clonePreview.ts";
import { inspectFolder } from "../services/setup/inspect.ts";
import { detectTargets } from "../services/setup/targets.ts";
import type { SetupBase } from "../services/setup/types.ts";
import type { AppConfig } from "../types/vault.ts";
import { isLoopbackRequest, refuseCrossSiteWrites } from "./sameOrigin.ts";

export interface SetupRouterDeps {
  platform?: NodeJS.Platform;
  /** Home folder for the draft file (tests pass a temp folder). */
  home?: () => string;
  /** Current config fields the guide starts from. */
  readBase?: () => SetupBase;
  /** Current app config (providers, default targets). */
  readConfig?: () => AppConfig;
  /** Runs git (tests pass a fake). */
  run?: Run;
  /** Parent folder for temporary clone previews (default: the OS temp folder). */
  tmpRoot?: string;
}

export function setupRouter(deps: SetupRouterDeps = {}): Router {
  const router = Router();
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? (() => os.homedir());
  const readBase = deps.readBase ?? readSetupBase;
  const run = deps.run ?? defaultRun;
  const readConfig = deps.readConfig ?? readAppConfig;
  router.use(refuseCrossSiteWrites);

  router.get("/capabilities", (req, res) => {
    res.json({ folder_dialog: platform === "win32" && isLoopbackRequest(req) });
  });

  router.get("/draft", (_req, res) => {
    const draft = readDraft(home());
    res.json({ draft, stale: draft ? draft.base !== configFingerprint(readBase()) : false });
  });

  router.post("/draft/start", (_req, res) => {
    const draft = startDraft(readBase());
    writeDraft(draft, home());
    res.json({ draft });
  });

  router.put("/draft", (req, res) => {
    let draft;
    try {
      draft = normalizeDraft(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    writeDraft(draft, home());
    res.json({ draft });
  });

  router.delete("/draft", (_req, res) => {
    deleteDraft(home());
    res.status(204).end();
  });

  router.post("/inspect", async (req, res) => {
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== "string" || !p.trim()) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    res.json(await inspectFolder(p.trim(), { run }));
  });

  router.get("/targets", (_req, res) => {
    res.json({ targets: detectTargets(home(), readConfig()) });
  });

  router.post("/clone-preview", async (req, res) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || !isCloneUrl(url)) {
      res.status(400).json({ error: "Enter an https://, ssh:// or git@ URL." });
      return;
    }
    try {
      res.json({ candidates: await previewClone(url.trim(), { run, tmpRoot: deps.tmpRoot }) });
    } catch (err) {
      if (err instanceof CloneError) res.status(400).json({ error: err.message });
      else res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
