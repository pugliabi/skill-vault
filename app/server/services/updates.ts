/**
 * Update-from-source service.
 *
 * Skills adopted with a structured `origin` (see docs/vault-format.md
 * § SkillEntry.origin) can be re-checked against their source and, when the
 * source moved on, overwritten with the upstream content.
 *
 * `checkUpdates` is strictly read-only on the vault: it resolves each
 * origin (optionally `git pull`ing a local clone, or shallow-cloning a
 * remote into a temp dir), hashes the upstream copy with the same
 * normalized algorithm the CLI uses, and reports a three-way status
 * (recorded-at-adopt vs vault-now vs upstream-now). `applyUpdates` then
 * overwrites only the skills the user selected, refreshing
 * `origin.content_hash`/`adopted_at`.
 *
 * Temp clones made during a check are deliberately left alive so the
 * apply step can reuse them; the client calls POST /api/adopt/cleanup with
 * each `tmp_path` when its dialog closes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ApplyUpdatesResult,
  SkillOrigin,
  UpdateCheckResult,
  UpdateStatus,
} from "../types/vault.ts";
import { copyRecursive } from "./adoption.ts";
import { hashSkillDirNormalized } from "./skillHash.ts";
import { patchManifestSkill, readManifest, skillDir } from "./vault.ts";
import { withHistory } from "./history.ts";
import { isFile } from "./fsUtil.ts";

/** How one origin's source root got resolved for this request. */
interface ResolvedSource {
  /** Directory the origin's `subpath`s are relative to; null if unusable. */
  root: string | null;
  /** Temp clone dir when we cloned; callers propagate it for reuse/cleanup. */
  tmpPath?: string;
  gitPulled?: boolean;
  /** Failure/detail note attached to every skill of this source. */
  message?: string;
  /** Status forced on every skill of this source (clone failed, path gone). */
  fatal?: Extract<UpdateStatus, "source_missing" | "error">;
}

function sourceKey(origin: SkillOrigin): string {
  return origin.type === "git"
    ? `git\0${origin.url ?? ""}\0${origin.ref ?? ""}`
    : `${origin.type}\0${origin.path ?? ""}`;
}

/**
 * Resolve one origin's source root. Local paths are used in place (with a
 * best-effort `git pull --ff-only` when they are git checkouts); remote git
 * origins are shallow-cloned to a temp dir. Never throws — failures come
 * back as `fatal`/`message` so one broken source can't sink the whole check.
 */
async function resolveSource(origin: SkillOrigin, seq: number, pull: boolean): Promise<ResolvedSource> {
  if (origin.type === "git" && !origin.path) {
    if (!origin.url) {
      return { root: null, fatal: "error", message: "origin has no url or path" };
    }
    const tmpDir = path.join(os.tmpdir(), `sv-update-${Date.now()}-${seq}`);
    try {
      const { simpleGit } = await import("simple-git");
      const args = ["--depth", "1", ...(origin.ref ? ["--branch", origin.ref] : [])];
      await simpleGit().clone(origin.url, tmpDir, args);
      return { root: tmpDir, tmpPath: tmpDir };
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
      return {
        root: null,
        fatal: "error",
        message: `clone failed: ${(err as Error).message}`,
      };
    }
  }

  const root = origin.path;
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { root: null, fatal: "source_missing", message: `source path missing: ${root ?? "(none)"}` };
  }
  if (!fs.existsSync(path.join(root, ".git")) || !pull) {
    return { root };
  }
  // A local git checkout: freshen it first so "check for updates" means
  // "against the remote", not "against whenever I last pulled". Any
  // failure (git absent, diverged branch, offline) degrades to comparing
  // the checkout as-is. Callers pass pull:false to compare as-is (e.g. a
  // policy of no background git activity).
  try {
    const { simpleGit } = await import("simple-git");
    await simpleGit(root).pull(["--ff-only"]);
    return { root, gitPulled: true };
  } catch (err) {
    const msg = (err as Error).message.split("\n")[0];
    return { root, gitPulled: false, message: `git pull failed — compared without pull (${msg})` };
  }
}

/**
 * When the recorded `subpath` no longer exists, look for the skill under a
 * new location: a directory named `<skill>` containing a SKILL.md anywhere
 * under the source root. Exactly one match = the skill moved; zero or many
 * = give up and report `upstream_missing`.
 */
function recoverMovedSkill(root: string, name: string): string | null {
  const IGNORE = new Set([
    "node_modules", "__pycache__", ".git", "dist", ".next", ".turbo",
    ".venv", "venv", "build", "target", "bin", "obj", ".idea", ".vscode",
  ]);
  const matches: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || matches.length > 1) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name === name && isFile(path.join(full, "SKILL.md"))) {
        matches.push(full);
        if (matches.length > 1) return;
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return matches.length === 1 ? matches[0] : null;
}

function threeWay(
  vault: string | null,
  upstream: string,
  recorded: string,
): { status: UpdateStatus; message?: string } {
  if (vault === null) {
    return { status: "update_available", message: "vault copy missing — update will restore it" };
  }
  if (upstream === vault) return { status: "up_to_date" };
  if (vault === recorded) return { status: "update_available" };
  if (upstream === recorded) return { status: "local_changed" };
  return { status: "conflict" };
}

/**
 * Check the given skills (or every skill with an origin) against their
 * sources. Read-only; each distinct source is pulled/cloned at most once
 * per call.
 */
