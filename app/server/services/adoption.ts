/**
 * Adoption service.
 *
 * "Adopt" = scan a provider's skills directory (e.g. `~/.claude/skills`),
 * find skill folders, and copy chosen ones into the user's vault while
 * updating `skills.json`.
 *
 * We copy rather than link here: adoption is the *ingestion* step, not
 * the *distribution* step. After adoption the user can separately push
 * the skill back out to providers via the Push flow (which DOES link).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdoptImportRequest,
  AdoptScanResult,
  ManifestSkill,
  SkillOrigin,
} from "../types/vault.ts";
import { hashSkillDirNormalized } from "./skillHash.ts";
import {
  listSkills,
  readManifest,
  skillDir,
  skillsDir,
  upsertManifestSkill,
} from "./vault.ts";

/**
 * Scan a directory for skill folders.
 *
 *   recursive=false (default): treat `providerPath` like a flat skills
 *     directory (e.g. `~/.claude/skills/`) — every immediate subdir is
 *     a candidate. Fast, used by the Adopt page's standard flow.
 *
 *   recursive=true: walk the tree and return every directory that
 *     contains a SKILL.md. Used for `sv scan <repo>` — finding skills
 *     buried in a code repo, not a flat skills dir. Capped depth/count
 *     so a wrong path doesn't blow out the response.
 */
export interface ScanResult {
  results: AdoptScanResult[];
  /** True when the walk hit MAX_RECURSIVE_HITS and stopped early. */
  truncated: boolean;
}

export function scanForSkills(
  providerPath: string,
  vaultPath: string,
  recursive = false,
): ScanResult {
  // Stat directly rather than existsSync-then-stat: existsSync collapses
  // EVERY error (permission denied, unreachable network/WSL share, …) into
  // a bare `false`, which then surfaces as a misleading "does not exist".
  // A `\\wsl.localhost\…` share whose 9P mount failed auth throws UNKNOWN
  // here, not ENOENT — distinguish so the user knows it's a reachability
  // problem, not a typo.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(providerPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Provider path does not exist: ${providerPath}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Provider path is not accessible (permission denied): ${providerPath}`);
    }
    // UNKNOWN is what a dropped/unauthenticated \\wsl.localhost or network
    // share yields on Windows.
    throw new Error(
      `Provider path could not be reached (${code ?? "unknown error"}) — ` +
        `if this is a WSL or network share (e.g. \\\\wsl.localhost\\…), it may be ` +
        `unmounted or owned by a different user session: ${providerPath}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`Provider path is not a directory: ${providerPath}`);
  }

  const existing = new Set(listSkills(vaultPath).map((s) => s.name));
  const out: AdoptScanResult[] = [];
  const state = { truncated: false };

  if (recursive) {
    // Walk the whole tree and return EVERY folder that has a SKILL.md.
    //
    // Collect every SKILL.md folder, then collapse *identical* skills.
    //
    // Scanning a parent folder full of repos surfaces the same skill many
    // times — forks, vendored copies, and mirrored `awesome-skills` lists
    // repeat byte-for-byte across repos. Showing all of those is just noise.
    // So we dedupe by (name + content signature): identical copies become
    // ONE row (with `dup_count` = how many copies exist), while two skills
    // that merely share a name but differ in content stay as separate rows
    // the user can choose between. The representative is the shallowest path
    // (the most canonical location).
    walkForSkillFolders(providerPath, providerPath, 0, existing, out, state);
    const byKey = new Map<string, AdoptScanResult>();
    for (const r of out) {
      const key = `${r.name}\0${r.sig ?? ""}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...r, dup_count: 1 });
      } else {
        const count = (prev.dup_count ?? 1) + 1;
        // Keep the shallower path as the representative; carry the count.
        if (relSegments(r.rel_path) < relSegments(prev.rel_path)) {
          byKey.set(key, { ...r, dup_count: count });
        } else {
          prev.dup_count = count;
        }
      }
    }
    out.length = 0;
    out.push(...byKey.values());
  } else {
    const entries = fs.readdirSync(providerPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      // Accept both plain directories and symlinks/junctions that resolve
      // to directories — provider paths like `~/.claude/skills/` are
      // typically full of junctions to vault entries.
      let isDir = entry.isDirectory();
      if (!isDir && (entry.isSymbolicLink() || os.platform() === "win32")) {
        try {
          isDir = fs.statSync(path.join(providerPath, entry.name)).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      const full = path.join(providerPath, entry.name);
      pushSkillResult(providerPath, full, existing, out, fs.existsSync(path.join(full, "SKILL.md")));
    }
  }

  // Sort by name, then by source path so duplicate names cluster together
  // and are stably ordered across scans.
  out.sort((a, b) =>
    a.name.localeCompare(b.name) || (a.rel_path ?? "").localeCompare(b.rel_path ?? ""),
  );
  flagUpdateAvailable(vaultPath, out);
  return { results: out, truncated: state.truncated };
}

/**
 * For rows already in the vault, mark whether re-adopting would actually
 * change the vault copy. Fast path first: the SKILL.md signature (`sig`,
 * already computed per row) is compared against the vault side's — a
 * differing sig proves the content differs without hashing whole dirs.
 * Equal sigs (or both sides missing SKILL.md) fall back to the normalized
 * dir hash, since non-SKILL.md files can still differ. Only in-vault rows
 * pay any of this, so huge recursive scans stay cheap.
 */
function flagUpdateAvailable(vaultPath: string, rows: AdoptScanResult[]): void {
  const vaultSigs = new Map<string, string>();
  const vaultHashes = new Map<string, string | null>();
  for (const row of rows) {
    if (!row.already_in_vault) continue;
    const dest = skillDir(vaultPath, row.name);
    if (!vaultSigs.has(row.name)) {
      vaultSigs.set(row.name, readSkillMeta(dest).sig);
    }
    if ((row.sig ?? "") !== vaultSigs.get(row.name)) {
      row.update_available = true;
      continue;
    }
    if (!vaultHashes.has(row.name)) {
      vaultHashes.set(row.name, hashSkillDirNormalized(dest));
    }
    row.update_available =
      hashSkillDirNormalized(row.path) !== vaultHashes.get(row.name);
  }
}

const RECURSIVE_IGNORE = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  "dist",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "build",
  "target",
  "bin",
  "obj",
  ".idea",
  ".vscode",
]);
// Deep enough for layouts like `repo/plugins/<x>/skills/<category>/<name>`
// while ignore-pruning keeps the walk cheap. The hits cap is a runaway
// backstop set far above any realistic skills collection; when reached we
// flag `truncated` so the UI can tell the user to narrow the path.
const MAX_RECURSIVE_DEPTH = 12;
const MAX_RECURSIVE_HITS = 30000;

