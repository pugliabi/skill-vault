/**
 * Compute a unified sync plan: what would `sv sync` do right now?
 *
 * Output groups (each independently runnable from the UI):
 *
 *   push    — vault → provider, for every (skill, target) where the
 *             provider's copy is `stale` or `missing`
 *   pull    — provider → vault, for every (skill, target) where the
 *             provider's copy is `stale` (included when `includePulls`)
 *   adopt   — provider → vault, for every skill present in a provider
 *             directory but absent from the manifest
 *   promote — staging skills the user might want to flip to production
 */

import fs from "node:fs";
import path from "node:path";
import { listSkills } from "./vault.ts";
import { readClaudeDesktopStage } from "./appConfig.ts";
import { defaultStageDir } from "./desktopPackaging.ts";
import type { Provider } from "../types/vault.ts";

export interface SyncPlan {
  push: Array<{ skill: string; provider_id: string; reason: "stale" | "missing" }>;
  pull: Array<{ skill: string; provider_id: string; reason: "stale" }>;
  adopt: Array<{ name: string; provider_id: string; file_count: number }>;
  promote: Array<{ name: string; modified_at: string }>;
  /**
   * Claude Desktop re-packaging — skills whose upload-ready zip went stale.
   * Opt-in: only skills that were *already* packaged (a zip exists in the
   * stage dir) show up here. A skill never packaged isn't surfaced, since
   * the user hasn't chosen to put it on Claude Desktop. Once packaged, sync
   * keeps the zip fresh by comparing the skill folder's newest file mtime
   * against the zip's mtime. (claude-desktop is a package target, not a
   * link target, so it isn't part of any skill's `targets`.)
   */
  package: Array<{ skill: string; reason: "stale"; zip_path: string }>;
}

const IGNORE_NAMES = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".DS_Store",
  "Thumbs.db",
]);

function listSkillFolders(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORE_NAMES.has(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Newest file mtime (ms) anywhere under `dir`, or 0 if empty/missing. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORE_NAMES.has(e.name)) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* ignore unreadable file */
        }
      }
    }
  }
  return newest;
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (IGNORE_NAMES.has(e.name)) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) n++;
    }
  }
  return n;
}

export function computeSyncPlan(
  vaultPath: string,
  providers: Provider[],
  includePulls = false,
): SyncPlan {
  const skills = listSkills(vaultPath, providers);

  const push: SyncPlan["push"] = [];
  for (const s of skills) {
    if (s.stage !== "production") continue;
    for (const targetId of s.targets) {
      const state = s.target_status[targetId];
      if (state === "stale" || state === "missing") {
        push.push({ skill: s.name, provider_id: targetId, reason: state });
      }
    }
  }

  const pull: SyncPlan["pull"] = [];
  if (includePulls) {
    for (const s of skills) {
      for (const targetId of s.targets) {
        if (s.target_status[targetId] === "stale") {
          pull.push({ skill: s.name, provider_id: targetId, reason: "stale" });
        }
      }
    }
  }

  // Adoptable: skill folders in any provider dir that aren't in the vault manifest.
  const vaultNames = new Set(skills.map((s) => s.name));
  const adopt: SyncPlan["adopt"] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    for (const name of listSkillFolders(provider.path)) {
      if (vaultNames.has(name)) continue;
      const key = `${provider.id}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dir = path.join(provider.path, name);
      adopt.push({
        name,
        provider_id: provider.id,
        file_count: countFiles(dir),
      });
    }
  }

  const promote: SyncPlan["promote"] = skills
    .filter((s) => s.stage === "staging")
    .map((s) => ({ name: s.name, modified_at: s.modified_at }));

  // Claude Desktop re-packaging: a production skill is stale for desktop
  // when its zip already exists in the stage dir but the skill folder has
  // changed since the zip was built. Never-packaged skills are skipped —
  // packaging is opt-in via the per-skill "Package zip" action.
  const stageDir = readClaudeDesktopStage() ?? defaultStageDir(vaultPath);
  const packagePlan: SyncPlan["package"] = [];
  for (const s of skills) {
    if (s.stage !== "production") continue;
    const zipPath = path.join(stageDir, `${s.name}.zip`);
    let zipMtime: number;
    try {
      zipMtime = fs.statSync(zipPath).mtimeMs;
    } catch {
      continue; // never packaged → not in scope
    }
    const folder = path.join(vaultPath, "skills", s.name);
    if (newestMtimeMs(folder) > zipMtime) {
      packagePlan.push({ skill: s.name, reason: "stale", zip_path: zipPath });
    }
  }

  return { push, pull, adopt, promote, package: packagePlan };
}