export async function checkUpdates(
  vaultPath: string,
  names?: string[],
  opts: { pull?: boolean } = {},
): Promise<UpdateCheckResult[]> {
  const pull = opts.pull !== false;
  const manifest = readManifest(vaultPath);
  const targets: { name: string; origin?: SkillOrigin }[] = [];
  if (names && names.length > 0) {
    for (const name of names) {
      targets.push({ name, origin: manifest.skills[name]?.origin });
    }
  } else {
    for (const [name, entry] of Object.entries(manifest.skills)) {
      if (entry.origin) targets.push({ name, origin: entry.origin });
    }
  }

  // Resolve each distinct source once (one pull / one clone per repo even
  // when many skills came from it).
  const sources = new Map<string, ResolvedSource>();
  let seq = 0;
  for (const t of targets) {
    if (!t.origin) continue;
    const key = sourceKey(t.origin);
    if (!sources.has(key)) {
      sources.set(key, await resolveSource(t.origin, seq++, pull));
    }
  }

  const results: UpdateCheckResult[] = [];
  for (const { name, origin } of targets) {
    if (!origin) {
      results.push({ name, status: "no_origin" });
      continue;
    }
    const src = sources.get(sourceKey(origin))!;
    const base: UpdateCheckResult = {
      name,
      status: "error",
      origin,
      recorded_hash: origin.content_hash,
      ...(src.tmpPath ? { tmp_path: src.tmpPath } : {}),
      ...(src.gitPulled !== undefined ? { git_pulled: src.gitPulled } : {}),
      ...(src.message ? { message: src.message } : {}),
    };
    if (src.fatal || src.root === null) {
      results.push({ ...base, status: src.fatal ?? "error" });
      continue;
    }

    let upstreamDir = origin.subpath
      ? path.join(src.root, ...origin.subpath.split("/"))
      : src.root;
    let moved: string | undefined;
    if (!fs.existsSync(upstreamDir)) {
      const recovered = recoverMovedSkill(src.root, name);
      if (!recovered) {
        results.push({ ...base, status: "upstream_missing" });
        continue;
      }
      upstreamDir = recovered;
      moved = `moved to ${path.relative(src.root, recovered).replace(/\\/g, "/")}`;
    }

    const upstreamHash = hashSkillDirNormalized(upstreamDir);
    if (upstreamHash === null) {
      results.push({ ...base, status: "upstream_missing" });
      continue;
    }
    const vaultHash = hashSkillDirNormalized(skillDir(vaultPath, name));
    const verdict = threeWay(vaultHash, upstreamHash, origin.content_hash);
    results.push({
      ...base,
      status: verdict.status,
      vault_hash: vaultHash ?? undefined,
      upstream_hash: upstreamHash,
      upstream_path: upstreamDir,
      message: [base.message, moved, verdict.message].filter(Boolean).join("; ") || undefined,
    });
  }
  return results;
}

/**
 * Overwrite the selected vault skills with their upstream content.
 * `upstream_path` from a prior check is reused when it still exists;
 * otherwise the origin is re-resolved (including a fresh clone for remote
 * git origins — those clones are removed before returning).
 */
export async function applyUpdates(
  vaultPath: string,
  items: { name: string; upstream_path?: string; tmp_path?: string }[],
): Promise<ApplyUpdatesResult> {
  const manifest = readManifest(vaultPath);
  const updated: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const ownClones: string[] = [];
  const freshSources = new Map<string, ResolvedSource>();
  let seq = 0;

  try {
    for (const item of items) {
      const entry = manifest.skills[item.name];
      const origin = entry?.origin;
      if (!origin) {
        skipped.push({ name: item.name, reason: "no origin recorded" });
        continue;
      }

      // Root the recorded subpath resolves against, for re-deriving the
      // subpath when the check followed a rename.
      let sourceRoot: string | undefined = item.tmp_path ?? origin.path;
      let upstreamDir: string | undefined =
        item.upstream_path && fs.existsSync(item.upstream_path)
          ? item.upstream_path
          : undefined;

      if (!upstreamDir) {
        const key = sourceKey(origin);
        if (!freshSources.has(key)) {
          const resolved = await resolveSource(origin, seq++, true);
          if (resolved.tmpPath) ownClones.push(resolved.tmpPath);
          freshSources.set(key, resolved);
        }
        const src = freshSources.get(key)!;
        if (!src.root) {
          skipped.push({ name: item.name, reason: src.message ?? "source unavailable" });
          continue;
        }
        sourceRoot = src.root;
        upstreamDir = origin.subpath
          ? path.join(src.root, ...origin.subpath.split("/"))
          : src.root;
        if (!fs.existsSync(upstreamDir)) {
          const recovered = recoverMovedSkill(src.root, item.name);
          if (!recovered) {
            skipped.push({ name: item.name, reason: "skill no longer present in source" });
            continue;
          }
          upstreamDir = recovered;
        }
      }

      const dest = skillDir(vaultPath, item.name);
      withHistory(vaultPath, item.name, "update", () => {
        fs.rmSync(dest, { recursive: true, force: true });
        copyRecursive(upstreamDir, dest);
      }, "updated from source");

      const newSubpath =
        sourceRoot && upstreamDir.startsWith(sourceRoot)
          ? path.relative(sourceRoot, upstreamDir).replace(/\\/g, "/")
          : origin.subpath;
      // Spread the existing origin so unknown keys inside it round-trip.
      patchManifestSkill(vaultPath, item.name, {
        origin: {
          ...origin,
          subpath: newSubpath,
          content_hash: hashSkillDirNormalized(dest) ?? "empty",
          adopted_at: new Date().toISOString(),
        },
      });
      updated.push(item.name);
    }
  } finally {
    for (const clone of ownClones) {
      fs.rmSync(clone, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  return { updated, skipped };
}
