/**
 * Deterministic content hash of a skill folder.
 *
 * Strategy:
 *   - Walk the directory tree, sorted by relative path
 *   - Skip ignored entries (node_modules, .git, etc. — same set as linking.ts)
 *   - For each file, hash its bytes
 *   - Combine into a single SHA256 of `{relpath}\0{filesha}\n` lines
 *
 * Two folders with identical content produce identical hashes. Used by
 * syncStatus.ts to detect drift between the vault copy and a provider's
 * (possibly copied, not symlinked) copy.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IGNORE_NAMES = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".DS_Store",
  "Thumbs.db",
  ".venv",
  "venv",
  "dist",
  ".next",
  ".turbo",
]);

function shouldIgnore(name: string): boolean {
  return IGNORE_NAMES.has(name) || name.endsWith(".log");
}

/**
 * Compute a deterministic hash of a skill folder. Returns null if the
 * folder doesn't exist (caller can treat as "missing").
 */
export function hashSkillFolder(rootDir: string): string | null {
  if (!fs.existsSync(rootDir)) return null;
  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory()) return null;

  const lines: string[] = [];
  walk(rootDir, "", lines);
  lines.sort(); // determinism — fs.readdir order is platform-dependent

  const combined = crypto.createHash("sha256");
  for (const line of lines) combined.update(line + "\n");
  return combined.digest("hex");
}

function walk(rootDir: string, rel: string, out: string[]): void {
  const abs = path.join(rootDir, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (shouldIgnore(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(rootDir, childRel, out);
    } else if (entry.isFile()) {
      const childAbs = path.join(abs, entry.name);
      const fileHash = hashFile(childAbs);
      if (fileHash) out.push(`${childRel}\0${fileHash}`);
    }
  }
}

function hashFile(abs: string): string | null {
  try {
    const buf = fs.readFileSync(abs);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}
