import { Router } from "express";
import path from "node:path";
import { readAppConfig } from "../services/appConfig.ts";
import { skillDir } from "../services/vault.ts";
import { computeSkillDiff } from "../services/diff.ts";

/**
 * GET /api/diff?skill=<name>&provider_id=<id>
 *   → SkillDiff (file-level changes between vault and provider copy)
 *
 * Used by the Conflict Resolution drawer: when a target is `stale`,
 * the user can preview exactly what changed before deciding whether
 * to push (vault wins) or pull (provider wins).
 */
export function diffRouter(): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const skill = (req.query.skill as string | undefined)?.trim();
    const providerId = (req.query.provider_id as string | undefined)?.trim();
    if (!skill || !providerId) {
      res.status(400).json({ error: "skill and provider_id query params are required" });
      return;
    }
    const provider = cfg.providers.find((p) => p.id === providerId);
    if (!provider) {
      res.status(404).json({ error: `unknown provider: ${providerId}` });
      return;
    }
    const vaultDir = skillDir(cfg.vault_path, skill);
    const targetDir = path.join(provider.path, skill);
    res.json(computeSkillDiff(vaultDir, targetDir));
  });

  return router;
}
