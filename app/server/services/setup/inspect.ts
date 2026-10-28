/**
 * What's in a folder the user picked: nothing yet, a vault (skills.json),
 * a vault missing its manifest, a tool's skills folder (SKILL.md folders
 * directly inside — a target, not a vault), or something else. A folder that
 * exists but can't be read (permissions, or removed mid-check) is "unreadable"
 * and reports no git or Notion details. Also the enclosing git repo and the
 * vault's Notion database, for display.
 */
import fs from "node:fs";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { NotionRef } from "./types.ts";

export type FolderKind =
  | "missing"
  | "not_dir"
  | "unreadable"
  | "empty"
  | "vault"
  | "vault_no_manifest"
  | "skills_folder"
  | "other";

export interface FolderInfo {
  path: string;
  kind: FolderKind;
  /** The folder (or, when missing, its nearest existing parent) can be written. */
  writable: boolean;
  skill_count: number;
  git: { root: string; origin: string | null } | null;
  notion: NotionRef | null;
}

const hasSkillMd = (dir: string) => fs.existsSync(path.join(dir, "SKILL.md"));

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function nearestExisting(p: string): string | null {
  let cur = p;
  for (;;) {
    if (fs.existsSync(cur)) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function isWritable(p: string): boolean {
  const at = nearestExisting(p);
  if (!at) return false;
  try {
    fs.accessSync(at, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function vaultSkillNames(vault: string): Set<string> {
  const names = new Set(subdirs(path.join(vault, "skills")).filter(hasSkillMd).map((d) => path.basename(d)));
  try {
    const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")) as { skills?: Record<string, unknown> };
    for (const k of Object.keys(m.skills ?? {})) names.add(k);
  } catch {
    /* no or unreadable manifest: folders only */
  }
  return names;
}

function readNotionRef(vault: string): NotionRef | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(vault, "notion.json"), "utf8")) as Record<string, unknown>;
    return typeof s.data_source_id === "string" && s.data_source_id
      ? { id: s.data_source_id, name: typeof s.data_source_name === "string" ? s.data_source_name : "" }
      : null;
  } catch {
    return null;
  }
}

async function gitInfo(dir: string, run: Run): Promise<FolderInfo["git"]> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 10_000 });
  if (top.code !== 0 || !top.stdout.trim()) return null;
  const root = path.resolve(top.stdout.trim());
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: root, timeoutMs: 10_000 });
  return { root, origin: origin.code === 0 && origin.stdout.trim() ? origin.stdout.trim() : null };
}

export async function inspectFolder(
  input: string,
  deps: { run: Run; readdir?: (dir: string) => string[] },
): Promise<FolderInfo> {
  const abs = path.resolve(input);
  let stat: fs.Stats | null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  let kind: FolderKind;
  let skill_count = 0;
  const readdir = deps.readdir ?? ((dir: string) => fs.readdirSync(dir));
  let entries: string[] = [];
  if (stat?.isDirectory()) {
    try {
      entries = readdir(abs);
    } catch {
      return { path: abs, kind: "unreadable", writable: false, skill_count: 0, git: null, notion: null };
    }
  }
  if (!stat) kind = "missing";
  else if (!stat.isDirectory()) kind = "not_dir";
  else if (entries.length === 0) kind = "empty";
  else if (fs.existsSync(path.join(abs, "skills.json"))) {
    kind = "vault";
    skill_count = vaultSkillNames(abs).size;
  } else {
    const inSkills = subdirs(path.join(abs, "skills")).filter(hasSkillMd).length;
    const direct = subdirs(abs).filter(hasSkillMd).length;
    if (inSkills > 0) {
      kind = "vault_no_manifest";
      skill_count = inSkills;
    } else if (direct > 0) {
      kind = "skills_folder";
      skill_count = direct;
    } else kind = "other";
  }
  const exists = kind !== "missing" && kind !== "not_dir";
  return {
    path: abs,
    kind,
    writable: kind !== "not_dir" && isWritable(abs),
    skill_count,
    git: exists ? await gitInfo(abs, deps.run) : null,
    notion: kind === "vault" || kind === "vault_no_manifest" ? readNotionRef(abs) : null,
  };
}
