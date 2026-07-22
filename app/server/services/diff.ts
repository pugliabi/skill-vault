/**
 * File-level diff between a vault skill folder and a provider's copy.
 *
 * Returns an entry per file present in either side, with a unified-style
 * line diff for text files. Binary files and oversized files are
 * reported as "binary" / "too-large" rather than diffed.
 *
 * Caller pairs this with the existing Push (vault wins) and Pull
 * (provider wins) actions for resolution — there is no per-file
 * "merge" because the underlying CLI doesn't do it either, and a
 * three-way merge UI is out of scope.
 */

import fs from "node:fs";
import path from "node:path";

const IGNORE_NAMES = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".DS_Store",
  "Thumbs.db",
]);

export const MAX_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_LINES = 4000;

export type DiffLine =
  | { type: "ctx"; text: string }
  | { type: "add"; text: string }
  | { type: "del"; text: string };

export interface FileDiff {
  /** Path relative to the skill root, forward slashes. */
  path: string;
  change: "added" | "removed" | "modified" | "same";
  /** Why diff body is missing (only set for added/removed/modified). */
  reason?: "binary" | "too-large";
  vault_size?: number;
  target_size?: number;
  hunks?: DiffLine[];
}

export interface SkillDiff {
  files: FileDiff[];
  summary: { added: number; removed: number; modified: number; same: number };
}

export function computeSkillDiff(vaultDir: string, targetDir: string): SkillDiff {
  const vaultFiles = collect(vaultDir);
  const targetFiles = collect(targetDir);
  const all = new Set<string>([...vaultFiles.keys(), ...targetFiles.keys()]);

  const files: FileDiff[] = [];
  for (const rel of [...all].sort()) {
    const v = vaultFiles.get(rel);
    const t = targetFiles.get(rel);
    if (v && !t) {
      files.push({ path: rel, change: "removed", vault_size: v.size });
    } else if (!v && t) {
      files.push({ path: rel, change: "added", target_size: t.size });
    } else if (v && t) {
      if (v.size === t.size && buffersEqual(readSafe(v.abs), readSafe(t.abs))) {
        files.push({ path: rel, change: "same", vault_size: v.size, target_size: t.size });
      } else {
        files.push(buildModified(rel, v, t));
      }
    }
  }

  const summary = {
    added: files.filter((f) => f.change === "added").length,
    removed: files.filter((f) => f.change === "removed").length,
    modified: files.filter((f) => f.change === "modified").length,
    same: files.filter((f) => f.change === "same").length,
  };
  return { files, summary };
}

function buildModified(
  rel: string,
  v: FileEntry,
  t: FileEntry,
): FileDiff {
  if (v.size > MAX_DIFF_BYTES || t.size > MAX_DIFF_BYTES) {
    return {
      path: rel,
      change: "modified",
      reason: "too-large",
      vault_size: v.size,
      target_size: t.size,
    };
  }
  const vBuf = readSafe(v.abs);
  const tBuf = readSafe(t.abs);
  if (!vBuf || !tBuf) {
    return {
      path: rel,
      change: "modified",
      reason: "too-large",
      vault_size: v.size,
      target_size: t.size,
    };
  }
  if (looksBinary(vBuf) || looksBinary(tBuf)) {
    return {
      path: rel,
      change: "modified",
      reason: "binary",
      vault_size: v.size,
      target_size: t.size,
    };
  }
  const a = vBuf.toString("utf-8").split(/\r?\n/);
  const b = tBuf.toString("utf-8").split(/\r?\n/);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return {
      path: rel,
      change: "modified",
      reason: "too-large",
      vault_size: v.size,
      target_size: t.size,
    };
  }
  const hunks = lcsDiff(a, b);
  return {
    path: rel,
    change: "modified",
    vault_size: v.size,
    target_size: t.size,
    hunks,
  };
}

/* ── line-level LCS diff ─────────────────────────────────────────── */

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const m = a.length;
  const n = b.length;
  // dp[i][j] = length of LCS of a[i:], b[j:]
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < m) out.push({ type: "del", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });
  return out;
}

/* ── filesystem helpers ─────────────────────────────────────────── */

interface FileEntry {
  abs: string;
  size: number;
}

function collect(root: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  if (!fs.existsSync(root)) return out;
  walk(root, "", out);
  return out;
}

function walk(root: string, rel: string, out: Map<string, FileEntry>): void {
  const abs = path.join(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORE_NAMES.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      walk(root, childRel, out);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(childAbs);
        out.set(childRel, { abs: childAbs, size: stat.size });
      } catch {
        /* skip unreadable */
      }
    }
  }
}

function readSafe(abs: string): Buffer | null {
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (!a || !b) return false;
  return a.length === b.length && a.equals(b);
}

export function looksBinary(buf: Buffer): boolean {
  // Heuristic: if any of the first 4KB bytes is NUL, treat as binary.
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let k = 0; k < sample.length; k++) {
    if (sample[k] === 0) return true;
  }
  return false;
}
