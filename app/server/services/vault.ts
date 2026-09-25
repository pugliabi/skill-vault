/**
 * Vault filesystem reader.
 *
 * Treats `<vault>/skills.json` + `<vault>/skills/<name>/` as the source
 * of truth. Nothing is cached across requests in v1 — a full scan of
 * even hundreds of skill folders takes single-digit milliseconds on
 * any modern filesystem, and in-memory caching adds complexity we
 * can defer until profiling shows we need it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { frontmatterDescription } from "./skillText.ts";
import type {
  DesktopStatus,
  FileNode,
  ManifestSkill,
  Provider,
  Skill,
  SkillDetail,
  SkillStatus,
  SkillsManifest,
  TargetStatus,
} from "../types/vault.ts";
import { hashSkillDirNormalized } from "./skillHash.ts";
import { statusByTarget } from "./syncStatus.ts";
import { computeNotionStatus } from "./notion/matching.ts";
import { readNotionAuth, readNotionCache, readNotionSettings } from "./notion/store.ts";

// ── Path helpers ────────────────────────────────────────────────

export function manifestPath(vaultPath: string): string {
  return path.join(vaultPath, "skills.json");
}

export function skillsDir(vaultPath: string): string {
  return path.join(vaultPath, "skills");
}

export function skillDir(vaultPath: string, skillName: string): string {
  return path.join(skillsDir(vaultPath), skillName);
}

/**
 * Full-text search over skill SKILL.md bodies. The list view already
 * filters name+description client-side; this covers the "the skill that
 * mentions ffmpeg" case where the term is in the body, not the summary.
 * Reads skill folders straight off disk (not the expensive listSkills
 * status computation) and returns a short snippet around the first hit.
 */
export function searchSkillBodies(
  vaultPath: string,
  query: string,
  limit = 300,
): { name: string; snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const root = skillsDir(vaultPath);
  if (!fs.existsSync(root)) return [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const out: { name: string; snippet: string }[] = [];
  for (const name of names) {
    const md = path.join(root, name, "SKILL.md");
    let text: string;
    try {
      text = fs.readFileSync(md, "utf-8");
    } catch {
      continue;
    }
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 40);
    const snippet = text
      .slice(start, idx + q.length + 80)
      .replace(/\s+/g, " ")
      .trim();
    out.push({ name, snippet });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Manifest I/O ────────────────────────────────────────────────

/**
 * Read and parse `<vault>/skills.json`. Creates an empty manifest if
 * the file is missing — supports the first-run flow where the user
 * picks an empty directory to initialize.
 */
export function readManifest(vaultPath: string): SkillsManifest {
  const file = manifestPath(vaultPath);
  if (!fs.existsSync(file)) {
    return { skills: {} };
  }
  const raw = fs.readFileSync(file, "utf-8");
  const parsed = JSON.parse(raw) as Partial<SkillsManifest>;
  const known_tags =
    Array.isArray(parsed.known_tags) &&
    parsed.known_tags.every((t) => typeof t === "string")
      ? parsed.known_tags
      : undefined;
  return {
    version: parsed.version,
    machine_id: parsed.machine_id,
    default_targets: parsed.default_targets,
    known_tags,
    skills:
      parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {},
  };
}

/** Write manifest atomically. Preserves any top-level fields we don't own. */
export function writeManifest(
  vaultPath: string,
  manifest: SkillsManifest,
): void {
  const file = manifestPath(vaultPath);
  fs.mkdirSync(vaultPath, { recursive: true });
  const tmp = `${file}.tmp`;
  // Trailing newline matches the Python writer (config.py:save_manifest)
  // so diffs stay minimal when both tools rewrite the file.
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/**
 * Initialize a vault directory: ensure `<vault>/` and `<vault>/skills/`
 * exist, create `skills.json` if missing. Idempotent.
 */
export function initVault(vaultPath: string): void {
  fs.mkdirSync(skillsDir(vaultPath), { recursive: true });
  if (!fs.existsSync(manifestPath(vaultPath))) {
    writeManifest(vaultPath, { skills: {} });
  }
}

// ── Filesystem helpers ──────────────────────────────────────────

/** Recursively count files inside a directory. Returns 0 if missing. */
function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        n++;
      }
    }
  }
  return n;
}

