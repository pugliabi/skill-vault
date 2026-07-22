import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import {
  listDevices,
  saveSnapshot,
  compareDevice,
  getCurrentMachineId,
  loadSnapshot,
  snapshotsDir,
} from "../services/devices.ts";
import { upsertManifestSkill } from "../services/vault.ts";
import { recordActivity } from "../services/activity.ts";

export function devicesRouter(): Router {
  const r = Router();

  r.get("/", (_req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const devices = listDevices(config.vault_path);
    const current = getCurrentMachineId();
    res.json({ devices, current_machine: current });
  });

  r.post("/snapshot", async (_req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    try {
      const snapshot = await saveSnapshot(config.vault_path);
      res.status(201).json(snapshot);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.get("/:name/compare", (req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    try {
      const comparisons = compareDevice(config.vault_path, req.params.name);
      res.json({ comparisons });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  r.post("/:name/sync", (req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const { decisions } = req.body;
    if (!decisions || !Array.isArray(decisions)) {
      return res.status(400).json({ error: "decisions array required" });
    }

    let remote;
    try {
      remote = loadSnapshot(config.vault_path, req.params.name);
    } catch (err) {
      return res.status(404).json({ error: (err as Error).message });
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const d of decisions) {
      if (d.action === "pull") {
        const remoteEntry = remote.skills[d.skill];
        if (remoteEntry) {
          upsertManifestSkill(config.vault_path, d.skill, {
            targets: remoteEntry.targets,
            stage: remoteEntry.stage,
            source: `sync-from:${req.params.name}`,
          });
          applied.push(d.skill);
          recordActivity({
            kind: "pull",
            skill: d.skill,
            ok: true,
            message: `sync-from ${req.params.name}`,
          });
        } else {
          skipped.push(d.skill);
        }
      } else {
        skipped.push(d.skill);
      }
    }

    res.json({ applied, skipped });
  });

  r.delete("/:name", (req, res) => {
    const config = readAppConfig();
    if (!config.vault_path) {
      return res.status(409).json({ error: "vault not configured" });
    }
    const file = path.join(snapshotsDir(config.vault_path), `${req.params.name}.json`);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: "snapshot not found" });
    }
    fs.unlinkSync(file);
    res.status(204).end();
  });

  return r;
}
