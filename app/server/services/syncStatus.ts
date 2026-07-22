/**
 * Per-target sync status for a skill.
 *
 * For each provider in `targets`, look at <provider.path>/<skill_name>:
 *   - missing       — directory doesn't exist
 *   - synced        — directory is a symlink/junction (live link)
 *                     OR a copy whose hash matches the vault copy
 *   - stale         — directory is a copy whose hash differs
 *   - error         — couldn't read for some reason
 *
 * Symlinks/junctions short-circuit hashing — if it's pointing into the
 * vault, drift is impossible (edits propagate live).
 */

import fs from "node:fs";
import path from "node:path";
import { hashSkillFolder } from "./skillHash.ts";
import type { Provider } from "../types/vault.ts";

export type TargetStatus = "synced" | "stale" | "missing" | "error";

export function targetStatus(
  vaultSkillDir: string,
  providerPath: string,
  skillName: string,
): TargetStatus {
  const targetDir = path.join(providerPath, skillName);
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(targetDir);
  } catch {
    return "missing";
  }

  // Symlink (or junction on Windows; fs.lstat reports junctions as symlinks)
  if (lstat.isSymbolicLink()) {
    // Resolve and check it points at the vault. If it does, synced.
    try {
      const resolved = fs.realpathSync(targetDir);
      const vaultResolved = fs.realpathSync(vaultSkillDir);
      if (resolved === vaultResolved) return "synced";
    } catch {
      /* fall through to hash compare */
    }
  }

  if (!lstat.isDirectory() && !lstat.isSymbolicLink()) {
    return "error";
  }

  const vaultHash = hashSkillFolder(vaultSkillDir);
  const targetHash = hashSkillFolder(targetDir);
  if (!vaultHash || !targetHash) return "error";
  return vaultHash === targetHash ? "synced" : "stale";
}

/**
 * Compute target status for every (target, provider) pair. Targets the
 * skill claims but where the provider isn't configured are reported as
 * "missing" — the manifest is the source of truth, so a missing provider
 * config means we can't verify and treating it as stale would be loud
 * for no useful reason.
 */
export function statusByTarget(
  vaultSkillDir: string,
  providers: Provider[],
  skillName: string,
  targets: string[],
): Record<string, TargetStatus> {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const out: Record<string, TargetStatus> = {};
  for (const t of targets) {
    const provider = byId.get(t);
    if (!provider) {
      out[t] = "missing";
      continue;
    }
    out[t] = targetStatus(vaultSkillDir, provider.path, skillName);
  }
  return out;
}
