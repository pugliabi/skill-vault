import { Router } from "express";
import path from "node:path";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { skillDir, readManifest, writeManifest } from "../services/vault.ts";
import { linkSkillDir } from "../services/linking.ts";
import type { PushRequest, PushResult } from "../types/vault.ts";

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

    const source = skillDir(cfg.vault_path, body.skill);
    const target = path.join(provider.path, body.skill);
    const forceCopy = body.method === "copy";

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
      const result = linkSkillDir(source, target, { forceCopy });

      if (result.method === "skip") {
        recordActivity({
          kind: "push",
          skill: body.skill,
          provider_id: body.provider_id,
          ok: false,
          message: result.reason ?? "skipped (circular or invalid path)",
        });
        res.status(409).json({
          error: result.reason ?? "skipped (circular or invalid path)",
        });
        return;
      }

      // Record the push in the manifest: add provider_id to `targets`
      // if not already there.
      const manifest = readManifest(cfg.vault_path);
      const entry = manifest.skills[body.skill] ?? { targets: [] };
      if (!entry.targets.includes(provider.id)) {
        entry.targets = [...entry.targets, provider.id];
        manifest.skills[body.skill] = entry;
        writeManifest(cfg.vault_path, manifest);
      }

      recordActivity({
        kind: "push",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: true,
        message: `linked via ${result.method}`,
      });

      const out: PushResult = {
        skill: body.skill,
        target_path: result.target,
        method: result.method as "symlink" | "junction" | "copy",
      };
      res.json(out);
    } catch (err) {
      recordActivity({
        kind: "push",
        skill: body.skill,
        provider_id: body.provider_id,
        ok: false,
        message: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
