/**
 * Vault skill rename + delete, shared by the skills routes and the Notion
 * sync runner so there is exactly one implementation of each (history
 * snapshot, manifest/folder change, history move, activity records).
 */
import fs from "node:fs";
import path from "node:path";
import { recordActivity } from "./activity.ts";
import { moveHistory, recordVersion, withHistory } from "./history.ts";
import { validateSkillName } from "./skillName.ts";
import { readManifest, removeSkill, renameSkill, skillDir } from "./vault.ts";

/** A rename/delete refused before anything changed; `status` is the HTTP code the skills route uses. */
export class SkillOpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Rename <vault>/skills/<oldName> → <newName> (folder + manifest key) and
 * move its history. The prior state is recorded first; history bookkeeping
 * failures after the rename are logged, never thrown (the rename happened).
 * Throws SkillOpError for validation failures (nothing changed).
 */
export function renameVaultSkill(vaultPath: string, oldName: string, rawNewName: string): void {
  const newName = rawNewName.trim();
  if (!newName) throw new SkillOpError(400, "new_name is required");
  if (newName === oldName) throw new SkillOpError(400, "new_name is the same as the current name");

  // 404 the old name early so the user gets a clearer error than a
  // misleading "skill <new> already exists". On-disk-only skills count.
  const before = readManifest(vaultPath).skills[oldName];
  if (!before && !fs.existsSync(path.join(vaultPath, "skills", oldName))) {
    throw new SkillOpError(404, "skill not found");
  }

  const v = validateSkillName(vaultPath, newName);
  if (!v.ok) throw new SkillOpError(409, v.reason);

  recordActivity({ kind: "rename", skill: oldName, ok: true, message: "starting" });

  try {
    recordVersion(vaultPath, oldName, { source: "external-edit", note: "unrecorded prior state" });
  } catch (err) {
    console.error(`[history] pre-rename snapshot of ${oldName}: ${(err as Error).message}`);
  }

  try {
    renameSkill(vaultPath, oldName, newName);
  } catch (err) {
    recordActivity({ kind: "rename", skill: oldName, ok: false, message: (err as Error).message });
    throw err;
  }

  try {
    moveHistory(vaultPath, oldName, newName);
    recordVersion(vaultPath, newName, { source: "rename", note: `renamed from ${oldName}`, always: true });
  } catch (err) {
    console.error(`[history] rename ${oldName} -> ${newName}: ${(err as Error).message}`);
  }

  recordActivity({ kind: "rename", skill: newName, ok: true, message: `${oldName} → ${newName}` });
}

/**
 * Remove a skill from the manifest and disk after recording its final state
 * (with the manifest entry) in history, so it can be restored. Idempotent.
 */
export function deleteVaultSkill(vaultPath: string, name: string): void {
  const manifestEntry = readManifest(vaultPath).skills[name];
  recordActivity({ kind: "remove", skill: name, ok: true, message: "starting" });
  try {
    recordVersion(vaultPath, name, {
      source: "delete",
      note: "final state before delete",
      always: true,
      manifest_entry: manifestEntry,
    });
    removeSkill(vaultPath, name);
    recordActivity({
      kind: "remove",
      skill: name,
      ok: true,
      message: manifestEntry ? "removed" : "no-op (not in manifest)",
    });
  } catch (err) {
    recordActivity({ kind: "remove", skill: name, ok: false, message: (err as Error).message });
    throw err;
  }
}

const FRONTMATTER_OPEN_RE = /^(\uFEFF?---)(\r?\n)/;

/**
 * Pure: set the frontmatter `name:` of a SKILL.md text, touching only that
 * line (other lines, quoting and line endings are preserved). Adds the key
 * right after the opening fence when missing. Returns null when the file
 * has no frontmatter or already has that name.
 */
export function withSkillMdName(md: string, newName: string): string | null {
  const open = FRONTMATTER_OPEN_RE.exec(md);
  if (!open) return null;
  const eol = open[2];
  const start = open[0].length;
  const close = /\r?\n---(?:\r?\n|$)/.exec(md.slice(start - eol.length));
  if (!close) return null;
  const fmEnd = start - eol.length + close.index; // index of the EOL before the closing fence
  const fm = md.slice(start, fmEnd);
  const lineRe = /^name[ \t]*:[^\r\n]*/m;
  const m = lineRe.exec(fm);
  if (m) {
    const line = `name: ${newName}`;
    if (m[0] === line) return null;
    return md.slice(0, start) + fm.slice(0, m.index) + line + fm.slice(m.index + m[0].length) + md.slice(fmEnd);
  }
  return md.slice(0, start) + `name: ${newName}${eol}` + md.slice(start);
}

/**
 * Rewrite <vault>/skills/<skill>/SKILL.md's frontmatter `name` to `newName`
 * (recorded in history as a "rename"). Returns true when the file changed.
 */
export function setSkillMdName(vaultPath: string, skill: string, newName: string): boolean {
  const file = path.join(skillDir(vaultPath, skill), "SKILL.md");
  if (!fs.existsSync(file)) return false;
  const next = withSkillMdName(fs.readFileSync(file, "utf8"), newName);
  if (next === null) return false;
  withHistory(vaultPath, skill, "rename", () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, file);
  }, `frontmatter name → ${newName}`);
  return true;
}
