/**
 * Push one skill to one provider: link (symlink → junction → copy, see
 * linking.ts) the provider's <skill> folder to the vault copy, then record the
 * provider in the skill's `targets` in skills.json. Shared by POST /api/push
 * and the setup guide's Finish job.
 */
import path from "node:path";
import { linkSkillDir } from "./linking.ts";
import { readManifest, skillDir, writeManifest } from "./vault.ts";
import type { Provider, PushResult } from "../types/vault.ts";

/** linkSkillDir refused (circular or invalid path). */
export class PushSkipError extends Error {}

export function pushSkillToProvider(
  vaultPath: string,
  skill: string,
  provider: Provider,
  opts: { forceCopy?: boolean } = {},
): PushResult {
  const result = linkSkillDir(skillDir(vaultPath, skill), path.join(provider.path, skill), opts);
  if (result.method === "skip") throw new PushSkipError(result.reason ?? "skipped (circular or invalid path)");
  const manifest = readManifest(vaultPath);
  const entry = manifest.skills[skill] ?? { targets: [] };
  if (!entry.targets.includes(provider.id)) {
    entry.targets = [...entry.targets, provider.id];
    manifest.skills[skill] = entry;
    writeManifest(vaultPath, manifest);
  }
  return { skill, target_path: result.target, method: result.method as PushResult["method"] };
}
