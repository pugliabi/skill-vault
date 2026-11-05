/**
 * The bundled skill-vault skill in a vault: is it there and ours, add it,
 * push it to one tool. Shared by Settings → Agent access
 * (routes/agentAccess.ts) and the setup guide's Finish
 * (services/setup/applyDeps.ts). Callers record activity; this doesn't.
 */
import fs from "node:fs";
import path from "node:path";
import { importSkills } from "../adoption.ts";
import { isLink, resolveLink } from "../linking.ts";
import { pushSkillToProvider } from "../pushSkill.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";
import { readManifest, skillDir } from "../vault.ts";
import type { Provider } from "../../types/vault.ts";
import { BUNDLED_SKILL_NAME, bundledSkillDir, bundledSkillsRoot } from "./bundledSkill.ts";

export type BundledSkillState = "not_in_vault" | "in_vault" | "update_available" | "name_taken";

export const NAME_TAKEN = `Your vault already has a skill named "${BUNDLED_SKILL_NAME}" from somewhere else. Rename it to add this one.`;
export const BUNDLED_MISSING = `The app's bundled ${BUNDLED_SKILL_NAME} skill folder is missing. Reinstall or rebuild the app.`;
export const NOT_IN_VAULT_YET = `${BUNDLED_SKILL_NAME} isn't in the vault yet`;

export function foreignFolderMessage(dest: string): string {
  return `a ${BUNDLED_SKILL_NAME} folder that isn't from your vault is already there (${dest}) — rename or remove it first`;
}

const samePath = (a: string | undefined, b: string): boolean =>
  !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** True when `p` is a symlink or junction to `vaultCopy` (an earlier push of ours). */
function linksTo(p: string, vaultCopy: string): boolean {
  const target = isLink(p) ? resolveLink(p) : null;
  return !!target && (samePath(target, vaultCopy) || samePath(realOr(target), realOr(vaultCopy)));
}

export function bundledSkillState(appRoot: string, vaultPath: string): { state: BundledSkillState; targets: string[] } {
  const entry = readManifest(vaultPath).skills[BUNDLED_SKILL_NAME];
  const vaultCopy = skillDir(vaultPath, BUNDLED_SKILL_NAME);
  if (!entry && !fs.existsSync(vaultCopy)) return { state: "not_in_vault", targets: [] };
  const origin = entry?.origin;
  // Any app checkout's bundled-skills folder, not only this one: a moved or
  // re-cloned app must still know its own copy. win32 basename splits on
  // both separators, so a vault shared with another OS reads the same.
  const ours =
    origin?.type === "dir" &&
    origin.subpath === BUNDLED_SKILL_NAME &&
    !!origin.path &&
    path.win32.basename(origin.path).toLowerCase() === path.basename(bundledSkillsRoot(appRoot)).toLowerCase();
  if (!entry || !origin || !ours) return { state: "name_taken", targets: entry?.targets ?? [] };
  const vaultHash = hashSkillDirNormalized(vaultCopy);
  // One-click refresh only while the vault copy is untouched since import;
  // a locally edited copy goes through the normal Updates flow instead.
  const untouched = vaultHash === origin.content_hash;
  const differs = vaultHash !== hashSkillDirNormalized(bundledSkillDir(appRoot));
  return { state: untouched && differs ? "update_available" : "in_vault", targets: entry.targets };
}

/** importSkills from the app's bundled-skills folder, recorded with a dir origin. */
export function importBundledSkill(appRoot: string, vaultPath: string, opts: { overwrite: boolean }) {
  const sourceRoot = bundledSkillsRoot(appRoot);
  return importSkills(
    vaultPath,
    sourceRoot,
    [],
    undefined,
    undefined,
    [{ name: BUNDLED_SKILL_NAME, path: bundledSkillDir(appRoot) }],
    { overwrite: opts.overwrite, originContext: { type: "dir", root: sourceRoot } },
  );
}

/** The guide's add: import only when the vault has no skill-vault; never overwrite. */
export function addBundledSkillIfMissing(appRoot: string, vaultPath: string): "added" | "already" {
  const { state } = bundledSkillState(appRoot, vaultPath);
  if (state === "name_taken") throw new Error(NAME_TAKEN);
  if (state !== "not_in_vault") return "already";
  if (!fs.existsSync(bundledSkillDir(appRoot))) throw new Error(BUNDLED_MISSING);
  const r = importBundledSkill(appRoot, vaultPath, { overwrite: false });
  if (!r.imported.includes(BUNDLED_SKILL_NAME)) throw new Error(`Couldn't add ${BUNDLED_SKILL_NAME} to the vault.`);
  return "added";
}

/**
 * Push the vault copy to one tool. A push replaces whatever is at the
 * target, so only nothing at all, or a link to the vault copy, is ours.
 */
export function pushBundledSkill(vaultPath: string, provider: Provider): void {
  const vaultCopy = skillDir(vaultPath, BUNDLED_SKILL_NAME);
  if (!fs.existsSync(vaultCopy)) throw new Error(NOT_IN_VAULT_YET);
  const dest = path.join(provider.path, BUNDLED_SKILL_NAME);
  if ((fs.existsSync(dest) || isLink(dest)) && !linksTo(dest, vaultCopy)) throw new Error(foreignFolderMessage(dest));
  pushSkillToProvider(vaultPath, BUNDLED_SKILL_NAME, provider);
}
