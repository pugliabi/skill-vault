/**
 * Name agreement: a skill is valid for Claude packages, agents and Notion
 * only when its folder name and SKILL.md's frontmatter `name` are the same
 * string (Notion refuses uploads otherwise: "name must match the enclosing
 * directory"). Nothing here rewrites names silently — mismatches are listed
 * and the user picks which side is right.
 */
import fs from "node:fs";
import path from "node:path";
import { readFrontmatterValue } from "./notion/patch.ts";
import { SkillOpError, renameVaultSkill, setSkillMdName } from "./skillLifecycle.ts";
import type { ProviderOutcome } from "./providerLinks.ts";
import { SLUG_RE, validateSkillName } from "./skillName.ts";
import { readManifest, skillDir, skillsDir } from "./vault.ts";

/** Opening + closing frontmatter fences; a leading UTF-8 BOM is allowed. */
const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/;

/** A frontmatter value of a SKILL.md text (BOM-aware), trimmed; undefined when missing or empty. */
export function frontmatterValueOf(md: string, key: string): string | undefined {
  const fm = FRONTMATTER_RE.exec(md)?.[1].split(/\r?\n/) ?? null;
  const value = readFrontmatterValue(fm, key)?.trim();
  return value ? value : undefined;
}

/** A folder whose SKILL.md `name` differs from it — refused before any Notion write. */
export class NameMismatchError extends Error {
  constructor(
    readonly folder: string,
    readonly skillMdName: string | undefined,
  ) {
    super(
      `Name mismatch: folder '${folder}' vs SKILL.md name '${skillMdName ?? "(none)"}' — fix it in Names`,
    );
  }
}

/** SKILL.md's frontmatter `name` for a skill folder, or undefined (no file / no frontmatter / no name). */
export function skillMdName(vaultPath: string, folder: string): string | undefined {
  const file = path.join(skillDir(vaultPath, folder), "SKILL.md");
  let md: string;
  try {
    md = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return frontmatterValueOf(md, "name");
}

/** Throws NameMismatchError unless SKILL.md's `name` equals the folder name. */
export function assertNameAgreement(vaultPath: string, folder: string): void {
  const name = skillMdName(vaultPath, folder);
  if (name !== folder) throw new NameMismatchError(folder, name);
}

export interface NameMismatch {
  folder: string;
  /** SKILL.md's frontmatter name ("" when missing). */
  name: string;
  /** Whether `name` is a valid skill (folder) name. */
  name_is_valid: boolean;
  /** Another folder is already named `name` (typically a duplicate copy). */
  folder_exists_for_name: boolean;
  /** Whether the folder itself is a valid skill name. */
  folder_is_valid: boolean;
  notion_title?: string;
}

/** Every skill folder (with a SKILL.md) whose frontmatter name differs from the folder name. */
export function listNameMismatches(vaultPath: string): NameMismatch[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir(vaultPath), { withFileTypes: true });
  } catch {
    return [];
  }
  const manifest = readManifest(vaultPath);
  const out: NameMismatch[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (!fs.existsSync(path.join(skillsDir(vaultPath), e.name, "SKILL.md"))) continue;
    const name = skillMdName(vaultPath, e.name) ?? "";
    if (name === e.name) continue;
    const title = manifest.skills[e.name]?.notion?.notion_title;
    out.push({
      folder: e.name,
      name,
      name_is_valid: SLUG_RE.test(name),
      folder_exists_for_name: !!name && fs.existsSync(skillDir(vaultPath, name)),
      folder_is_valid: SLUG_RE.test(e.name),
      ...(title ? { notion_title: title } : {}),
    });
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * Make a skill's names agree.
 *   use "name":   rename the folder to SKILL.md's name (shared rename: history, manifest and Notion link move with it).
 *   use "folder": set SKILL.md's name to the folder name (recorded in history).
 * Throws SkillOpError (status = HTTP code) when refused; nothing changes then.
 * Returns the skill's (folder) name afterwards and, for a folder rename,
 * what happened to each provider's link.
 */
export async function fixSkillName(
  vaultPath: string,
  folder: string,
  use: "name" | "folder",
): Promise<{ name: string; providers: ProviderOutcome[] }> {
  if (!fs.existsSync(path.join(skillDir(vaultPath, folder), "SKILL.md"))) {
    throw new SkillOpError(404, `skill "${folder}" not found`);
  }
  const name = skillMdName(vaultPath, folder);
  if (name === folder) throw new SkillOpError(409, `"${folder}" already agrees with its SKILL.md name`);
  if (use === "folder") {
    if (!SLUG_RE.test(folder)) {
      throw new SkillOpError(409, `"${folder}" is not a valid skill name — rename the folder instead`);
    }
    if (!setSkillMdName(vaultPath, folder, folder)) {
      throw new SkillOpError(409, `could not set the name in "${folder}"/SKILL.md (no frontmatter?)`);
    }
    return { name: folder, providers: [] };
  }
  if (!name) throw new SkillOpError(409, `"${folder}"/SKILL.md has no name — change the SKILL.md name instead`);
  if (fs.existsSync(skillDir(vaultPath, name)) || readManifest(vaultPath).skills[name]) {
    throw new SkillOpError(
      409,
      `a skill named "${name}" already exists — compare the two and remove the duplicate`,
    );
  }
  const v = validateSkillName(vaultPath, name);
  if (!v.ok) throw new SkillOpError(409, v.reason);
  const providers = await renameVaultSkill(vaultPath, folder, name);
  return { name, providers };
}
