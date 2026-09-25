/**
 * Skill version history — content-addressed store under <vault>/.history/.
 *
 *   .history/objects/<aa>/<sha256>       file bytes as read, stored once
 *   .history/skills/<name>/versions.json ordered versions (oldest first on disk)
 *   .history/config.json                 { max_versions }
 *
 * No .gitattributes is written: objects follow the vault repo's own EOL
 * rules, so git stores them as the same blobs as the skill files they copy
 * and unchanged files cost the repo nothing extra. The object name is the
 * sha256 of the bytes on the machine that recorded it; after a checkout on
 * a machine with different EOL settings the bytes on disk may no longer
 * match the name. That is harmless: readers only look objects up by name.
 *
 * Duplicate detection: a new state is "the same" as the latest version of
 * its side when the raw file maps match OR both normalized_hash values are
 * non-null and equal (so a CRLF/LF-only difference is not a new version).
 *
 * An unreadable versions.json (bad JSON, e.g. git conflict markers) is never
 * overwritten or garbage-collected against: writers skip and log, readers
 * throw a clear error.
 * See docs/vault-format.md "`.history/` — version history".
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashSkillDirNormalized } from "./skillHash.ts";
import { computeSkillDiff, type SkillDiff } from "./diff.ts";
import { readManifest, upsertManifestSkill } from "./vault.ts";
import type { ManifestSkill } from "../types/vault.ts";

export type HistorySide = "vault" | "notion";
export type HistorySource =
  | "vault-edit" | "external-edit" | "pull" | "push-notion-copy" | "notion-edit"
  | "claude-merge" | "force-push" | "force-pull" | "restore" | "rename"
  | "delete" | "adopt" | "update" | "legacy-snapshot";

export interface HistoryVersion {
  id: string;
  /** ISO 8601 UTC. */
  at: string;
  side: HistorySide;
  source: HistorySource;
  note?: string;
  /** "/"-separated relative path → sha256 of the raw bytes. */
  files: Record<string, string>;
  normalized_hash: string | null;
  /**
   * Manifest entry (tags/targets/stage/source/etc.) captured at record
   * time, when the caller has it handy — currently only the pre-delete
   * recordVersion call in routes/skills.ts passes this, so a restore can
   * bring back more than just the files. Opaque here on purpose: this
   * module doesn't want a hard dependency on ManifestSkill's shape.
   */
  manifest_entry?: unknown;
}

export interface RecordOptions {
  source: HistorySource;
  side?: HistorySide;
  note?: string;
  /** Folder to snapshot. Defaults to <vault>/skills/<skill>. */
  dir?: string;
  /** Record even when identical to the latest version of the same side. */
  always?: boolean;
  /** See HistoryVersion.manifest_entry. */
  manifest_entry?: unknown;
}

interface VersionsFile {
  skill: string;
  versions: HistoryVersion[];
}

const SKIP = new Set(["node_modules", "__pycache__", ".git", ".DS_Store", "Thumbs.db"]);

export function historyRoot(vaultPath: string): string {
  return path.join(vaultPath, ".history");
}

function objectPath(vaultPath: string, sha: string): string {
  return path.join(historyRoot(vaultPath), "objects", sha.slice(0, 2), sha);
}

export function skillHistoryDir(vaultPath: string, skill: string): string {
  return path.join(historyRoot(vaultPath), "skills", skill);
}

export const DEFAULT_MAX_VERSIONS = 50;

interface HistoryConfig {
  max_versions: number;
}

function configPath(vaultPath: string): string {
  return path.join(historyRoot(vaultPath), "config.json");
}

export function readHistoryConfig(vaultPath: string): HistoryConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(vaultPath), "utf8"));
    const n = Number(raw?.max_versions);
    if (Number.isInteger(n) && n >= 1) return { max_versions: n };
  } catch {
    /* default */
  }
  return { max_versions: DEFAULT_MAX_VERSIONS };
}

export function writeHistoryConfig(vaultPath: string, cfg: HistoryConfig): void {
  if (!Number.isInteger(cfg.max_versions) || cfg.max_versions < 1) {
    throw new Error("max_versions must be a positive integer");
  }
  atomicWrite(configPath(vaultPath), JSON.stringify(cfg, null, 2) + "\n");
}

