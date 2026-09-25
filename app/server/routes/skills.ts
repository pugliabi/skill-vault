import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import archiver from "archiver";
import { readAppConfig } from "../services/appConfig.ts";
import { recordActivity } from "../services/activity.ts";
import {
  createSkill,
  getSkillDetail,
  listSkills,
  patchManifestSkill,
  readManifest,
  readSkillFile,
  resolveSkillFilePath,
  searchSkillBodies,
  upsertManifestSkill,
  writeSkillFile,
} from "../services/vault.ts";
import { validateSkillName } from "../services/skillName.ts";
import { withHistory, recordVersion } from "../services/history.ts";
import { SkillOpError, deleteVaultSkill, renameVaultSkill } from "../services/skillLifecycle.ts";
import { fixSkillName, listNameMismatches } from "../services/skillNames.ts";
import type { ProviderOutcome } from "../services/providerLinks.ts";

/**
 * `:name` must be a plain path segment before it reaches the filesystem
 * (same guard as routes/history.ts): non-empty, no "/", "\\", or "..".
 * Without it DELETE /api/skills/%2E%2E would resolve to the vault root.
 */
export function isSafeNameSegment(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

/**
 * Skills endpoints.
 *
 *   GET    /api/skills           — list (drift-checked against providers)
 *   GET    /api/skills/:name     — single skill + file tree + per-target status
 *   PATCH  /api/skills/:name     — partial manifest update (stage, targets, source)
 *   DELETE /api/skills/:name     — remove from manifest AND filesystem
 *   GET    /api/skills/name-mismatches      — folders whose SKILL.md `name` differs
 *   POST   /api/skills/:name/fix-name {use: "name"|"folder"} — make the two agree
 *
 * All routes require a configured vault and 409 with "vault not
 * configured" otherwise so the client can redirect to /setup.
 */
/** 409 {error:"busy"} text for renames while a Notion job runs (it may be reading or moving the same folders). */
const BUSY_TEXT = "Another Notion job is running — try again when it finishes.";

export function skillsRouter(opts: { isBusy?: () => boolean } = {}): Router {
  const isBusy = opts.isBusy ?? (() => false);
  const router = Router();

  router.get("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }

    let skills = listSkills(cfg.vault_path, cfg.providers);

    const q = (req.query.q as string | undefined)?.trim().toLowerCase();
    const target = (req.query.target as string | undefined)?.trim();
    const source = (req.query.source as string | undefined)?.trim();
    const fullText = req.query.full_text === "true";

    if (q) {
      skills = skills.filter((s) => {
        if (s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) {
          return true;
        }
        if (fullText && cfg.vault_path) {
          const skillMdPath = path.join(cfg.vault_path, "skills", s.name, "SKILL.md");
          try {
            const content = fs.readFileSync(skillMdPath, "utf-8").toLowerCase();
            return content.includes(q);
          } catch { /* file missing or unreadable */ }
        }
        return false;
      });
    }
    if (target) {
      skills = skills.filter((s) => s.targets.includes(target));
    }
    if (source) {
      skills = skills.filter((s) => s.source.includes(source));
    }

    res.json({ skills, total: skills.length });
  });

  /**
   * Full-text search over SKILL.md bodies. Registered BEFORE `/:name` so
   * "search" isn't captured as a skill name. Returns matching skill names
   * with a snippet; the client unions these with its name/description filter.
   */
  router.get("/name-mismatches", (_req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    res.json({ skills: listNameMismatches(cfg.vault_path) });
  });

  router.get("/search", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ matches: searchSkillBodies(cfg.vault_path, q) });
  });

  router.get("/:name", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const detail = getSkillDetail(cfg.vault_path, req.params.name, cfg.providers);
    if (!detail) {
      res.status(404).json({ error: "skill not found" });
      return;
    }
    res.json(detail);
  });

  /**
   * POST / — create a new skill from the SKILL.md frontmatter template.
   *
   * Body: { name: string, description?: string }
   *
   * Validates name via services/skillName.ts (slug regex + IGNORE_NAMES
   * + manifest-and-disk uniqueness). On any validation failure, returns
   * 409 with the validator's reason verbatim — NO folder is created.
   *
   * On success: creates <vault>/skills/<name>/SKILL.md with the template,
   * adds the manifest entry as { targets: [], stage: "staging",
   * source: "created in app" }, returns 201 with the new SkillDetail.
   *
   * Activity: two-record pattern (kind: "adopt" — the existing kind
   * for "skill enters the vault"; no new kind for create per phase
   * decision in 02-CONTEXT.md).
   */
  router.post("/", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { name?: unknown; description?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const v = validateSkillName(cfg.vault_path, name);
    if (!v.ok) {
      res.status(409).json({ error: v.reason });
      return;
    }

    recordActivity({
      kind: "adopt",
      skill: name,
      ok: true,
      message: "starting",
    });

    try {
      createSkill(cfg.vault_path, name, description);
    } catch (err) {
      recordActivity({
        kind: "adopt",
        skill: name,
        ok: false,
        message: (err as Error).message,
      });
      throw err;
    }

    try {
      recordVersion(cfg.vault_path, name, { source: "vault-edit", note: "created" });
    } catch (err) {
      console.error(`[history] create ${name}: ${(err as Error).message}`);
    }

    recordActivity({
      kind: "adopt",
      skill: name,
      ok: true,
      message: "created",
    });

    const detail = getSkillDetail(cfg.vault_path, name, cfg.providers);
    res.status(201).json(detail);
  });

  /**
   * POST /add — add an existing folder on disk to the vault.
   *
   * Body: { path: string, name?: string, targets?: string[] }
   *
   * Copies the folder into the vault, registers it in the manifest.
   * If name is not provided, uses the folder's basename.
   */
  router.post("/add", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { path?: string; name?: string; targets?: string[] };
    const sourcePath = body.path;
    if (!sourcePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      res.status(400).json({ error: "path must be an existing directory" });
      return;
    }

    const name = (body.name || path.basename(resolved)).trim();
    const v = validateSkillName(cfg.vault_path, name);
    if (!v.ok) {
      res.status(409).json({ error: v.reason });
      return;
    }

    recordActivity({ kind: "adopt", skill: name, ok: true, message: "starting" });

    try {
      const destDir = path.join(cfg.vault_path, "skills", name);
      copyDirRecursive(resolved, destDir);

      upsertManifestSkill(cfg.vault_path, name, {
        targets: body.targets || [],
        stage: "production",
        source: `added:${resolved}`,
      });

      recordActivity({ kind: "adopt", skill: name, ok: true, message: "added" });
      const detail = getSkillDetail(cfg.vault_path, name, cfg.providers);
      res.status(201).json(detail);
    } catch (err) {
      recordActivity({ kind: "adopt", skill: name, ok: false, message: (err as Error).message });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /:name/fix-name — make the folder name and SKILL.md's `name` agree.
   *   use "name":   rename the folder to SKILL.md's name (409 if that skill exists — a duplicate)
   *   use "folder": set SKILL.md's name to the folder name
   */
  router.post("/:name/fix-name", async (req, res) => {
    if (!isSafeNameSegment(req.params.name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    if (isBusy()) {
      res.status(409).json({ error: "busy", message: BUSY_TEXT });
      return;
    }
    const use = (req.body as { use?: unknown } | undefined)?.use;
    if (use !== "name" && use !== "folder") {
      res.status(400).json({ error: 'use must be "name" or "folder"' });
      return;
    }
    try {
      res.json(await fixSkillName(cfg.vault_path, req.params.name, use));
    } catch (err) {
      if (err instanceof SkillOpError) {
        res.status(err.status).json(err.code ? { error: err.code, message: err.message } : { error: err.message });
        return;
      }
      throw err;
    }
  });

  /**
   * POST /:name/rename — atomic folder + manifest-key rename.
   *
   * Body: { new_name: string }
   *
   * Validates new_name via the same validateSkillName() the create
   * route uses. fs.renameSync is atomic on the same filesystem so a
   * partial state is impossible.
   *
   * Activity: kind: "rename", message: "<old> → <new>".
   */
  router.post("/:name/rename", async (req, res) => {
    if (!isSafeNameSegment(req.params.name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    if (isBusy()) {
      res.status(409).json({ error: "busy", message: BUSY_TEXT });
      return;
    }
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { new_name?: unknown };
    const newName =
      typeof body.new_name === "string" ? body.new_name.trim() : "";
    let providerLinks: ProviderOutcome[] = [];
    try {
      providerLinks = await renameVaultSkill(cfg.vault_path, req.params.name, newName);
    } catch (err) {
      if (err instanceof SkillOpError) {
        res.status(err.status).json(err.code ? { error: err.code, message: err.message } : { error: err.message });
        return;
      }
      throw err;
    }

    const detail = getSkillDetail(cfg.vault_path, newName, cfg.providers);
    res.json({ ...detail, provider_links: providerLinks });
  });

  /**
   * GET /:name/files/* — read a single text file inside a skill.
   *
   * Wildcard segment (req.params.filepath) is the relative path inside the
   * skill folder. Path-traversal guard is mandatory: resolveSkillFilePath
   * returns null on any "../" attempt OR any absolute-path attempt.
   *
   * Returns FileContent JSON. Binary detection: any \0 in first 8 KB.
   * Size cap: 1 MB. Both flag fields independently — content/sha256
   * are null when either flag is true.
   *
   * No activity logged (reads never log).
   */
  router.get("/:name/files/*filepath", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const raw = (req.params as unknown as Record<string, string | string[]>).filepath;
    const requested = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
    const abs = resolveSkillFilePath(cfg.vault_path, req.params.name, requested);
    if (!abs) {
      res.status(400).json({ error: "invalid file path" });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    res.json(readSkillFile(abs));
  });

  /**
   * PUT /:name/files/* — atomic write with optimistic concurrency.
   *
   * Body: { content: string, expected_sha256: string }
   *
   * Re-hashes the file on disk; mismatch returns 409 (the user's
   * editor still holds the stale buffer; client must reload).
   *
   * **This route does NOT create new files.** If the target path does
   * not exist, returns 404 { error: "file not found" }. File creation
   * in Phase 2 happens only via POST /api/skills (the SKILL.md template).
   *
   * Refuses to write to binary files (400) or content >1 MB (413).
   * Path-traversal guard via resolveSkillFilePath is mandatory.
   *
   * No activity logged — file edits use the watcher's skill_changed
   * SSE event as the audit trail (logging every save would flood the
   * 200-entry ring buffer).
   *
   * Returns 200 with the new sha256 + size.
   */
  router.put("/:name/files/*filepath", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const raw = (req.params as unknown as Record<string, string | string[]>).filepath;
    const requested = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
    const abs = resolveSkillFilePath(cfg.vault_path, req.params.name, requested);
    if (!abs) {
      res.status(400).json({ error: "invalid file path" });
      return;
    }
    const body = req.body as { content?: unknown; expected_sha256?: unknown };
    const content = typeof body.content === "string" ? body.content : null;
    const expected =
      typeof body.expected_sha256 === "string" ? body.expected_sha256 : null;

    if (content === null || expected === null) {
      res
        .status(400)
        .json({ error: "content and expected_sha256 are required" });
      return;
    }
    // 1 MB cap — content.length is char count, not bytes; for safety
    // measure UTF-8 byte length of the request payload.
    const byteLen = Buffer.byteLength(content, "utf-8");
    if (byteLen > 1_048_576) {
      res.status(413).json({ error: "content exceeds 1 MB cap" });
      return;
    }
    // Refuse writes to non-existent files (writeSkillFile does NOT create).
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    // Refuse writes to existing binary or too-large files.
    const current = readSkillFile(abs);
    if (current.binary) {
      res.status(400).json({ error: "cannot write to binary file" });
      return;
    }
    if (current.too_large) {
      res
        .status(400)
        .json({ error: "cannot edit file larger than 1 MB" });
      return;
    }

    const result = withHistory(cfg.vault_path, req.params.name, "vault-edit", () =>
      writeSkillFile(abs, content, expected),
    );
    if (result === "not_found") {
      // Defensive — the existsSync above should have caught this, but if
      // a concurrent delete races between the check and the write, we
      // still surface the correct 404 rather than crashing.
      res.status(404).json({ error: "file not found" });
      return;
    }
    if (result === "stale") {
      res.status(409).json({ error: "file changed on disk — reload" });
      return;
    }

    // Return the new hash + size so the client updates its baseline
    // without an extra round-trip.
    const after = readSkillFile(abs);
    res.json({ sha256: after.sha256, size: after.size });
  });

  /**
   * PATCH — partial manifest update. Body fields:
   *   stage:   "production" | "staging"   (promote / demote)
   *   targets: string[]                    (replace target list)
   *   source:  string                      (rename provenance)
   * Anything else is ignored.
   */
  router.patch("/:name", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = (req.body ?? {}) as {
      stage?: "production" | "staging";
      targets?: string[];
      source?: string;
      tags?: string[];
    };

    const patch: {
      stage?: "production" | "staging";
      targets?: string[];
      source?: string;
      tags?: string[];
    } = {};
    if (body.stage === "production" || body.stage === "staging") {
      patch.stage = body.stage;
    }
    if (Array.isArray(body.targets) && body.targets.every((t) => typeof t === "string")) {
      patch.targets = body.targets;
    }
    if (typeof body.source === "string") {
      patch.source = body.source;
    }
    if (Array.isArray(body.tags) && body.tags.every((t) => typeof t === "string")) {
      patch.tags = body.tags;
    }

    // Detect a real stage transition. Treat undefined stage as
    // "production" per services/vault.ts:toStage. We only log when
    // patch.stage is provided AND differs from oldStage. Targets/source
    // updates are not in the activity kind enum and are not logged.
    const before = readManifest(cfg.vault_path).skills[req.params.name];
    const oldStage: "staging" | "production" =
      before?.stage === "staging" ? "staging" : "production";
    const stageChanging = !!patch.stage && patch.stage !== oldStage;
    const transitionKind: "promote" | "demote" | null = stageChanging
      ? patch.stage === "production"
        ? "promote"
        : "demote"
      : null;

    if (transitionKind) {
      recordActivity({
        kind: transitionKind,
        skill: req.params.name,
        ok: true,
        message: "starting",
      });
    }

    let updated;
    try {
      updated = patchManifestSkill(cfg.vault_path, req.params.name, patch);
    } catch (err) {
      if (transitionKind) {
        recordActivity({
          kind: transitionKind,
          skill: req.params.name,
          ok: false,
          message: (err as Error).message,
        });
      }
      throw err;
    }
    if (!updated) {
      res.status(404).json({ error: "skill not in manifest" });
      return;
    }
    if (transitionKind) {
      recordActivity({
        kind: transitionKind,
        skill: req.params.name,
        ok: true,
        message: `${oldStage} → ${patch.stage}`,
      });
    }
    const detail = getSkillDetail(cfg.vault_path, req.params.name, cfg.providers);
    res.json(detail);
  });

  router.post("/zip", async (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { skills?: unknown };
    const skillNames = Array.isArray(body.skills)
      ? body.skills.filter((s): s is string => typeof s === "string")
      : [];
    if (skillNames.length === 0) {
      res.status(400).json({ error: "skills must be a non-empty array" });
      return;
    }

    const outputDir = path.resolve(cfg.vault_path, "..", "zips");
    fs.mkdirSync(outputDir, { recursive: true });

    const zips: { skill: string; path: string }[] = [];
    const failed: { skill: string; error: string }[] = [];

    for (const name of skillNames) {
      const skillFolder = path.join(cfg.vault_path, "skills", name);
      if (!fs.existsSync(skillFolder) || !fs.statSync(skillFolder).isDirectory()) {
        failed.push({ skill: name, error: "skill folder not found" });
        continue;
      }
      const outputPath = path.join(outputDir, `${name}.zip`);
      try {
        await new Promise<void>((resolve, reject) => {
          const output = fs.createWriteStream(outputPath);
          const archive = archiver("zip", { zlib: { level: 9 } });
          output.on("close", () => resolve());
          output.on("error", reject);
          archive.on("error", reject);
          archive.pipe(output);
          archive.directory(skillFolder, false);
          archive.finalize();
        });
        zips.push({ skill: name, path: outputPath });
      } catch (err) {
        failed.push({ skill: name, error: (err as Error).message });
      }
    }

    res.json({ zips, failed });
  });

  router.post("/:name/package", (req, res) => {
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    const body = req.body as { output_dir?: string };
    if (!body.output_dir) {
      res.status(400).json({ error: "output_dir is required" });
      return;
    }
    const skillName = req.params.name;
    const sourceDir = path.join(cfg.vault_path, "skills", skillName);
    if (!fs.existsSync(sourceDir)) {
      res.status(404).json({ error: "skill folder not found" });
      return;
    }
    const outputDir = path.resolve(body.output_dir);
    const destDir = path.join(outputDir, skillName);
    try {
      copyDirRecursive(sourceDir, destDir);
      res.json({ output_path: destDir });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:name", (req, res) => {
    if (!isSafeNameSegment(req.params.name)) {
      res.status(400).json({ error: "invalid skill name" });
      return;
    }
    const cfg = readAppConfig();
    if (!cfg.vault_path) {
      res.status(409).json({ error: "vault not configured" });
      return;
    }
    // Idempotent: a no-op delete still records its activity (see service).
    deleteVaultSkill(cfg.vault_path, req.params.name); // errors → /api error handler (500)
    res.status(204).end();
  });

  return router;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
