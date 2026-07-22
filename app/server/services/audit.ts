import fs from "node:fs";
import path from "node:path";
import { readManifest } from "./vault.ts";
import type { Provider } from "../types/vault.ts";

export interface AuditFix {
  label: string;
  action: string;
}

export interface AuditIssue {
  id: string;
  kind: "orphan_folder" | "dangling_entry" | "broken_link";
  target: string;
  description: string;
  fixes: AuditFix[];
}

let issueCounter = 0;
function nextId(): string {
  return `audit-${Date.now()}-${++issueCounter}`;
}

export function auditVault(vaultPath: string, providers: Provider[]): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const manifest = readManifest(vaultPath);
  const skillsPath = path.join(vaultPath, "skills");

  // 1. Orphan folders — exist on disk but not in manifest
  if (fs.existsSync(skillsPath)) {
    const folders = fs.readdirSync(skillsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const folder of folders) {
      if (!manifest.skills[folder]) {
        issues.push({
          id: nextId(),
          kind: "orphan_folder",
          target: path.join(skillsPath, folder),
          description: `Folder "skills/${folder}" exists on disk but has no manifest entry`,
          fixes: [
            { label: "Remove folder", action: "remove_folder" },
            { label: "Add to manifest", action: "add_to_manifest" },
          ],
        });
      }
    }
  }

  // 2. Dangling manifest entries — in manifest but no folder on disk
  for (const name of Object.keys(manifest.skills)) {
    const dir = path.join(skillsPath, name);
    if (!fs.existsSync(dir)) {
      issues.push({
        id: nextId(),
        kind: "dangling_entry",
        target: name,
        description: `Manifest entry "${name}" has no corresponding folder on disk`,
        fixes: [
          { label: "Remove from manifest", action: "remove_from_manifest" },
        ],
      });
    }
  }

  // 3. Broken symlinks in provider directories
  for (const provider of providers) {
    if (!fs.existsSync(provider.path)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(provider.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(provider.path, entry.name);
      try {
        const lstat = fs.lstatSync(full);
        if (lstat.isSymbolicLink()) {
          const target = fs.readlinkSync(full);
          const resolved = path.resolve(path.dirname(full), target);
          if (!fs.existsSync(resolved)) {
            issues.push({
              id: nextId(),
              kind: "broken_link",
              target: full,
              description: `Broken symlink in provider "${provider.id}": ${entry.name} → ${target}`,
              fixes: [
                { label: "Remove symlink", action: "remove_link" },
                { label: "Recreate link", action: "recreate_link" },
              ],
            });
          }
        }
      } catch {
        // skip entries we can't stat
      }
    }
  }

  return issues;
}
