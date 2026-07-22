import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { auditVault } from "../services/audit.ts";
import { readManifest, writeManifest, upsertManifestSkill } from "../services/vault.ts";
import { linkSkillDir } from "../services/linking.ts";

export function fixRouter(): Router {
  const r = Router();

  r.post("/audit", (_req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const issues = auditVault(config.vault_path, config.providers);
    res.json({ issues });
  });

  r.post("/repair", (req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const { kind, target, action } = req.body;
    if (!kind || !target || !action) {
      return res.status(400).json({ error: "kind, target, and action are required" });
    }

    try {
      if (kind === "orphan_folder" && action === "remove_folder") {
        fs.rmSync(target, { recursive: true, force: true });
      } else if (kind === "orphan_folder" && action === "add_to_manifest") {
        const name = path.basename(target);
        upsertManifestSkill(config.vault_path, name, {
          targets: [],
          stage: "production",
          source: "audit:added",
        });
      } else if (kind === "dangling_entry" && action === "remove_from_manifest") {
        const manifest = readManifest(config.vault_path);
        delete manifest.skills[target];
        writeManifest(config.vault_path, manifest);
      } else if (kind === "broken_link" && action === "remove_link") {
        fs.unlinkSync(target);
      } else if (kind === "broken_link" && action === "recreate_link") {
        const name = path.basename(target);
        const skillSource = path.join(config.vault_path, "skills", name);
        if (!fs.existsSync(skillSource)) {
          return res.status(400).json({ error: `Skill folder not found: ${name}` });
        }
        try { fs.unlinkSync(target); } catch { /* already gone */ }
        const providerDir = path.dirname(target);
        linkSkillDir(skillSource, path.join(providerDir, name));
      } else {
        return res.status(400).json({ error: `Unknown repair: ${kind}/${action}` });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}
