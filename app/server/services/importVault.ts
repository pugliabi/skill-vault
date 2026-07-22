/**
 * Cross-vault import service — merges skills from a foreign vault into
 * the current one, skipping name collisions.
 */

import fs from "node:fs";
import path from "node:path";
import { readManifest, upsertManifestSkill } from "./vault.ts";

export interface ImportScanResult {
  name: string;
  stage: string;
  targets: string[];
  conflict: boolean;
}

export interface ImportMergeResult {
  imported: string[];
  skipped: string[];
}

/**
 * Scan a foreign vault and compare its skills against the current manifest.
 */
export function scanForeignVault(
  currentVaultPath: string,
  foreignVaultPath: string,
): ImportScanResult[] {
  const foreignManifestPath = path.join(foreignVaultPath, "skills.json");
  if (!fs.existsSync(foreignManifestPath)) {
    throw new Error(`No skills.json found at ${foreignVaultPath}`);
  }

  const foreignRaw = fs.readFileSync(foreignManifestPath, "utf-8");
  const foreignManifest = JSON.parse(foreignRaw) as Record<string, any>;
  const currentManifest = readManifest(currentVaultPath);

  const results: ImportScanResult[] = [];
  for (const [name, entry] of Object.entries(foreignManifest)) {
    const conflict = name in currentManifest.skills;
    results.push({
      name,
      stage: entry.stage || "production",
      targets: entry.targets || [],
      conflict,
    });
  }

  // Non-conflicts first
  results.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Merge non-colliding skills from a foreign vault into the current one.
 * Copies skill folders and adds manifest entries.
 */
export function mergeForeignVault(
  currentVaultPath: string,
  foreignVaultPath: string,
  skillNames: string[],
): ImportMergeResult {
  const currentManifest = readManifest(currentVaultPath);
  const foreignManifestPath = path.join(foreignVaultPath, "skills.json");
  const foreignRaw = fs.readFileSync(foreignManifestPath, "utf-8");
  const foreignManifest = JSON.parse(foreignRaw) as Record<string, any>;
  const foreignSkillsDir = path.join(foreignVaultPath, "skills");

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const name of skillNames) {
    if (name in currentManifest.skills) {
      skipped.push(name);
      continue;
    }

    const foreignEntry = foreignManifest[name];
    if (!foreignEntry) {
      skipped.push(name);
      continue;
    }

    const srcDir = path.join(foreignSkillsDir, name);
    if (!fs.existsSync(srcDir)) {
      // Try staging dir
      const stagingSrc = path.join(foreignVaultPath, "staging", name);
      if (!fs.existsSync(stagingSrc)) {
        skipped.push(name);
        continue;
      }
      copyDirRecursive(stagingSrc, path.join(currentVaultPath, "skills", name));
    } else {
      copyDirRecursive(srcDir, path.join(currentVaultPath, "skills", name));
    }

    // Add to current manifest
    upsertManifestSkill(currentVaultPath, name, {
      stage: foreignEntry.stage || "production",
      targets: foreignEntry.targets || [],
      source: `import:${path.basename(foreignVaultPath)}`,
    });

    imported.push(name);
  }

  return { imported, skipped };
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