export function gcObjects(vaultPath: string): number {
  const referenced = new Set<string>();
  const skillsRoot = path.join(historyRoot(vaultPath), "skills");
  const names = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : [];
  for (const name of names) {
    let vf: VersionsFile;
    try {
      vf = readVersionsFile(vaultPath, name);
    } catch (err) {
      // Can't know which objects an unreadable file references: delete nothing.
      console.error(`[history] gc skipped: ${(err as Error).message}`);
      return 0;
    }
    for (const v of vf.versions) {
      for (const sha of Object.values(v.files)) referenced.add(sha);
    }
  }
  const objectsRoot = path.join(historyRoot(vaultPath), "objects");
  if (!fs.existsSync(objectsRoot)) return 0;
  let removed = 0;
  for (const bucket of fs.readdirSync(objectsRoot)) {
    const bucketDir = path.join(objectsRoot, bucket);
    for (const sha of fs.readdirSync(bucketDir)) {
      if (!referenced.has(sha)) {
        fs.rmSync(path.join(bucketDir, sha), { force: true });
        removed++;
      }
    }
    if (fs.readdirSync(bucketDir).length === 0) fs.rmdirSync(bucketDir);
  }
  return removed;
}

export function moveHistory(vaultPath: string, oldName: string, newName: string): void {
  const from = skillHistoryDir(vaultPath, oldName);
  if (!fs.existsSync(from)) return;
  const to = skillHistoryDir(vaultPath, newName);
  fs.mkdirSync(path.dirname(to), { recursive: true });

  // Never overwrite (or delete) a versions.json we can't read.
  let fromVersions: HistoryVersion[];
  let toVersions: HistoryVersion[] | null = null;
  try {
    fromVersions = readVersionsFile(vaultPath, oldName).versions;
    if (fs.existsSync(to)) toVersions = readVersionsFile(vaultPath, newName).versions;
  } catch (err) {
    console.error(`[history] moveHistory ${oldName} -> ${newName} skipped: ${(err as Error).message}`);
    return;
  }

  if (toVersions) {
    // Merge case: concatenate, sort by at ascending, write destination
    const merged = [...fromVersions, ...toVersions].sort((a, b) => a.at.localeCompare(b.at));
    const vf: VersionsFile = { skill: newName, versions: merged };
    writeVersionsFile(vaultPath, newName, vf);
    // Remove old-name history dir
    fs.rmSync(from, { recursive: true, force: true });
  } else {
    // Simple rename case
    fs.renameSync(from, to);
    writeVersionsFile(vaultPath, newName, { skill: newName, versions: fromVersions });
  }
}

export function recordDeletionMarker(
  vaultPath: string,
  skill: string,
  note: string,
): HistoryVersion | null {
  let vf: VersionsFile;
  try {
    vf = readVersionsFile(vaultPath, skill);
  } catch (err) {
    console.error(`[history] deletion marker for ${skill} skipped: ${(err as Error).message}`);
    return null;
  }
  const latest = vf.versions[vf.versions.length - 1];
  if (!latest || latest.source === "delete") return null;
  const marker: HistoryVersion = {
    ...latest,
    id: newId(),
    at: new Date().toISOString(),
    side: "vault",
    source: "delete",
    note,
  };
  vf.versions.push(marker);
  writeVersionsFile(vaultPath, skill, vf);
  return marker;
}

export function listDeletedSkills(
  vaultPath: string,
): Array<{ name: string; deleted_at: string; versions: number }> {
  const skillsRoot = path.join(historyRoot(vaultPath), "skills");
  if (!fs.existsSync(skillsRoot)) return [];
  const out: Array<{ name: string; deleted_at: string; versions: number }> = [];
  for (const name of fs.readdirSync(skillsRoot)) {
    if (fs.existsSync(path.join(vaultPath, "skills", name))) continue;
    let versions: HistoryVersion[];
    try {
      versions = readVersionsFile(vaultPath, name).versions;
    } catch (err) {
      console.error(`[history] ${(err as Error).message}`);
      continue;
    }
    if (versions.length === 0) continue;
    out.push({ name, deleted_at: versions[versions.length - 1].at, versions: versions.length });
  }
  return out.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

function versionsPath(vaultPath: string, skill: string): string {
  return path.join(skillHistoryDir(vaultPath, skill), "versions.json");
}

function atomicWrite(abs: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

function collectFiles(root: string, rel = "", out: Array<{ rel: string; abs: string }> = []) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collectFiles(root, childRel, out);
    else if (e.isFile()) out.push({ rel: childRel, abs: path.join(root, childRel) });
  }
  return out;
}

