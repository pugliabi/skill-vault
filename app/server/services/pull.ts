/**
 * Pull a skill from a provider directory back into the vault.
 *
 * Inverse of push: when the linked copy in (e.g.) ~/.claude/skills/<name>
 * has diverged from <vault>/skills/<name>, this copies the provider's
 * version back into the vault, replacing the vault copy.
 *
 * If the provider's <name> entry is a symlink/junction pointing into
 * the vault, the pull is a no-op (drift is impossible, source == dest).
 *
 * Manifest behavior:
 *   - The skill is upserted in the manifest if missing
 *   - `source` is set to "pulled from <provider_id>" so the provenance
 *     reflects what just happened (matches the CLI conventions in
 *     docs/vault-format.md)
 *   - `targets` is left alone — the user already had it pointed there
 */

import fs from "node:fs";
import path from "node:path";
import {
  readManifest,
  skillDir,
  upsertManifestSkill,
} from "./vault.ts";
import type { Provider } from "../types/vault.ts";

export interface PullResult {
  skill: string;
  source_path: string;
  vault_path: string;
  /** "no-op" when the provider entry is a symlink into the vault. */
  action: "copied" | "no-op";
}

const IGNORE_NAMES = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".DS_Store",
  "Thumbs.db",
  ".venv",
  "venv",
]);

function copyRecursive(src: string, dst: string): void {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    // Skip symlinks inside the source — copying the link target would
    // bring in arbitrary external content.
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (IGNORE_NAMES.has(entry)) continue;
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dst);
  }
}

export function pullSkill(
  vaultPath: string,
  provider: Provider,
  skillName: string,
): PullResult {
  const sourceDir = path.join(provider.path, skillName);
  const vaultDir = skillDir(vaultPath, skillName);

  if (!fs.existsSync(sourceDir)) {
    throw new Error(
      `${provider.id} has no '${skillName}' at ${sourceDir}`,
    );
  }

  // Symlink/junction → no-op (changes already propagate live)
  const lstat = fs.lstatSync(sourceDir);
  if (lstat.isSymbolicLink()) {
    try {
      const resolved = fs.realpathSync(sourceDir);
      const vaultResolved = fs.existsSync(vaultDir)
        ? fs.realpathSync(vaultDir)
        : "";
      if (resolved === vaultResolved) {
        return {
          skill: skillName,
          source_path: sourceDir,
          vault_path: vaultDir,
          action: "no-op",
        };
      }
    } catch {
      /* fall through to copy */
    }
  }

  // Replace vault contents (but only if the source is a regular dir).
  if (fs.existsSync(vaultDir)) {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
  copyRecursive(sourceDir, vaultDir);

  // Update manifest provenance, preserving everything else.
  const manifest = readManifest(vaultPath);
  const existing = manifest.skills[skillName] ?? { targets: [] };
  upsertManifestSkill(vaultPath, skillName, {
    ...existing,
    source: `pulled from ${provider.id}`,
  });

  return {
    skill: skillName,
    source_path: sourceDir,
    vault_path: vaultDir,
    action: "copied",
  };
}