/**
 * Extract a short description from SKILL.md frontmatter if present, or
 * fall back to the first non-blank paragraph. Returns empty string if
 * the file doesn't exist or can't be parsed.
 */
function readDescription(skillPath: string): string {
  const md = path.join(skillPath, "SKILL.md");
  if (!fs.existsSync(md)) return "";
  try {
    const text = fs.readFileSync(md, "utf-8");
    // YAML frontmatter (incl. `description: >` block scalars)
    const fmDesc = frontmatterDescription(text);
    if (fmDesc) return fmDesc;
    // First non-blank non-heading line
    const body = text.replace(/^---[\s\S]*?---\s*/, "").trim();
    const firstPara = body
      .split(/\n\s*\n/)
      .find((p) => p.trim() && !p.trim().startsWith("#"));
    if (firstPara) {
      return firstPara.replace(/\s+/g, " ").slice(0, 280).trim();
    }
    return "";
  } catch {
    return "";
  }
}

function toStage(s: ManifestSkill["stage"]): "staging" | "production" {
  return s === "staging" ? "staging" : "production";
}

/**
 * Aggregate a skill's status from its targets and per-target state:
 *   - staging stage              → "staging"
 *   - no targets                 → "vault-only"
 *   - any target stale           → "stale"
 *   - any target missing/error   → "missing"
 *   - all synced                 → "synced"
 */
function aggregateStatus(
  stage: "staging" | "production",
  targets: string[],
  byTarget: Record<string, TargetStatus>,
): SkillStatus {
  if (stage === "staging") return "staging";
  if (targets.length === 0) return "vault-only";
  const states = targets.map((t) => byTarget[t]);
  if (states.some((s) => s === "stale")) return "stale";
  if (states.some((s) => s === "missing" || s === "error")) return "missing";
  return "synced";
}

// ── Listing + detail ────────────────────────────────────────────

/**
 * Return every skill in the vault as a merged view of the manifest and
 * the filesystem. Skills that exist on disk but not in the manifest are
 * still included with empty targets; the Adopt flow is how they get
 * into the manifest, but the browser should show them anyway.
 *
 * If `providers` is passed, each skill's `target_status` is computed
 * (hash-comparing the linked copy in each provider against the vault).
 * Pass `[]` to skip drift detection — callers that don't care about
 * sync state get a faster response.
 */
