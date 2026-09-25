/**
 * Conflict review helpers for the Conflicts page: which linked skills are in
 * conflict, a side-by-side snapshot of one skill (vault / Notion now / base
 * = Notion copy at the last sync), and the folder a "files" resolution
 * produces. Notion's copy is always shown and merged WITHOUT the
 * `notion_page_id` frontmatter key Notion injects — it is never written to
 * the vault.
 */
import fs from "node:fs";
import path from "node:path";
import { getVersion, readObject } from "../history.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { computeFilesDiff, type SkillDiff } from "../diff.ts";
import { listSkills, readManifest, skillDir } from "../vault.ts";
import type { NotionLink } from "../../types/vault.ts";
import { readSkillFiles } from "./linker.ts";
import { stripNotionPageId } from "./patch.ts";
import { readNotionCache } from "./store.ts";

/** Per-file cap for text sent to the browser (and to Claude). */
export const CONFLICT_TEXT_CAP_BYTES = 256 * 1024;
/** Same sniff window as vault.readSkillFile: a NUL in the first 8 KB = binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface ConflictListItem {
  name: string;
  notion_title?: string;
  vault_edited_at?: string;
  notion_edited_at?: string;
}

export interface ConflictFile {
  path: string;
  vault: string | null;
  notion: string | null;
  base: string | null;
  /** Either side is binary — pick a side, never merged as text. */
  binary: boolean;
  /** Either side is over the text cap — pick a side, content not sent. */
  too_large: boolean;
  /** Identical on both sides. */
  same: boolean;
}

export interface ConflictSnapshot {
  name: string;
  notion_title?: string;
  notion_version_id: string;
  /** Normalized hash of the vault folder this snapshot was taken from — echo it on a "files" resolve. */
  vault_hash: string | null;
  base_available: boolean;
  files: ConflictFile[];
  diff_vault_vs_notion: SkillDiff;
  vault_edited_at?: string;
  notion_edited_at?: string;
}

/** Bad resolve input from the client (→ 400). */
export class ResolveInputError extends Error {}

export function isBinaryBuffer(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Notion's files as they would land in the vault: SKILL.md without notion_page_id. */
export function notionFilesForVault(files: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map(files);
  const md = out.get("SKILL.md");
  if (md && !isBinaryBuffer(md)) out.set("SKILL.md", Buffer.from(stripNotionPageId(md.toString("utf8")), "utf8"));
  return out;
}

/** Newest mtime of the files in a vault skill folder (ISO), if any. */
export function vaultEditedAt(vaultPath: string, skill: string): string | undefined {
  const dir = skillDir(vaultPath, skill);
  let newest = 0;
  for (const rel of readSkillFiles(dir).keys()) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, ...rel.split("/"))).mtimeMs);
    } catch {
      /* vanished — ignore */
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : undefined;
}

export function notionEditedAt(link: NotionLink): string | undefined {
  return readNotionCache().rows.find((r) => r.page_id === link.page_id)?.edited_at ?? link.notion_edited_at;
}

/**
 * Linked (non-legacy) skills needing review: never synced (conflict at link
 * time) or reported as "conflict" by the status computation.
 */
