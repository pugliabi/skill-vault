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

// ---------------------------------------------------------------------------
// Normalized skill-content hash — exact port of hash_directory() in
// src/skill_vault/hashing.py. This is the canonical algorithm for
// `origin.content_hash` and `.sync-log.json` (see docs/vault-format.md
// "Content hash algorithm"): both the CLI and the app must produce identical
// digests for the same tree, so every detail below (skip set, binary set,
// whitespace normalization, sort order) mirrors the Python implementation.
// Do NOT reuse IGNORE_NAMES / hashSkillFolder here — that hash is a
// different, app-internal format used for provider drift badges.

const NORMALIZED_SKIP = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".DS_Store",
  "Thumbs.db",
]);

// Verbatim from _BINARY_EXTS in hashing.py.
const NORMALIZED_BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".zip", ".gz", ".tar", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".pptx",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pyc", ".pyo", ".so", ".dll", ".exe",
  ".bin", ".dat", ".db", ".sqlite",
]);

// Line boundaries recognised by Python str.splitlines() (CRLF counts once).
const SPLITLINES_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

// Trailing chars stripped by Python str.rstrip(): the isspace() set (minus
// line boundaries, which never appear inside a split line). Deliberately not
// String.prototype.trimEnd — that also strips U+FEFF, which Python does not
// consider whitespace.
const RSTRIP_RE =
  /[ \t\f\v\x1c\x1d\x1e\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Normalized hash of one file's bytes — the per-file step of the canonical
 * algorithm, exposed so callers with in-memory content (zip entries in the
 * desktop backfill) produce digests identical to on-disk hashing.
 */
export function normalizedContentHash(fileName: string, raw: Buffer): string {
  const ext = path.extname(fileName).toLowerCase();
  if (NORMALIZED_BINARY_EXTS.has(ext)) {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }
  const text = UTF8_DECODER.decode(raw);
  const normalized = text
    .split(SPLITLINES_RE)
    .map((line) => line.replace(RSTRIP_RE, ""))
    .join("\n")
    .replace(/\n+$/, "");
  return crypto.createHash("sha256").update(Buffer.from(normalized, "utf8")).digest("hex");
}

function normalizedFileHash(abs: string, fileName: string): string {
  return normalizedContentHash(fileName, fs.readFileSync(abs));
}

function walkNormalized(rootDir: string, rel: string, out: string[]): void {
  const abs = path.join(rootDir, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (NORMALIZED_SKIP.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkNormalized(rootDir, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
}

/**
 * Canonical normalized content hash of a skill directory. Matches the Python
 * `hash_directory` byte-for-byte: whitespace-normalized text (CRLF/LF and
 * trailing-whitespace insensitive), raw bytes for known binary extensions,
 * files ordered by lowercased "/"-separated relative path, final digest =
 * sha256 of the concatenated per-file hex digests. Returns `"empty"` for an
 * existing directory with no hashable files and `null` when the directory
 * is missing.
 */
export function hashSkillDirNormalized(rootDir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(rootDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const rels: string[] = [];
  walkNormalized(rootDir, "", rels);
  rels.sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const hashes: string[] = [];
  for (const rel of rels) {
    try {
      hashes.push(normalizedFileHash(path.join(rootDir, rel), rel));
    } catch {
      // Unreadable file: skip, matching the practical effect of the CLI
      // never being pointed at files it cannot read.
    }
  }
  if (hashes.length === 0) return "empty";
  return crypto.createHash("sha256").update(hashes.join(""), "ascii").digest("hex");
}

/**
 * Canonical normalized content hash over an in-memory file list (the zip
 * variant of hashSkillDirNormalized, used by the desktop backfill). `rel`
 * paths must be "/"-separated relative to the skill root. Applies the same
 * skip set, sort order, and combination as the directory walker, so a zip
 * whose entries match a directory's files byte-for-byte produces the same
 * digest. Returns `"empty"` when nothing hashable remains.
 */
export function hashFileBuffersNormalized(
  files: Array<{ rel: string; data: Buffer }>,
): string {
  const eligible = files.filter(
    (f) => !f.rel.split("/").some((seg) => NORMALIZED_SKIP.has(seg)),
  );
  eligible.sort((a, b) => {
    const x = a.rel.toLowerCase();
    const y = b.rel.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const hashes = eligible.map((f) => normalizedContentHash(f.rel, f.data));
  if (hashes.length === 0) return "empty";
  return crypto.createHash("sha256").update(hashes.join(""), "ascii").digest("hex");
}
