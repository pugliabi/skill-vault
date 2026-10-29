/**
 * The skill-vault skill that ships with the app (app/bundled-skills/).
 * Settings → Agent access adopts it into the vault like any other skill,
 * with a `dir` origin pointing back here, so app updates that change it
 * show up as "Update available".
 */
import fs from "node:fs";
import path from "node:path";

export const BUNDLED_SKILL_NAME = "skill-vault";

/** The origin root recorded when the skill is adopted. */
export function bundledSkillsRoot(appRoot: string): string {
  return path.join(appRoot, "bundled-skills");
}

export function bundledSkillDir(appRoot: string): string {
  return path.join(bundledSkillsRoot(appRoot), BUNDLED_SKILL_NAME);
}

export function readBundledSkillMd(appRoot: string): string {
  return fs.readFileSync(path.join(bundledSkillDir(appRoot), "SKILL.md"), "utf-8");
}

/**
 * The copy-paste prompt for Claude Desktop. SKILL.md contains ``` fences,
 * so it goes inside a four-backtick fence.
 */
export function installPrompt(skillMd: string): string {
  return [
    "Please install this as a Claude skill for me. Create a zip named skill-vault.zip that contains one",
    "folder, skill-vault/, with this exact file as skill-vault/SKILL.md (don't change any of it), and give",
    "me the zip so I can save it to my skills.",
    "",
    "````markdown",
    skillMd.trimEnd(),
    "````",
    "",
  ].join("\n");
}
