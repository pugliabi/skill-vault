import fs from "node:fs";
import { Router } from "express";
import open from "open";
import {
  readAppConfig,
  readClaudeDesktopStage,
  setClaudeDesktopStage,
} from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import {
  defaultStageDir,
  packageForClaudeDesktop,
} from "../services/desktopPackaging.ts";
import type { DesktopPackageResult } from "../types/vault.ts";

/**
 * Claude Desktop — a *package* target, not a link target.
 *
 *   POST /api/desktop          { skill } → build upload-ready zip in stage dir
 *   POST /api/desktop/reveal   open the stage dir in the OS file manager
 *   PUT  /api/desktop/stage    { path } → set claude_desktop_stage in CLI config
 *
 * Why no symlink/junction like other providers: Claude Desktop has no
 * local skills directory (skills live in the user's claude.ai account)
 * and no upload API. The zip in the stage dir is the closest possible
 * automation; the user uploads it via Settings → Capabilities → Skills.
 *
 * Deliberately does NOT write "claude-desktop" into skills.json targets:
 * the Python `sv push` would try to junction into the stage dir for any
 * unknown-to-it target. Teaching the CLI about package-targets is
 * tracked in .planning/claude-desktop-target.md.
 */
export function desktopRouter(): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { skill?: unknown };
    const skill = typeof body.skill === "string" ? body.skill.trim() : "";
    if (!skill) {
      res.status(400).json({ error: "skill is required" });
      return;
    }

    const stageDir =
      readClaudeDesktopStage() ?? defaultStageDir(cfg.vault_path);

    recordActivity({
      kind: "push",
      skill,
      provider_id: "claude-desktop",
      ok: true,
      message: "starting",
    });

    try {
      const zipPath = await packageForClaudeDesktop(
        cfg.vault_path,
        stageDir,
        skill,
      );
      recordActivity({
        kind: "push",
        skill,
        provider_id: "claude-desktop",
        ok: true,
        message: "packaged upload-ready zip",
      });
      const out: DesktopPackageResult = {
        skill,
        zip_path: zipPath,
        stage_dir: stageDir,
      };
      res.json(out);
    } catch (err) {
      const msg = (err as Error).message;
      recordActivity({
        kind: "push",
        skill,
        provider_id: "claude-desktop",
        ok: false,
        message: msg,
      });
      res.status(msg.includes("not found") ? 404 : 500).json({ error: msg });
    }
  });

  router.post("/reveal", async (_req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const stageDir =
      readClaudeDesktopStage() ?? defaultStageDir(cfg.vault_path);
    fs.mkdirSync(stageDir, { recursive: true });
    await open(stageDir);
    res.json({ ok: true, stage_dir: stageDir });
  });

  router.put("/stage", (req, res) => {
    const body = req.body as { path?: unknown };
    const p = typeof body.path === "string" ? body.path.trim() : "";
    if (!p) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const cfg = setClaudeDesktopStage(p);
    res.json(cfg);
  });

  return router;
}
