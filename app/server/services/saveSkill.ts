/**
 * Save a skill from file contents: the server side of the bridge's
 * `save_skill` tool (POST /api/skills/:name/save). An agent that wrote or
 * edited a skill in a chat has no folder on disk to adopt from, so it sends
 * the files themselves.
 *
 * Everything is validated before anything is written. Update is
 * optimistic: every existing file being changed must carry the sha256 the
 * agent read, and one mismatch writes nothing. Files left out are
 * untouched; nothing is ever deleted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IGNORE_NAMES } from "./skillHash.ts";
import { frontmatterValueOf } from "./skillNames.ts";
import { validateSkillName } from "./skillName.ts";
import { readSkillFile, resolveSkillFilePath, skillDir, upsertManifestSkill } from "./vault.ts";

export const SAVE_FILE_CAP_BYTES = 1_048_576;
export const SAVE_TOTAL_CAP_BYTES = 5 * 1_048_576;

export interface SaveFile {
  path: string;
  content: string;
  expected_sha256?: string;
}

export interface SaveRequest {
  mode: "create" | "update";
  files: SaveFile[];
}

export interface SaveResult {
  name: string;
  mode: "create" | "update";
  written: string[];
  unchanged: string[];
}

export interface SaveConflict {
  path: string;
  /** null when the file no longer exists. */
  current_sha256: string | null;
}

/** A refused save; `status` is the HTTP status the route answers with. */
export class SaveError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 413,
    message: string,
    public conflicts?: SaveConflict[],
  ) {
    super(message);
  }
}

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

/** Shape-check the JSON body. */
export function parseSaveRequest(body: unknown): SaveRequest {
  const b = (body ?? {}) as { mode?: unknown; files?: unknown };
  if (b.mode !== "create" && b.mode !== "update") throw new SaveError(400, 'mode must be "create" or "update"');
  if (!Array.isArray(b.files) || b.files.length === 0) throw new SaveError(400, "files must be a non-empty array");
  const files = b.files.map((f, i): SaveFile => {
    const x = (f ?? {}) as Record<string, unknown>;
    if (typeof x.path !== "string" || typeof x.content !== "string") {
      throw new SaveError(400, `files[${i}] needs a string path and content`);
    }
    if (x.expected_sha256 !== undefined && typeof x.expected_sha256 !== "string") {
      throw new SaveError(400, `files[${i}].expected_sha256 must be a string`);
    }
    return {
      path: x.path,
      content: x.content,
      ...(typeof x.expected_sha256 === "string" ? { expected_sha256: x.expected_sha256 } : {}),
    };
  });
  return { mode: b.mode, files };
}

const IGNORED_LOWER = new Set([...IGNORE_NAMES].map((n) => n.toLowerCase()));

/**
 * Why one segment isn't safe, or null. Windows and macOS match names without
 * case, and Windows also opens `.git` as `GIT~1`, `a.md` as `a.md.` or
 * `a.md `, a stream for `a.md:x`, and a device for CON/NUL/COM1...
 */
function segmentProblem(seg: string): string | null {
  if (seg === "" || seg === "." || seg === "..") return 'empty, "." and ".." segments aren\'t allowed';
  if (IGNORED_LOWER.has(seg.toLowerCase())) return `"${seg}" is an ignored folder`;
  if (/[\x00-\x1f<>:"|?*]/.test(seg)) return `"${seg}" has a character Windows doesn't allow`;
  if (/[. ]$/.test(seg)) return `"${seg}" ends in a dot or a space`;
  if (/~\d/.test(seg)) return `"${seg}" looks like a Windows short name`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) return `"${seg}" is a reserved Windows name`;
  return null;
}

/** Why `p` isn't a relative, "/"-separated path with safe segments, or null. */
function pathProblem(p: string): string | null {
  if (p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return 'use a relative path with "/"';
  for (const seg of p.split("/")) {
    const why = segmentProblem(seg);
    if (why) return why;
  }
  return null;
}

interface PlannedWrite {
  rel: string;
  abs: string;
  content: string;
  expected?: string;
}

export function saveSkill(vaultPath: string, name: string, req: SaveRequest, source: string): SaveResult {
  // 1. Paths, duplicates, content and sizes.
  let total = 0;
  const seen = new Set<string>();
  const plan: PlannedWrite[] = [];
  for (const f of req.files) {
    const problem = pathProblem(f.path);
    const rel = f.path;
    const abs = problem ? null : resolveSkillFilePath(vaultPath, name, rel);
    if (!abs) throw new SaveError(400, `invalid file path: ${f.path}${problem ? ` (${problem})` : ""}`);
    if (rel.toLowerCase() === "skill.md" && rel !== "SKILL.md") {
      throw new SaveError(400, `Use the exact name SKILL.md (got "${rel}")`);
    }
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new SaveError(400, `duplicate file path: ${rel}`);
    seen.add(key);
    if (f.content.includes("\0")) throw new SaveError(400, `binary content is not supported: ${rel}`);
    const bytes = Buffer.byteLength(f.content, "utf-8");
    if (bytes > SAVE_FILE_CAP_BYTES) throw new SaveError(413, `${rel} is larger than 1 MB`);
    total += bytes;
    plan.push({ rel, abs, content: f.content, expected: f.expected_sha256 });
  }
  if (total > SAVE_TOTAL_CAP_BYTES) throw new SaveError(413, "the files total more than 5 MB");

  // 2. SKILL.md, when sent, must carry this skill's name.
  const skillMd = plan.find((p) => p.rel === "SKILL.md");
  if (req.mode === "create" && !skillMd) throw new SaveError(400, "a new skill needs a SKILL.md");
  if (skillMd && frontmatterValueOf(skillMd.content, "name") !== name) {
    throw new SaveError(400, `SKILL.md's frontmatter name must be "${name}"`);
  }

  // 3. Create: the name is free. Update: the skill exists and nothing changed underneath.
  const dir = skillDir(vaultPath, name);
  if (req.mode === "create") {
    const v = validateSkillName(vaultPath, name);
    if (!v.ok) throw new SaveError(409, v.reason);
  } else {
    if (!fs.existsSync(dir)) throw new SaveError(404, `skill not found: ${name}`);
    const conflicts: SaveConflict[] = [];
    for (const p of plan) {
      if (!fs.existsSync(p.abs)) {
        if (p.expected !== undefined) conflicts.push({ path: p.rel, current_sha256: null });
        continue;
      }
      if (!fs.statSync(p.abs).isFile()) throw new SaveError(400, `not a file: ${p.rel}`);
      const current = readSkillFile(p.abs);
      if (current.binary || current.too_large) throw new SaveError(400, `cannot overwrite ${p.rel} (binary or larger than 1 MB)`);
      if (p.expected === undefined) throw new SaveError(400, `${p.rel} already exists: pass the expected_sha256 you read`);
      if (p.expected !== current.sha256) conflicts.push({ path: p.rel, current_sha256: current.sha256 });
    }
    if (conflicts.length > 0) throw new SaveError(409, "files changed", conflicts);
  }

  // 4. Write (temp + rename per file); identical content is left alone.
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const p of plan) {
    const next = Buffer.from(p.content, "utf-8");
    if (fs.existsSync(p.abs) && sha256(fs.readFileSync(p.abs)) === sha256(next)) {
      unchanged.push(p.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(p.abs), { recursive: true });
    const tmp = `${p.abs}.tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, p.abs);
    written.push(p.rel);
  }
  if (req.mode === "create") upsertManifestSkill(vaultPath, name, { targets: [], stage: "staging", source });
  return { name, mode: req.mode, written, unchanged };
}