export function listConflicts(vaultPath: string): ConflictListItem[] {
  const manifest = readManifest(vaultPath);
  const statusConflict = new Set(
    listSkills(vaultPath)
      .filter((s) => s.notion_status === "conflict")
      .map((s) => s.name),
  );
  const out: ConflictListItem[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    const link = entry.notion;
    if (!link || link.state !== "linked" || !link.page_id) continue;
    if (link.synced_at && !statusConflict.has(name)) continue;
    // An empty page awaiting its first upload has nothing to compare (it is a push row).
    if (!link.synced_at && !link.notion_version_id) continue;
    const vEdited = vaultEditedAt(vaultPath, name);
    const nEdited = notionEditedAt(link);
    out.push({
      name,
      ...(link.notion_title ? { notion_title: link.notion_title } : {}),
      ...(vEdited ? { vault_edited_at: vEdited } : {}),
      ...(nEdited ? { notion_edited_at: nEdited } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Notion copy at the last sync (link.base_notion_version), SKILL.md stripped; null if unavailable. */
export function readBaseFiles(vaultPath: string, skill: string, link: NotionLink): Map<string, Buffer> | null {
  if (!link.base_notion_version) return null;
  const v = getVersion(vaultPath, skill, link.base_notion_version);
  if (!v || v.side !== "notion") return null;
  const out = new Map<string, Buffer>();
  try {
    for (const [rel, sha] of Object.entries(v.files)) out.set(rel, readObject(vaultPath, sha));
  } catch {
    return null;
  }
  return notionFilesForVault(out);
}

function textOf(buf: Buffer | undefined): string | null {
  return buf === undefined ? null : buf.toString("utf8");
}

/** One entry per path on either side (base consulted only for text context). */
export function compareSides(
  vault: Map<string, Buffer>,
  notion: Map<string, Buffer>,
  base: Map<string, Buffer> | null,
): ConflictFile[] {
  const paths = [...new Set([...vault.keys(), ...notion.keys()])].sort();
  return paths.map((rel) => {
    const v = vault.get(rel);
    const n = notion.get(rel);
    const b = base?.get(rel);
    const same = !!v && !!n && v.equals(n);
    const binary = [v, n].some((x) => x !== undefined && isBinaryBuffer(x));
    const tooLarge = !binary && [v, n].some((x) => x !== undefined && x.length > CONFLICT_TEXT_CAP_BYTES);
    const withText = !binary && !tooLarge;
    const baseOk = withText && b !== undefined && !isBinaryBuffer(b) && b.length <= CONFLICT_TEXT_CAP_BYTES;
    return {
      path: rel,
      vault: withText ? textOf(v) : null,
      notion: withText ? textOf(n) : null,
      base: baseOk ? textOf(b) : null,
      binary,
      too_large: tooLarge,
      same,
    };
  });
}

export function buildSnapshot(
  vaultPath: string,
  skill: string,
  link: NotionLink,
  notionVersionId: string,
  notionFiles: Map<string, Buffer>,
): ConflictSnapshot {
  const vault = readSkillFiles(skillDir(vaultPath, skill));
  const notion = notionFilesForVault(notionFiles);
  const base = readBaseFiles(vaultPath, skill, link);
  const vEdited = vaultEditedAt(vaultPath, skill);
  const nEdited = notionEditedAt(link);
  return {
    name: skill,
    ...(link.notion_title ? { notion_title: link.notion_title } : {}),
    notion_version_id: notionVersionId,
    vault_hash: hashSkillDirNormalized(skillDir(vaultPath, skill)),
    base_available: base !== null,
    files: compareSides(vault, notion, base),
    diff_vault_vs_notion: computeFilesDiff(vault, notion),
    ...(vEdited ? { vault_edited_at: vEdited } : {}),
    ...(nEdited ? { notion_edited_at: nEdited } : {}),
  };
}

export interface FilesResolution {
  files: Array<{ path: string; content: string | null }>;
  binary_choices?: Record<string, "vault" | "notion">;
}

/** Validate the request body's `files` / `binary_choices` shape (throws ResolveInputError). */
export function parseFilesResolution(body: { files?: unknown; binary_choices?: unknown }): FilesResolution {
  if (!Array.isArray(body.files)) throw new ResolveInputError("files must be an array");
  const files = body.files.map((f: unknown) => {
    const { path: p, content } = (f ?? {}) as { path?: unknown; content?: unknown };
    if (typeof p !== "string" || !p) throw new ResolveInputError("every file needs a path");
    if (typeof content !== "string" && content !== null) throw new ResolveInputError(`content for ${p} must be a string or null`);
    return { path: p, content };
  });
  let binary_choices: Record<string, "vault" | "notion"> | undefined;
  if (body.binary_choices !== undefined) {
    if (typeof body.binary_choices !== "object" || body.binary_choices === null || Array.isArray(body.binary_choices)) {
      throw new ResolveInputError("binary_choices must be an object");
    }
    binary_choices = {};
    for (const [p, side] of Object.entries(body.binary_choices as Record<string, unknown>)) {
      if (side !== "vault" && side !== "notion") throw new ResolveInputError(`binary choice for ${p} must be "vault" or "notion"`);
      binary_choices[p] = side;
    }
  }
  return { files, ...(binary_choices ? { binary_choices } : {}) };
}

/**
 * The resolved folder for a "files" resolution: unchanged files from the
 * vault, every differing text file from `res.files` (null content = drop
 * the file), every differing binary/too-large file from the chosen side
 * (absent on that side = drop). All differing files must be accounted for,
 * and nothing else may be supplied. SKILL.md never keeps notion_page_id.
 */
export function buildResolvedFiles(
  vault: Map<string, Buffer>,
  notionRaw: Map<string, Buffer>,
  res: FilesResolution,
): Map<string, Buffer> {
  const notion = notionFilesForVault(notionRaw);
  const cmp = compareSides(vault, notion, null);
  const byPath = new Map(cmp.map((f) => [f.path, f]));
  const provided = new Map<string, string | null>();
  for (const f of res.files) {
    const c = byPath.get(f.path);
    if (!c || c.same || c.binary || c.too_large) {
      throw new ResolveInputError(`${f.path} is not a differing text file of this skill`);
    }
    if (provided.has(f.path)) throw new ResolveInputError(`${f.path} is listed more than once`);
    provided.set(f.path, f.content);
  }
  const out = new Map(vault);
  for (const f of cmp) {
    if (f.same) continue;
    if (f.binary || f.too_large) {
      const side = res.binary_choices?.[f.path];
      if (side !== "vault" && side !== "notion") {
        throw new ResolveInputError(`choose the vault or Notion copy of ${f.path}`);
      }
      const buf = (side === "vault" ? vault : notion).get(f.path);
      if (buf) out.set(f.path, buf);
      else out.delete(f.path);
      continue;
    }
    if (!provided.has(f.path)) throw new ResolveInputError(`missing resolved content for ${f.path}`);
    const content = provided.get(f.path)!;
    if (content === null) out.delete(f.path);
    else out.set(f.path, Buffer.from(content, "utf8"));
  }
  const md = out.get("SKILL.md");
  if (md && !isBinaryBuffer(md)) out.set("SKILL.md", Buffer.from(stripNotionPageId(md.toString("utf8")), "utf8"));
  if (!out.has("SKILL.md")) throw new ResolveInputError("the resolved skill would have no SKILL.md");
  return out;
}