export function listSkills(vaultPath: string, providers: Provider[] = []): Skill[] {
  const manifest = readManifest(vaultPath);
  const dir = skillsDir(vaultPath);

  // Union of manifest keys and on-disk directories.
  const diskNames = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const names = new Set<string>([...Object.keys(manifest.skills), ...diskNames]);

  // Notion status inputs are read once per call. Connected = signed in AND a
  // Skills data source chosen; otherwise notion_status is omitted entirely.
  // The cache only counts when a check produced it for the chosen data source.
  const notionDataSource = readNotionSettings(vaultPath).data_source_id;
  const notionConnected = !!readNotionAuth().tokens && !!notionDataSource;
  const notionCache = notionConnected ? readNotionCache() : { rows: [] };
  const notionCacheValid =
    notionConnected && !!notionCache.checked_at && notionCache.data_source_id === notionDataSource;
  const notionRows = notionCacheValid
    ? new Map(notionCache.rows.map((r) => [r.page_id, r] as const))
    : new Map();

  const out: Skill[] = [];
  for (const name of names) {
    const entry = manifest.skills[name] ?? { targets: [] };
    const sp = skillDir(vaultPath, name);
    const exists = fs.existsSync(sp);
    let modifiedAt = new Date(0).toISOString();
    let createdAt = modifiedAt;
    if (exists) {
      try {
        const stat = fs.statSync(sp);
        modifiedAt = stat.mtime.toISOString();
        // birthtime is unreliable on some filesystems (Linux ext4 < kernel
        // 4.11 returns epoch); fall back to mtime so the field is always
        // a sensible timestamp.
        createdAt =
          stat.birthtime && stat.birthtime.getTime() > 0
            ? stat.birthtime.toISOString()
            : modifiedAt;
      } catch {
        /* ignore */
      }
    }
    const targets = entry.targets ?? [];
    const stage = toStage(entry.stage);
    const byTarget: Record<string, TargetStatus> =
      providers.length && targets.length
        ? statusByTarget(sp, providers, name, targets)
        : Object.fromEntries(targets.map((t) => [t, "synced" as TargetStatus]));
    // Claude Desktop drift: only skills with a desktop_package record pay
    // for the normalized hash — never-packaged skills short-circuit.
    // The normalized hash is computed at most once per skill, and only for
    // skills that need it (packaged for Desktop, or linked + synced to Notion).
    let hash: string | null | undefined;
    const vaultHash = (): string | null =>
      hash === undefined ? (hash = exists ? hashSkillDirNormalized(sp) : null) : hash;
    let desktopStatus: DesktopStatus = "not-packaged";
    if (entry.desktop_package) {
      desktopStatus =
        vaultHash() === entry.desktop_package.content_hash ? "current" : "outdated";
    }
    const link = entry.notion;
    const notionStatus = notionConnected
      ? computeNotionStatus({
          connected: true,
          link,
          vaultHash: link?.state === "linked" && link.synced_at ? vaultHash() : null,
          cacheRow: link?.page_id ? notionRows.get(link.page_id) : undefined,
          cacheValid: notionCacheValid,
        })
      : undefined;
    out.push({
      name,
      targets,
      tags: entry.tags ?? [],
      stage,
      source: entry.source ?? "",
      file_count: countFiles(sp),
      has_skill_md: fs.existsSync(path.join(sp, "SKILL.md")),
      description: readDescription(sp),
      modified_at: modifiedAt,
      created_at: createdAt,
      target_status: byTarget,
      status: aggregateStatus(stage, targets, byTarget),
      desktop_status: desktopStatus,
      ...(entry.desktop_package
        ? { desktop_package: entry.desktop_package }
        : {}),
      ...(entry.origin ? { origin: entry.origin } : {}),
      ...(notionStatus ? { notion_status: notionStatus } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Build a recursive file tree for a skill's directory. */
function buildFileTree(root: string, relative = ""): FileNode {
  const abs = path.join(root, relative);
  const name = relative === "" ? path.basename(root) : path.basename(relative);
  const stat = fs.statSync(abs);
  const node: FileNode = {
    name,
    path: relative,
    type: stat.isDirectory() ? "dir" : "file",
  };
  if (node.type === "dir") {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    node.children = entries
      .map((e) => buildFileTree(root, path.join(relative, e.name)))
      .sort((a, b) => {
        // dirs first, then files, alpha within each group
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } else {
    node.size = stat.size;
  }
  return node;
}

/** Full detail (skill + file tree) for the detail page. */
export function getSkillDetail(
  vaultPath: string,
  name: string,
  providers: Provider[] = [],
): SkillDetail | null {
  const all = listSkills(vaultPath, providers);
  const skill = all.find((s) => s.name === name);
  if (!skill) return null;
  const sp = skillDir(vaultPath, name);
  if (!fs.existsSync(sp)) {
    return { ...skill, files: { name, path: "", type: "dir", children: [] } };
  }
  return { ...skill, files: buildFileTree(sp) };
}

/** Upsert a skill entry in the manifest without touching unrelated keys. */
export function upsertManifestSkill(
  vaultPath: string,
  name: string,
  entry: ManifestSkill,
): void {
  const manifest = readManifest(vaultPath);
  manifest.skills[name] = entry;
  writeManifest(vaultPath, manifest);
}

/**
 * Patch a manifest entry in place, preserving fields the caller didn't
 * pass. Returns the merged entry, or null if the skill isn't in the
 * manifest yet (caller can decide to create it).
 */
export function patchManifestSkill(
  vaultPath: string,
  name: string,
  patch: Partial<ManifestSkill>,
): ManifestSkill | null {
  const manifest = readManifest(vaultPath);
  const existing = manifest.skills[name];
  if (!existing) return null;
  const merged: ManifestSkill = { ...existing, ...patch };
  manifest.skills[name] = merged;
  writeManifest(vaultPath, manifest);
  return merged;
}

/**
 * Remove a skill from both the manifest and the filesystem. Idempotent —
 * missing manifest entries are ignored, missing folders are ignored.
 */
export function removeSkill(vaultPath: string, name: string): void {
  const manifest = readManifest(vaultPath);
  if (manifest.skills[name]) {
    delete manifest.skills[name];
    writeManifest(vaultPath, manifest);
  }
  const sp = skillDir(vaultPath, name);
  if (fs.existsSync(sp)) {
    fs.rmSync(sp, { recursive: true, force: true });
  }
}

// ── Phase 2: create / rename / file I/O ─────────────────────────

const SKILL_MD_TEMPLATE = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n`;

const FILE_SIZE_CAP_BYTES = 1_048_576; // 1 MB
const BINARY_SNIFF_BYTES = 8 * 1024;   // 8 KB

/**
 * Create a new skill from the SKILL.md frontmatter template.
 *
 * Caller MUST validate the name first via services/skillName.ts.
 * This service trusts its input — the only safety net here is
 * fs.mkdirSync({ recursive: true }) for the directory and atomic
 * write for SKILL.md.
 *
 * Manifest entry shape matches docs/vault-format.md SkillEntry:
 *   targets: []   stage: "staging"   source: "created in app"
 *
 * Existing top-level manifest fields (version, machine_id,
 * default_targets, anything unknown) are preserved by writeManifest.
 */
export function createSkill(
  vaultPath: string,
  name: string,
  description: string,
): void {
  const dir = skillDir(vaultPath, name);
  fs.mkdirSync(dir, { recursive: true });

  const md = path.join(dir, "SKILL.md");
  const tmp = `${md}.tmp`;
  fs.writeFileSync(tmp, SKILL_MD_TEMPLATE(name, description), "utf-8");
  fs.renameSync(tmp, md);

  upsertManifestSkill(vaultPath, name, {
    targets: [],
    stage: "staging",
    source: "created in app",
  });
}

/**
 * Atomic rename of a skill: filesystem fs.renameSync THEN manifest key
 * rewrite. fs.renameSync is atomic on the same filesystem so partial
 * states are not possible — either both old paths and old key exist,
 * or both new paths and new key exist.
 *
 * Manifest entry is COPIED whole (preserving targets, stage, source,
 * AND any unknown fields per docs/vault-format.md round-trip rule).
 *
 * Caller MUST validate `newName` via services/skillName.ts BEFORE
 * calling. Throws if `oldName` does not exist on disk OR in manifest.
 */
export function renameSkill(
  vaultPath: string,
  oldName: string,
  newName: string,
): void {
  const oldDir = skillDir(vaultPath, oldName);
  const newDir = skillDir(vaultPath, newName);

  if (!fs.existsSync(oldDir)) {
    throw new Error(`skill folder "${oldName}" not found`);
  }

  fs.renameSync(oldDir, newDir);

  const manifest = readManifest(vaultPath);
  const entry = manifest.skills[oldName];
  if (entry) {
    // Copy whole entry — preserves any unknown keys per round-trip rule.
    manifest.skills[newName] = entry;
    delete manifest.skills[oldName];
    writeManifest(vaultPath, manifest);
  }
  // If entry was absent (folder existed but manifest didn't track it —
  // possible after an external mkdir), the rename of the folder is
  // sufficient; nothing to update in the manifest.
}

/**
 * Resolve a client-supplied relative path against `<vault>/skills/<name>/`.
 * Returns the absolute path iff it is INSIDE the skill folder; returns
 * null on any traversal attempt or absolute-path attempt.
 *
 * Always use this before any fs.readFile/fs.writeFile on a
 * client-controlled path. The Express wildcard route param can contain
 * "../" segments — this is the canonical guard.
 */
export function resolveSkillFilePath(
  vaultPath: string,
  skillName: string,
  requested: string,
): string | null {
  if (typeof requested !== "string" || requested.length === 0) return null;
  const skillRoot = skillDir(vaultPath, skillName);
  const resolved = path.resolve(skillRoot, requested);
  // Must be strictly inside skillRoot (NOT equal to it — empty path).
  if (!resolved.startsWith(skillRoot + path.sep)) return null;
  return resolved;
}

/**
 * Read a file inside a skill folder with binary detection and size cap.
 *
 * Returns a FileContent JSON shape (see types/vault.ts):
 *   - too_large: true   when size > 1 MB         → content/sha256 null
 *   - binary:    true   when first 8 KB has \0   → content/sha256 null
 *   - else      content = utf-8, sha256 = sha256 of bytes
 *
 * The sha256 IS the optimistic-concurrency baseline returned to the
 * client; subsequent PUT echoes it back as expected_sha256.
 *
 * Throws ENOENT if the file does not exist (caller surfaces 404).
 */
export function readSkillFile(absPath: string): {
  binary: boolean;
  too_large: boolean;
  size: number;
  sha256: string | null;
  content: string | null;
} {
  const stat = fs.statSync(absPath);
  const size = stat.size;
  if (size > FILE_SIZE_CAP_BYTES) {
    return { binary: false, too_large: true, size, sha256: null, content: null };
  }

  // Binary sniff: read up to BINARY_SNIFF_BYTES, look for \0.
  const fd = fs.openSync(absPath, "r");
  try {
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, size));
    if (sniff.length > 0) fs.readSync(fd, sniff, 0, sniff.length, 0);
    if (sniff.includes(0)) {
      return { binary: true, too_large: false, size, sha256: null, content: null };
    }
  } finally {
    fs.closeSync(fd);
  }

  const buf = fs.readFileSync(absPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  return {
    binary: false,
    too_large: false,
    size,
    sha256,
    content: buf.toString("utf-8"),
  };
}

/**
 * Atomic write with optimistic-concurrency check.
 *
 * Re-hashes the file on disk RIGHT NOW; compares to expectedSha256.
 * Mismatch → returns "stale" (caller surfaces 409). Match → tmp+rename
 * (matching writeManifest's atomic pattern).
 *
 * **This helper does NOT create new files.** If the target path does
 * not exist on disk, it returns "not_found" (caller surfaces 404).
 * POST /api/skills is the only path that creates files in Phase 2.
 * This narrow contract avoids accidentally extending the PUT route's
 * scope to cover file creation, which the phase explicitly defers.
 *
 * Returns:
 *   - "ok"        : write succeeded
 *   - "stale"     : file exists but the on-disk sha256 != expectedSha256
 *   - "not_found" : file does NOT exist on disk; no write was attempted
 */
export function writeSkillFile(
  absPath: string,
  content: string,
  expectedSha256: string,
): "ok" | "stale" | "not_found" {
  if (!fs.existsSync(absPath)) {
    return "not_found";
  }
  const buf = fs.readFileSync(absPath);
  const currentSha = crypto.createHash("sha256").update(buf).digest("hex");
  if (currentSha !== expectedSha256) {
    return "stale";
  }

  // File exists and hash matches — atomic write via tmp + rename.
  const tmp = `${absPath}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, absPath);
  return "ok";
}