function walkForSkillFolders(
  root: string,
  current: string,
  depth: number,
  existing: Set<string>,
  out: AdoptScanResult[],
  state: { truncated: boolean },
): void {
  if (out.length >= MAX_RECURSIVE_HITS) {
    state.truncated = true;
    return;
  }
  // The depth cap is also the cycle guard: a junction/symlink loop can only
  // recurse MAX_RECURSIVE_DEPTH levels before stopping. (We deliberately
  // avoid fs.realpathSync per-directory — at ~11k skills across deep repo
  // trees that single syscall dominated the scan time.)
  if (depth > MAX_RECURSIVE_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  // If THIS folder has a SKILL.md, treat it as a single skill and stop
  // recursing into it — skills don't nest. Detect it from the entries we
  // just read (case-insensitive) instead of an extra existsSync stat.
  if (depth > 0 && entries.some((e) => e.isFile() && e.name.toLowerCase() === "skill.md")) {
    pushSkillResult(root, current, existing, out, true, entries);
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_RECURSIVE_HITS) {
      state.truncated = true;
      return;
    }
    if (entry.name.startsWith(".")) continue;
    if (RECURSIVE_IGNORE.has(entry.name)) continue;
    // Follow real directories AND junctions/symlinks that resolve to dirs;
    // the depth cap bounds any cycle. Skill repos sometimes junction their
    // skill folders, and on Windows junctions don't report as directories.
    let isDir = entry.isDirectory();
    if (!isDir && (entry.isSymbolicLink() || os.platform() === "win32")) {
      try {
        isDir = fs.statSync(path.join(current, entry.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    walkForSkillFolders(root, path.join(current, entry.name), depth + 1, existing, out, state);
  }
}

/**
 * Push one scan row, computing `rel_path` (relative to the scan root) and
 * `source` (the top-level folder under the root, i.e. the repo name when
 * scanning a parent-of-repos). These let the UI disambiguate same-named
 * skills found in different places.
 */
function pushSkillResult(
  root: string,
  dir: string,
  existing: Set<string>,
  out: AdoptScanResult[],
  hasSkillMd: boolean,
  /** Already-read directory entries, to avoid a second readdir when available. */
  entries?: fs.Dirent[],
): void {
  const name = path.basename(dir);
  const rel = path.relative(root, dir) || name;
  const source = rel.split(/[\\/]+/).filter(Boolean)[0] ?? name;
  const ents = entries ?? safeReaddir(dir);
  const meta = readSkillMeta(dir);
  out.push({
    name,
    path: dir,
    rel_path: rel,
    source,
    file_count: ents.filter((e) => e.isFile()).length,
    has_skill_md: hasSkillMd,
    description: meta.description,
    sig: meta.sig,
    already_in_vault: existing.has(name),
  });
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Number of path segments in a rel_path — used to prefer the shallowest copy. */
function relSegments(rel?: string): number {
  return (rel ?? "").split(/[\\/]+/).filter(Boolean).length;
}

/**
 * Read SKILL.md once and derive both the frontmatter `description` and a
 * content signature (sha1 of the file, line-endings normalized so the same
 * skill checked out on Windows vs Unix hashes identically). The signature
 * powers identical-copy deduplication across repos. Capped at 256 KB so a
 * pathological file can't dominate the scan. Returns empty strings when the
 * file is absent or unreadable.
 */
function readSkillMeta(dir: string): { description: string; sig: string } {
  const md = path.join(dir, "SKILL.md");
  let fd: number | undefined;
  try {
    fd = fs.openSync(md, "r");
    const size = fs.fstatSync(fd).size;
    const cap = Math.min(size, 262144);
    const buf = Buffer.alloc(cap);
    const n = fs.readSync(fd, buf, 0, cap, 0);
    const text = buf.subarray(0, n).toString("utf-8").replace(/\r\n/g, "\n");
    const sig = crypto.createHash("sha1").update(text).digest("hex");
    let description = "";
    const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fm) {
      const m = fm[1].match(/^description:\s*(.+)$/m);
      if (m) description = m[1].trim().replace(/^["']|["']$/g, "");
    }
    return { description, sig };
  } catch {
    return { description: "", sig: "" };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** One skill to import: its vault name and the absolute folder to copy. */
export interface ImportItem {
  name: string;
  path: string;
}

/** Extra behavior flags for {@link importSkills}. */
export interface ImportOptions {
  /**
   * Allow replacing skills already in the vault. Never the default —
   * without it, existing dests are skipped exactly as before. Even with
   * it, a source whose content hashes identical to the vault copy is
   * skipped (nothing to do).
   */
  overwrite?: boolean;
  /** Where this batch came from — recorded as each skill's `origin`. */
  originContext?: AdoptImportRequest["origin_context"];
}

/**
 * Copy a subset of scanned skills into the vault. Updates `skills.json`
 * with a `source` of `"adopted from <provider_id>"` when provided, and a
 * structured `origin` block so the skill can later be updated from its
 * source (see docs/vault-format.md § SkillEntry.origin).
 *
 * Selection arrives one of two ways:
 *   - `items`: explicit {name, path} pairs (used by the scan-based flows,
 *     where the same name can appear from multiple sources and the chosen
 *     path is authoritative). This is the preferred form.
 *   - `names` (+ optional `paths` map keyed by name): the legacy flat form,
 *     still used by Discover. Falls back to `sourceDir/<name>`.
 *
 * The vault is keyed by name, so a name can only be adopted once. When the
 * selection contains two folders with the same name (e.g. `pdf` from two
 * repos) the first is imported and the rest are reported in `skipped`.
 * Overwriting an existing entry preserves its `targets`, `tags`, `stage`,
 * and any unknown manifest keys (round-trip rule) — only the content,
 * `source`, and `origin` are replaced.
 */
export function importSkills(
  vaultPath: string,
  sourceDir: string,
  names: string[],
  providerId?: string,
  paths?: Record<string, string>,
  items?: ImportItem[],
  opts?: ImportOptions,
): { imported: string[]; updated: string[]; skipped: string[] } {
  const work: ImportItem[] =
    items && items.length > 0
      ? items
      : names.map((name) => ({ name, path: paths?.[name] ?? path.join(sourceDir, name) }));

  const imported: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const seenNames = new Set<string>();
  const vaultSkills = skillsDir(vaultPath);
  fs.mkdirSync(vaultSkills, { recursive: true });
  const priorEntries = readManifest(vaultPath).skills;

  for (const item of work) {
    const { name } = item;
    const src = item.path;
    // Same name twice in one batch: only the first can win (the vault key
    // is the name). Report the rest as skipped rather than silently dropping.
    if (seenNames.has(name)) {
      skipped.push(name);
      continue;
    }
    seenNames.add(name);

    const dest = skillDir(vaultPath, name);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      skipped.push(name);
      continue;
    }
    const destExists = fs.existsSync(dest);
    if (destExists && !opts?.overwrite) {
      // Refuse to overwrite an existing vault skill unless explicitly
      // asked. The Adopt UI only enables in-vault rows flagged
      // `update_available` and sends `overwrite` for them; anything else
      // reaching here is a race or user override — skip to avoid
      // silently clobbering local edits.
      skipped.push(name);
      continue;
    }
    if (destExists) {
      if (hashSkillDirNormalized(src) === hashSkillDirNormalized(dest)) {
        skipped.push(name);
        continue;
      }
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyRecursive(src, dest);
    const prior = priorEntries[name];
    upsertManifestSkill(vaultPath, name, {
      // Spread first: preserves tags and any unknown keys on overwrite.
      ...(prior ?? {}),
      targets: prior?.targets ?? [],
      stage: prior?.stage ?? "production",
      source: providerId ? `adopted from ${providerId}` : "adopted",
      origin: buildImportOrigin(dest, src, sourceDir, providerId, opts?.originContext),
    });
    (destExists ? updated : imported).push(name);
  }

  return { imported, updated, skipped };
}

/**
 * Build the `origin` block for one imported skill. With an explicit
 * origin_context from the route, `subpath` is the skill's location under
 * the context root (the scan root, or the temp clone dir for git). Without
 * one (legacy Discover flow) a `provider`/`dir` origin is synthesized from
 * the source directory so every adoption stays trackable.
 */
function buildImportOrigin(
  dest: string,
  src: string,
  sourceDir: string,
  providerId?: string,
  ctx?: AdoptImportRequest["origin_context"],
): SkillOrigin {
  const now = new Date().toISOString();
  const contentHash = hashSkillDirNormalized(dest) ?? "empty";
  const subpathFrom = (root: string): string => {
    const rel = path.relative(root, src);
    return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : "";
  };
  if (ctx) {
    return {
      type: ctx.type,
      ...(ctx.type === "git"
        ? { ...(ctx.url ? { url: ctx.url } : {}), ...(ctx.ref ? { ref: ctx.ref } : {}) }
        : { path: ctx.root }),
      ...(ctx.provider_id ? { provider_id: ctx.provider_id } : {}),
      subpath: subpathFrom(ctx.root),
      adopted_at: now,
      content_hash: contentHash,
    };
  }
  return {
    type: providerId ? "provider" : "dir",
    path: sourceDir,
    ...(providerId ? { provider_id: providerId } : {}),
    subpath: subpathFrom(sourceDir),
    adopted_at: now,
    content_hash: contentHash,
  };
}

/** A single browsable directory entry returned to the folder picker. */
export interface DirEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  /** Absolute path that was listed. */
  path: string;
  /** Parent directory, or null when `path` is a filesystem/drive root. */
  parent: string | null;
  /** Immediate subdirectories of `path`, sorted by name. */
  dirs: DirEntry[];
}

/**
 * The default folder the Adopt picker opens to. A repos checkout root the
 * user keeps their skill repositories under; falls back to the home dir
 * when it doesn't exist on this machine.
 */
export const DEFAULT_ADOPT_PATH = "C:\\Github\\skills-repos";

/**
 * List the immediate subdirectories of `dir` for the folder picker. When
 * `dir` is empty/missing we open at {@link DEFAULT_ADOPT_PATH} if it
 * exists, otherwise the user's home directory. Hidden dirs and the usual
 * noise (`node_modules`, `.git`, …) are filtered out.
 */
export function browseDirs(dir?: string): BrowseResult {
  let target = dir?.trim() || "";
  if (!target || !fs.existsSync(target)) {
    target = fs.existsSync(DEFAULT_ADOPT_PATH) ? DEFAULT_ADOPT_PATH : os.homedir();
  }
  target = path.resolve(target);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${target}`);
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read directory: ${(err as Error).message}`);
  }

  const dirs: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (RECURSIVE_IGNORE.has(entry.name)) continue;
    let isDir = entry.isDirectory();
    if (!isDir && (entry.isSymbolicLink() || os.platform() === "win32")) {
      try {
        isDir = fs.statSync(path.join(target, entry.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    dirs.push({ name: entry.name, path: path.join(target, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    dirs,
  };
}

// ── helpers ─────────────────────────────────────────────────────

/** Recursive copy that skips junk dirs. Also used by the updates service. */
export function copyRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
