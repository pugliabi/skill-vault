/**
 * The setup guide's optional Skills step: which skills in the chosen targets
 * aren't in the vault (adopt), which vault skills aren't in the default
 * targets (push), and which names exist on both sides with different content
 * (never moved — sorted out later on the Adopt page). A target entry that is
 * a link into the vault, or an identical copy, needs nothing.
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../types/vault.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import type { SetupDraft } from "./types.ts";

export interface EffectiveTarget {
  id: string;
  path: string;
  is_default: boolean;
}

/** The targets Finish will save: the draft's (enabled only) when chosen, else the config's. */
export function effectiveTargets(draft: SetupDraft, cfg: Pick<AppConfig, "providers" | "default_targets">): EffectiveTarget[] {
  if (draft.targets) return draft.targets.filter((t) => t.enabled).map((t) => ({ id: t.id, path: t.path, is_default: t.is_default }));
  const defaults = new Set(cfg.default_targets ?? []);
  return cfg.providers.map((p) => ({ id: p.id, path: p.path, is_default: defaults.has(p.id) }));
}

export interface PlanInput {
  vault: { mode: "new" | "existing" | "clone"; path: string; clone_skill_names?: string[] };
  targets: EffectiveTarget[];
}

export interface SkillsPlan {
  adopt: { name: string; from: string; path: string }[];
  /** Not in the vault, but different in two targets: can't pick one here. */
  adopt_conflicts: { name: string; targets: string[] }[];
  push: { name: string; missing_in: string[] }[];
  /** In the vault and in a target with different content; unknown = the vault isn't cloned yet. */
  differs: { name: string; target: string; unknown: boolean }[];
}

/** name → folder for every entry (folder or link) that has a SKILL.md. */
function skillEntries(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if ((e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(p, "SKILL.md"))) out.set(e.name, p);
  }
  return out;
}

function presentNames(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir));
  } catch {
    return new Set();
  }
}

function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

export function planSkills(input: PlanInput): SkillsPlan {
  const vaultSkills = new Map<string, string | null>();
  if (input.vault.mode === "existing") {
    for (const [name, dir] of skillEntries(path.join(input.vault.path, "skills"))) vaultSkills.set(name, dir);
  } else if (input.vault.mode === "clone") {
    for (const name of input.vault.clone_skill_names ?? []) vaultSkills.set(name, null);
  }

  const hashCache = new Map<string, string | null>();
  const hash = (dir: string) => {
    const key = real(dir);
    if (!hashCache.has(key)) hashCache.set(key, hashSkillDirNormalized(dir));
    return hashCache.get(key) ?? null;
  };

  const differs: SkillsPlan["differs"] = [];
  const candidates = new Map<string, { target: string; path: string }[]>();
  for (const t of input.targets) {
    for (const [name, entry] of skillEntries(t.path)) {
      if (!vaultSkills.has(name)) {
        candidates.set(name, [...(candidates.get(name) ?? []), { target: t.id, path: entry }]);
        continue;
      }
      const vaultDir = vaultSkills.get(name) ?? null;
      if (vaultDir === null) {
        differs.push({ name, target: t.id, unknown: true });
      } else if (real(entry) !== real(vaultDir) && hash(entry) !== hash(vaultDir)) {
        differs.push({ name, target: t.id, unknown: false });
      }
    }
  }

  const adopt: SkillsPlan["adopt"] = [];
  const adopt_conflicts: SkillsPlan["adopt_conflicts"] = [];
  for (const [name, copies] of candidates) {
    const first = hash(copies[0].path);
    if (copies.every((c) => hash(c.path) === first)) adopt.push({ name, from: copies[0].target, path: copies[0].path });
    else adopt_conflicts.push({ name, targets: copies.map((c) => c.target) });
  }

  const defaults = input.targets.filter((t) => t.is_default).map((t) => ({ id: t.id, present: presentNames(t.path) }));
  const push: SkillsPlan["push"] = [];
  for (const name of vaultSkills.keys()) {
    const missing_in = defaults.filter((d) => !d.present.has(name)).map((d) => d.id);
    if (missing_in.length > 0) push.push({ name, missing_in });
  }

  return {
    adopt: adopt.sort(byName),
    adopt_conflicts: adopt_conflicts.sort(byName),
    push: push.sort(byName),
    differs: differs.sort(byName),
  };
}
