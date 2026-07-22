import { Router } from "express";
import path from "node:path";
import { readAppConfig } from "../services/appConfig.ts";
import { scanForeignVault, mergeForeignVault } from "../services/importVault.ts";
import { recordActivity } from "../services/activity.ts";

export function importRouter(): Router {
  const r = Router();

  r.post("/scan", (req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const { path: foreignPath } = req.body;
    if (!foreignPath) {
      return res.status(400).json({ error: "path is required" });
    }

    const resolved = path.resolve(foreignPath);
    try {
      const results = scanForeignVault(config.vault_path, resolved);
      res.json({ source: resolved, results });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.post("/merge", (req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const { path: foreignPath, skills } = req.body;
    if (!foreignPath || !skills || !Array.isArray(skills)) {
      return res.status(400).json({ error: "path and skills[] required" });
    }

    const resolved = path.resolve(foreignPath);
    try {
      const result = mergeForeignVault(config.vault_path, resolved, skills);

      for (const name of result.imported) {
        recordActivity({
          kind: "adopt",
          skill: name,
          ok: true,
          message: `imported from ${path.basename(resolved)}`,
        });
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}
