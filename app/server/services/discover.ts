/**
 * Discover service — scans all configured providers to find skills
 * and classify them against the vault's manifest.
 */

import fs from "node:fs";
import path from "node:path";
import type { Provider } from "../types/vault.ts";
import { readManifest } from "./vault.ts";
import { hashSkillFolder } from "./skillHash.ts";

export type DiscoverStatus = "new" | "synced" | "diverged";

export interface DiscoveredSkill {
  name: string;
  path: string;
  file_count: number;
  has_skill_md: boolean;
  provider_id: string;
  status: DiscoverStatus;
}

export interface DiscoverResult {
  provider_id: string;
  skills: DiscoveredSkill[];
}

export function discoverAll(
  vaultPath: string,
  providers: Provider[],
): DiscoverResult[] {
  const manifest = readManifest(vaultPath);
  const results: DiscoverResult[] = [];

  for (const provider of providers) {
    if (!fs.existsSync(provider.path)) continue;

    const providerSkills: DiscoveredSkill[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(provider.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (name.startsWith(".") || name === "node_modules") continue;

      const skillPath = path.join(provider.path, name);
      const hasSkillMd = fs.existsSync(path.join(skillPath, "SKILL.md"));

      let fileCount = 0;
      try {
        const files = fs.readdirSync(skillPath);
        fileCount = files.filter((f) => !f.startsWith(".")).length;
      } catch { /* permission issue */ }

      // Classify against manifest
      let status: DiscoverStatus = "new";
      if (name in manifest.skills) {
        const skillDir = path.join(vaultPath, "skills", name);
        if (fs.existsSync(skillDir)) {
          try {
            const vaultHash = hashSkillFolder(skillDir);
            const providerHash = hashSkillFolder(skillPath);
            status = vaultHash === providerHash ? "synced" : "diverged";
          } catch {
            status = "diverged";
          }
        } else {
          status = "diverged";
        }
      }

      providerSkills.push({
        name,
        path: skillPath,
        file_count: fileCount,
        has_skill_md: hasSkillMd,
        provider_id: provider.id,
        status,
      });
    }

    if (providerSkills.length > 0) {
      results.push({ provider_id: provider.id, skills: providerSkills });
    }
  }

  return results;
}
