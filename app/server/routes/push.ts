import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { PushSkipError, pushSkillToProvider } from "../services/pushSkill.ts";
import type { PushRequest } from "../types/vault.ts";

/**
 * Push a single skill to a single provider. Creates a symlink (or
 * junction, or copy — in that fallback order) from the provider's
 * skills directory into the vault's copy of the skill.
 *
 * Also records the push in the skill's `targets` list in `skills.json`
 * so the browser UI reflects which providers a skill is wired up to.
 */
export function pushRouter(): Router {
  const router = Router();

  router.post("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }

    const body = req.body as PushRequest;
    if (!body.skill || !body.provider_id) {
      res.status(400).json({ error: "skill and provider_id are required" });
      return;
    }

    const provider = cfg.providers.find((p) => p.id === body.provider_id);
    if (!provider) {
      res
        .status(404)
        .json({ error: `unknown provider: ${body.provider_id}` });
      return;
    }

    // Starting record — emitted BEFORE the mutation so the SSE
    // `activity` event arrives ahead of any `provider_changed` event the
    // watcher may emit as a side effect of linkSkillDir creating files
    // in the provider's directory. See CONTEXT.md `<code_context>`:
    // "Order: log activity → perform mutation → response."
    recordActivity({
      kind: "push",
      skill: body.skill,
      provider_id: body.provider_id,
      ok: true,
      message: "starting",
    });

    try {
      const out = pushSkillToProvider(cfg.vault_path, body.skill, provider, { forceCopy: body.method === "copy" });
      recordActivity({
        kind: "push",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: true,
        message: `linked via ${out.method}`,
      });
      res.json(out);
    } catch (err) {
      recordActivity({
        kind: "push",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: false,
        message: (err as Error).message,
      });
      res.status(err instanceof PushSkipError ? 409 : 500).json({ error: (err as Error).message });
    }
  });

  return router;
}