function storeObject(vaultPath: string, buf: Buffer): string {
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  const abs = objectPath(vaultPath, sha);
  if (!fs.existsSync(abs)) atomicWrite(abs, buf);
  return sha;
}

const SHA_RE = /^[0-9a-f]{64}$/;

function assertSha(sha: unknown): asserts sha is string {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new Error(`invalid object id in history: ${String(sha)}`);
  }
}

/** Reject version file paths that could escape the destination folder. */
function assertSafeRel(rel: string): void {
  if (
    typeof rel !== "string" ||
    rel.length === 0 ||
    rel.startsWith("/") ||
    rel.startsWith("\\") ||
    /^[a-zA-Z]:/.test(rel) ||
    path.isAbsolute(rel) ||
    rel.split(/[\\/]/).some((seg) => seg === ".." || seg === "")
  ) {
    throw new Error(`invalid file path in history: ${rel}`);
  }
}

export function readObject(vaultPath: string, sha: string): Buffer {
  assertSha(sha);
  return fs.readFileSync(objectPath(vaultPath, sha));
}

/**
 * Missing file → empty history. Present but unparseable (bad JSON, git
 * conflict markers, wrong shape) → throws, so callers never silently
 * overwrite or GC against it.
 */
function readVersionsFile(vaultPath: string, skill: string): VersionsFile {
  const file = versionsPath(vaultPath, skill);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { skill, versions: [] };
    throw new Error(`cannot read history file ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`history file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const vf = parsed as VersionsFile | null;
  if (!vf || typeof vf !== "object" || !Array.isArray(vf.versions)) {
    throw new Error(`history file ${file} has no versions array`);
  }
  return vf;
}

function writeVersionsFile(vaultPath: string, skill: string, file: VersionsFile): void {
  atomicWrite(versionsPath(vaultPath, skill), JSON.stringify(file, null, 2) + "\n");
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function newId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function recordVersion(
  vaultPath: string,
  skill: string,
  opts: RecordOptions,
): HistoryVersion | null {
  const dir = opts.dir ?? path.join(vaultPath, "skills", skill);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;

  let vf: VersionsFile;
  try {
    vf = readVersionsFile(vaultPath, skill);
  } catch (err) {
    // Leave the unreadable file exactly as it is for the user to repair.
    console.error(`[history] not recording ${skill}: ${(err as Error).message}`);
    return null;
  }

  const files: Record<string, string> = {};
  for (const f of collectFiles(dir)) {
    files[f.rel] = storeObject(vaultPath, fs.readFileSync(f.abs));
  }

  const side = opts.side ?? "vault";
  const normalized = hashSkillDirNormalized(dir);
  const latestSameSide = [...vf.versions].reverse().find((v) => v.side === side);
  if (
    !opts.always &&
    latestSameSide &&
    (sameFiles(latestSameSide.files, files) ||
      (normalized !== null &&
        latestSameSide.normalized_hash != null &&
        latestSameSide.normalized_hash === normalized))
  ) {
    return null;
  }

  const version: HistoryVersion = {
    id: newId(),
    at: new Date().toISOString(),
    side,
    source: opts.source,
    ...(opts.note ? { note: opts.note } : {}),
    files,
    normalized_hash: normalized,
    ...(opts.manifest_entry !== undefined ? { manifest_entry: opts.manifest_entry } : {}),
  };
  vf.versions.push(version);
  const max = readHistoryConfig(vaultPath).max_versions;
  if (vf.versions.length > max) vf.versions.splice(0, vf.versions.length - max);
  writeVersionsFile(vaultPath, skill, vf);
  return version;
}

export function listVersions(vaultPath: string, skill: string): HistoryVersion[] {
  return [...readVersionsFile(vaultPath, skill).versions].reverse();
}

export function getVersion(vaultPath: string, skill: string, id: string): HistoryVersion | null {
  return readVersionsFile(vaultPath, skill).versions.find((v) => v.id === id) ?? null;
}

export function materializeVersion(
  vaultPath: string,
  version: HistoryVersion,
  destDir: string,
): void {
  const entries = Object.entries(version.files);
  for (const [rel, sha] of entries) {
    assertSafeRel(rel);
    assertSha(sha);
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const [rel, sha] of entries) {
    const abs = path.join(destDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, readObject(vaultPath, sha));
  }
}

export function withHistory<T>(
  vaultPath: string,
  skill: string,
  source: HistorySource,
  fn: () => T,
  note?: string,
): T {
  recordVersion(vaultPath, skill, { source: "external-edit", note: "unrecorded prior state" });
  const result = fn();
  recordVersion(vaultPath, skill, { source, note });
  return result;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-hist-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function diffVersion(
  vaultPath: string,
  skill: string,
  id: string,
  against = "current",
): SkillDiff {
  const version = getVersion(vaultPath, skill, id);
  if (!version) throw new Error(`version ${id} not found for ${skill}`);
  return withTempDir((oldDir) => {
    materializeVersion(vaultPath, version, oldDir);
    if (against === "current") {
      return computeSkillDiff(oldDir, path.join(vaultPath, "skills", skill));
    }
    const other = getVersion(vaultPath, skill, against);
    if (!other) throw new Error(`version ${against} not found for ${skill}`);
    return withTempDir((newDir) => {
      materializeVersion(vaultPath, other, newDir);
      return computeSkillDiff(oldDir, newDir);
    });
  });
}

export function restoreVersion(vaultPath: string, skill: string, id: string): HistoryVersion {
  const version = getVersion(vaultPath, skill, id);
  if (!version) throw new Error(`version ${id} not found for ${skill}`);
  const dir = path.join(vaultPath, "skills", skill);

  // Validate everything before touching the live folder: every path safe,
  // every object present. A broken version must not cost the current state.
  for (const [rel, sha] of Object.entries(version.files)) {
    assertSafeRel(rel);
    assertSha(sha);
    if (!fs.existsSync(objectPath(vaultPath, sha))) {
      throw new Error(`cannot restore ${skill}: object ${sha} for ${rel} is missing`);
    }
  }

  recordVersion(vaultPath, skill, { source: "external-edit", note: "unrecorded prior state" });

  // Build the restored folder next to the live one (the watcher ignores
  // ".temp-" path segments), then swap it into place. The old folder is
  // moved aside rather than deleted first, so a failed swap can put it back.
  const suffix = `${skill}-${crypto.randomBytes(4).toString("hex")}`;
  const tmp = path.join(vaultPath, "skills", `.temp-restore-${suffix}`);
  const aside = path.join(vaultPath, "skills", `.temp-restore-old-${suffix}`);
  try {
    materializeVersion(vaultPath, version, tmp);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const hadDir = fs.existsSync(dir);
  try {
    if (hadDir) fs.renameSync(dir, aside);
    fs.renameSync(tmp, dir);
  } catch (err) {
    if (hadDir && !fs.existsSync(dir) && fs.existsSync(aside)) fs.renameSync(aside, dir);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(aside, { recursive: true, force: true });

  // A restore may be bringing back a skill whose manifest entry was
  // removed (e.g. DELETE /api/skills/:name deletes both the folder and
  // the manifest key). If the skill isn't in the manifest, seed it from
  // the newest recorded manifest_entry (newest first) so tags/targets/
  // stage/source come back too, instead of silently reverting to a bare
  // vault-only skill. Never overwrite an existing manifest entry.
  if (!readManifest(vaultPath).skills[skill]) {
    const versions = readVersionsFile(vaultPath, skill).versions;
    let seed: ManifestSkill = { targets: [] };
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i].manifest_entry !== undefined) {
        seed = versions[i].manifest_entry as ManifestSkill;
        break;
      }
    }
    upsertManifestSkill(vaultPath, skill, seed);
  }

  return recordVersion(vaultPath, skill, {
    source: "restore",
    note: `restored version from ${version.at}`,
    always: true,
  })!;
}
