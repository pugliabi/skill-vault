import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import { browseDirs, importSkills, scanForSkills } from "../services/adoption.ts";
import { discoverAll } from "../services/discover.ts";
import type { AdoptImportRequest } from "../types/vault.ts";

export function adoptRouter(): Router {
  const router = Router();

  /** Scan a directory for candidate skills. Returns an array. */
  router.post("/scan", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { path?: string; recursive?: boolean };
    if (!body.path) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const { results, truncated } = scanForSkills(
        body.path,
        cfg.vault_path,
        Boolean(body.recursive),
      );
      res.json({
        source: body.path,
        results,
        recursive: Boolean(body.recursive),
        truncated,
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * List subdirectories for the folder picker. No vault required — this is
   * pure filesystem navigation. Empty/missing `path` opens at the default
   * adopt location (or the home dir).
   */
  router.post("/browse", (req, res) => {
    const body = req.body as { path?: string };
    try {
      res.json(browseDirs(body.path));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Copy selected skills into the vault and update the manifest. */
  router.post("/import", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as AdoptImportRequest;
    const hasItems = Array.isArray(body.items) && body.items.length > 0;
    if (!body.source_path || (!hasItems && !Array.isArray(body.skills))) {
      res
        .status(400)
        .json({ error: "source_path and items[] (or skills[]) are required" });
      return;
    }
    // One starting record per requested skill — emitted BEFORE
    // importSkills so the SSE `activity` events for each skill arrive
    // ahead of any vault-side `skill_changed` the copy emits.
    const requestedSkills: string[] = hasItems
      ? body.items!.map((i) => i.name)
      : Array.isArray(body.skills)
        ? body.skills
        : [];
    for (const skill of requestedSkills) {
      recordActivity({
        kind: "adopt",
        skill,
        provider_id: body.provider_id,
        ok: true,
        message: "starting",
      });
    }
    try {
      const result = importSkills(
        cfg.vault_path,
        body.source_path,
        body.skills ?? [],
        body.provider_id,
        body.paths,
        body.items,
      );
      // Per-skill outcome records: ok=true for imported, ok=false for skipped.
      for (const skill of result.imported) {
        recordActivity({
          kind: "adopt",
          skill,
          provider_id: body.provider_id,
          ok: true,
          message: "imported",
        });
      }
      for (const skill of result.skipped ?? []) {
        recordActivity({
          kind: "adopt",
          skill,
          provider_id: body.provider_id,
          ok: false,
          message: "skipped (name collision)",
        });
      }
      res.json(result);
    } catch (err) {
      // Catastrophic pre/in-importSkills failure has no per-skill
      // granularity. Emit a single summary record so the failure is
      // visible in the activity log.
      recordActivity({
        kind: "adopt",
        skill: requestedSkills.length > 0 ? requestedSkills.join(",") : "(unknown)",
        provider_id: body.provider_id,
        ok: false,
        message: (err as Error).message,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Clone a git repo to a temp dir and scan it. */
  router.post("/clone", async (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const { url, branch } = req.body as { url?: string; branch?: string };
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    const tmpDir = path.join(os.tmpdir(), `sv-adopt-${Date.now()}`);
    try {
      const { simpleGit } = await import("simple-git");
      const git = simpleGit();
      const cloneArgs = branch ? ["--branch", branch, "--depth", "1"] : ["--depth", "1"];
      await git.clone(url, tmpDir, cloneArgs);
      const { results, truncated } = scanForSkills(tmpDir, cfg.vault_path, true);
      res.json({ tmp_path: tmpDir, results, truncated });
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** Cleanup a temp clone dir. */
  router.post("/cleanup", (req, res) => {
    const { tmp_path } = req.body as { tmp_path?: string };
    if (!tmp_path || !tmp_path.includes("sv-adopt-")) {
      res.status(400).json({ error: "invalid tmp_path" });
      return;
    }
    try {
      fs.rmSync(tmp_path, { recursive: true, force: true });
      res.json({ ok: true });
    } catch {
      res.json({ ok: true });
    }
  });

  /** Discover skills across all providers, classified against the vault. */
  router.post("/discover", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    try {
      const results = discoverAll(cfg.vault_path, cfg.providers);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
