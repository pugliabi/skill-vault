/**
 * "Install to vault": copy the assistant plugin's skills into the user's
 * vault as ordinary skills, and optionally its agent definitions into the
 * claude provider's sibling `agents/` directory (~/.claude/agents).
 *
 * Installed skills get a `dir` origin pointing back at the shipped plugin
 * bundle, so when the app updates (and the bundle with it), the normal
 * update-check flow surfaces "update available" for them — the assistant's
 * own skills ride the same rails as every other skill in the vault.
 */

import fs from "node:fs";
import path from "node:path";
import { copyRecursive } from "../adoption.ts";
import { recordActivity } from "../activity.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { readManifest, upsertManifestSkill } from "../vault.ts";

export interface InstallResult {
  installed_skills: string[];
  skipped_skills: { name: string; reason: string }[];
  installed_agents: string[];
  skipped_agents: { name: string; reason: string }[];
}

export function listPluginSkills(pluginDir: string): string[] {
  const root = path.join(pluginDir, "skills");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "SKILL.md")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function installAssistantSkills(opts: {
  vaultPath: string;
  pluginDir: string;
  /** Subset to install; omitted = all plugin skills. */
  skills?: string[];
  /** Also copy agents/*.md into `agentsDir` (never overwrites without `overwrite`). */
  agentsDir?: string;
  overwrite?: boolean;
}): InstallResult {
  const result: InstallResult = {
    installed_skills: [],
    skipped_skills: [],
    installed_agents: [],
    skipped_agents: [],
  };

  const available = listPluginSkills(opts.pluginDir);
  const wanted = opts.skills && opts.skills.length > 0 ? opts.skills : available;
  const manifest = readManifest(opts.vaultPath);

  for (const name of wanted) {
    if (!available.includes(name)) {
      result.skipped_skills.push({ name, reason: "not in the plugin bundle" });
      continue;
    }
    const dest = path.join(opts.vaultPath, "skills", name);
    const exists = fs.existsSync(dest) || Boolean(manifest.skills[name]);
    if (exists && !opts.overwrite) {
      result.skipped_skills.push({ name, reason: "already in the vault" });
      continue;
    }
    const src = path.join(opts.pluginDir, "skills", name);
    copyRecursive(src, dest);
    const existing = manifest.skills[name];
    upsertManifestSkill(opts.vaultPath, name, {
      ...(existing ?? {}),
      targets: existing?.targets ?? [],
      stage: existing?.stage ?? "production",
      source: "installed from Skill Vault assistant",
      origin: {
        type: "dir",
        path: opts.pluginDir,
        subpath: `skills/${name}`,
        adopted_at: new Date().toISOString(),
        content_hash: hashSkillDirNormalized(dest) ?? "empty",
      },
    });
    recordActivity({ kind: "adopt", skill: name, ok: true, message: "installed assistant skill" });
    result.installed_skills.push(name);
  }

  if (opts.agentsDir) {
    const agentsSrc = path.join(opts.pluginDir, "agents");
    let files: string[] = [];
    try {
      files = fs.readdirSync(agentsSrc).filter((f) => f.endsWith(".md"));
    } catch {
      /* no agents dir in the bundle */
    }
    if (files.length > 0) fs.mkdirSync(opts.agentsDir, { recursive: true });
    for (const f of files) {
      const dest = path.join(opts.agentsDir, f);
      if (fs.existsSync(dest) && !opts.overwrite) {
        result.skipped_agents.push({ name: f, reason: "already exists" });
        continue;
      }
      fs.copyFileSync(path.join(agentsSrc, f), dest);
      result.installed_agents.push(f);
    }
  }

  return result;
}
