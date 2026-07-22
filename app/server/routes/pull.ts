import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { pullSkill } from "../services/pull.ts";

/**
 * POST /api/pull
 *   { skill: string, provider_id: string }
 *
 * Copies <provider.path>/<skill> back into <vault>/skills/<skill>,
 * overwriting any vault copy. Used when a skill drifted in the
 * provider's directory and the user wants to keep that version.
 */
export function pullRouter(): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { skill?: string; provider_id?: string };
    if (!body.skill || !body.provider_id) {
      res.status(400).json({ error: "skill and provider_id are required" });
      return;
    }
    const provider = cfg.providers.find((p) => p.id === body.provider_id);
    if (!provider) {
      res.status(404).json({ error: `unknown provider: ${body.provider_id}` });
      return;
    }
    // Starting record — emitted BEFORE pullSkill so the SSE `activity`
    // event arrives ahead of any vault-side `skill_changed` the copy
    // would otherwise be the first signal of.
    recordActivity({
      kind: "pull",
      skill: body.skill,
      provider_id: body.provider_id,
      ok: true,
      message: "starting",
    });
    try {
      const result = pullSkill(cfg.vault_path, provider, body.skill);
      recordActivity({
        kind: "pull",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: true,
        message: result.action,
      });
      res.json(result);
    } catch (err) {
      recordActivity({
        kind: "pull",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: false,
        message: (err as Error).message,
      });
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
