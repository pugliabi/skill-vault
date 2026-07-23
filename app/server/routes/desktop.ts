import fs from "node:fs";
import path from "node:path";
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
  hashZipContentsNormalized,
  packageForClaudeDesktop,
} from "../services/desktopPackaging.ts";
import { hashSkillDirNormalized } from "../services/skillHash.ts";
import { readManifest, skillDir, writeManifest } from "../services/vault.ts";
import type {
  DesktopBackfillResult,
  DesktopPackageResult,
} from "../types/vault.ts";

/**
 * Record the packaging in the skill's manifest entry. There is no API to
 * see what's actually in the user's claude.ai account (custom skills don't
 * sync across surfaces and can't be listed programmatically), so this
 * record is the source of truth for desktop_status. Creates a minimal
 * entry for disk-only skills the manifest doesn't track yet.
 */
function recordDesktopPackage(
  vaultPath: string,
  skill: string,
  contentHash: string,
  packagedAt: string,
): void {
  const manifest = readManifest(vaultPath);
  const entry = manifest.skills[skill] ?? { targets: [] };
  entry.desktop_package = { packaged_at: packagedAt, content_hash: contentHash };
  manifest.skills[skill] = entry;
  writeManifest(vaultPath, manifest);
}

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
      // Hash the vault copy (not the zip) — the zip was just built from it,
      // and the vault hash is what listSkills compares against later.
      const contentHash =
        hashSkillDirNormalized(skillDir(cfg.vault_path, skill)) ?? "empty";
      const packagedAt = new Date().toISOString();
      recordDesktopPackage(cfg.vault_path, skill, contentHash, packagedAt);
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
        content_hash: contentHash,
        packaged_at: packagedAt,
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

  // One-time seeding of desktop_package records from zips that predate
  // this feature. Scans the stage dir plus every configured provider dir
  // (loose <skill>.zip files sat next to linked skills in ~/.claude/skills
  // from earlier manual uploads). Never overwrites an existing record —
  // a record written at package time is always at least as accurate.
  router.post("/backfill", (_req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const vaultPath = cfg.vault_path;
    const stageDir = readClaudeDesktopStage() ?? defaultStageDir(vaultPath);
    const scanDirs = [stageDir, ...cfg.providers.map((p) => p.path)];

    const manifest = readManifest(vaultPath);
    const out: DesktopBackfillResult = { seeded: [], skipped: [] };
    const claimed = new Set<string>();
    let dirty = false;

    for (const dir of scanDirs) {
      let zips: string[];
      try {
        zips = fs
          .readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith(".zip"));
      } catch {
        continue;
      }
      for (const zipName of zips) {
        const zipPath = path.join(dir, zipName);
        const skill = zipName.replace(/\.zip$/i, "");
        if (claimed.has(skill)) continue;
        if (!fs.existsSync(skillDir(vaultPath, skill))) {
          out.skipped.push({ zip: zipPath, reason: "no matching vault skill" });
          continue;
        }
        if (manifest.skills[skill]?.desktop_package) {
          out.skipped.push({ zip: zipPath, reason: "already recorded" });
          continue;
        }
        const zipHash = hashZipContentsNormalized(zipPath);
        if (!zipHash) {
          out.skipped.push({ zip: zipPath, reason: "unreadable zip" });
          continue;
        }
        const packagedAt = fs.statSync(zipPath).mtime.toISOString();
        const entry = manifest.skills[skill] ?? { targets: [] };
        entry.desktop_package = {
          packaged_at: packagedAt,
          content_hash: zipHash,
        };
        manifest.skills[skill] = entry;
        dirty = true;
        claimed.add(skill);
        const vaultHash = hashSkillDirNormalized(skillDir(vaultPath, skill));
        out.seeded.push({
          skill,
          zip_path: zipPath,
          desktop_status: zipHash === vaultHash ? "current" : "outdated",
        });
      }
    }

    if (dirty) writeManifest(vaultPath, manifest);
    recordActivity({
      kind: "push",
      skill: "*",
      provider_id: "claude-desktop",
      ok: true,
      message: `backfill: ${out.seeded.length} seeded, ${out.skipped.length} skipped`,
    });
    res.json(out);
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
