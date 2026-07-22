import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import {
  countOpenClawSkills,
  detectOpenClaw,
  exportSkillToOpenClaw,
} from "../services/openclaw.ts";

/**
 * OpenClaw — an *export* target, not a link/package target.
 *
 *   GET  /api/openclaw/status   → { available, distro, installed? }
 *   POST /api/openclaw/export   { skill, global?, force? } → install into the distro
 *
 * OpenClaw lives in a locked-down WSL distro with no filesystem bridge, so
 * (unlike claude/cursor/copilot) it is never written into skills.json
 * targets or agent_locations. Export shells to `openclaw skills install`
 * inside the distro — see services/openclaw.ts for the rationale.
 */
export function openclawRouter(): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    const status = detectOpenClaw();
    const installed = status.available ? countOpenClawSkills() : undefined;
    res.json({ ...status, installed });
  });

  router.post("/export", async (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    if (!detectOpenClaw().available) {
      res.status(501).json({ error: "OpenClaw not available on this machine" });
      return;
    }
    const body = (req.body ?? {}) as {
      skill?: unknown;
      global?: unknown;
      force?: unknown;
    };
    const skill = typeof body.skill === "string" ? body.skill.trim() : "";
    if (!skill) {
      res.status(400).json({ error: "skill is required" });
      return;
    }

    try {
      const result = await exportSkillToOpenClaw(cfg.vault_path, skill, {
        global: body.global === true,
        force: body.force === true,
      });
      recordActivity({
        kind: "push",
        skill,
        provider_id: "openclaw",
        ok: true,
        message: "installed via openclaw skills install",
      });
      res.json(result);
    } catch (err) {
      const msg = (err as Error).message;
      recordActivity({
        kind: "push",
        skill,
        provider_id: "openclaw",
        ok: false,
        message: msg,
      });
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
