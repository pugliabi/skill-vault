/**
 * Cross-platform symlink / junction / copy.
 *
 * TypeScript port of `src/skill_vault/linking.py` — same fallback chain,
 * same circular-link guards, same behavior. Independent implementation:
 * the two codebases share the algorithm through documentation
 * (`docs/vault-format.md`), not through shared code.
 *
 * Fallback order:
 *   1. `fs.symlinkSync(..., "junction")` — works without admin on
 *      Windows for directory targets (Node maps this to junction on
 *      Windows and to a real symlink on POSIX).
 *   2. `mklink /j` via cmd.exe — strictly Windows, used only if (1)
 *      throws for some reason (antivirus, unusual filesystem).
 *   3. Full recursive copy — always works, but loses the live-link
 *      property (edits on one side no longer propagate).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export type LinkMethod = "symlink" | "junction" | "copy" | "skip";

export interface LinkResult {
  method: LinkMethod;
  target: string;
  source: string;
  /** Set when method === "skip" to explain why. */
  reason?: string;
}

const IS_WINDOWS = os.platform() === "win32";

const IGNORE_NAMES = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  "Thumbs.db",
  ".DS_Store",
]);
function isIgnored(name: string): boolean {
  if (IGNORE_NAMES.has(name)) return true;
  if (name.startsWith(".temp-")) return true;
  if (name.endsWith(".tmp")) return true;
  return false;
}

// ── Link detection ──────────────────────────────────────────────

/** True if `p` is a symlink OR a Windows junction (reparse point). */
export function isLink(p: string): boolean {
  try {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return true;
    // Node's lstat sets isDirectory() for junctions but doesn't flag
    // them as symlinks. Use readlinkSync as a probe — it succeeds on
    // junctions and throws EINVAL on plain dirs.
    if (IS_WINDOWS && stat.isDirectory()) {
      try {
        fs.readlinkSync(p);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolve a symlink/junction to its real target, or null if not a link. */
export function resolveLink(p: string): string | null {
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isSymbolicLink() && !(IS_WINDOWS && stat.isDirectory())) {
      return null;
    }
    if (IS_WINDOWS && stat.isDirectory() && !stat.isSymbolicLink()) {
      try {
        return path.resolve(fs.readlinkSync(p));
      } catch {
        return null;
      }
    }
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Remove a path cleanly whether it's a symlink, junction, or real dir.
 * Handles the "broken junction" case (target deleted) on Windows, which
 * causes `fs.rmSync` to throw ENOENT.
 */
export function unlinkOrRemove(p: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // already gone
  }

  if (stat.isSymbolicLink()) {
    fs.unlinkSync(p);
    return;
  }

  if (IS_WINDOWS && isLink(p)) {
    // Junction: rmdir removes the reparse point without touching target.
    try {
      fs.rmdirSync(p);
      return;
    } catch {
      // Fall through to cmd /c rmdir — works even on broken junctions.
      spawnSync("cmd", ["/c", "rmdir", p], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (!fs.existsSync(p)) return;
    }
  }

  if (stat.isDirectory()) {
    fs.rmSync(p, { recursive: true, force: true });
  } else {
    fs.unlinkSync(p);
  }
}

// ── Fallback primitives ─────────────────────────────────────────

function trySymlink(source: string, target: string): boolean {
  try {
    // "junction" on Windows (no admin), real symlink on POSIX.
    fs.symlinkSync(source, target, "junction");
    return true;
  } catch {
    return false;
  }
}

function tryMklinkJunction(source: string, target: string): boolean {
  if (!IS_WINDOWS) return false;
  const result = spawnSync("cmd", ["/c", "mklink", "/j", target, source], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function copyDirectory(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      // Dereference once and copy as a regular file/dir.
      const real = fs.realpathSync(srcPath);
      const realStat = fs.statSync(real);
      if (realStat.isDirectory()) {
        copyDirectory(real, destPath);
      } else {
        fs.copyFileSync(real, destPath);
      }
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Main entry ──────────────────────────────────────────────────

/**
 * Link (or copy) a skill directory from `source` (in vault) to
 * `target` (in provider's skills dir).
 *
 * Guards against circular links: if `source` and `target` resolve to
 * the same path, or if one is an ancestor of the other, returns a
 * `skip` result instead of creating an infinite loop. This is the
 * fix for the "skills/skills/skills" doubled-path bug the Python CLI
 * had before its own guards were added.
 */
export function linkSkillDir(
  source: string,
  target: string,
  opts: { forceCopy?: boolean } = {},
): LinkResult {
  const absSource = path.resolve(source);
  // target may not exist yet — resolve the parent and rejoin
  const absTarget = fs.existsSync(target)
    ? path.resolve(target)
    : path.join(path.resolve(path.dirname(target)), path.basename(target));

  // Circular guards
  if (absSource === absTarget) {
    return {
      method: "skip",
      target: absTarget,
      source: absSource,
      reason: "source and target are the same path",
    };
  }
  if (isAncestor(absSource, absTarget)) {
    return {
      method: "skip",
      target: absTarget,
      source: absSource,
      reason: "target is inside source (would create a loop)",
    };
  }
  if (isAncestor(absTarget, absSource)) {
    return {
      method: "skip",
      target: absTarget,
      source: absSource,
      reason: "source is inside target (would create a loop)",
    };
  }

  // Already linked correctly?
  if (fs.existsSync(absTarget) && isLink(absTarget)) {
    const resolved = resolveLink(absTarget);
    if (resolved && path.resolve(resolved) === absSource) {
      return { method: "symlink", target: absTarget, source: absSource };
    }
  }

  // Make sure the parent dir exists.
  fs.mkdirSync(path.dirname(absTarget), { recursive: true });

  // Remove stale target.
  if (fs.existsSync(absTarget) || isLink(absTarget)) {
    unlinkOrRemove(absTarget);
  }

  if (opts.forceCopy) {
    copyDirectory(absSource, absTarget);
    return { method: "copy", target: absTarget, source: absSource };
  }

  if (trySymlink(absSource, absTarget)) {
    return { method: "symlink", target: absTarget, source: absSource };
  }

  if (tryMklinkJunction(absSource, absTarget)) {
    return { method: "junction", target: absTarget, source: absSource };
  }

  copyDirectory(absSource, absTarget);
  return { method: "copy", target: absTarget, source: absSource };
}

/**
 * True if `ancestor` contains `descendant` (or they're equal).
 *
 * Uses path segments, not string prefix matching, so `/foo/bar` is
 * correctly NOT considered an ancestor of `/foo/bar-baz`.
 */
function isAncestor(ancestor: string, descendant: string): boolean {
  const rel = path.relative(ancestor, descendant);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
