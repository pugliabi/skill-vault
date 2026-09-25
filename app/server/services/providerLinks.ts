/**
 * Keep provider skill folders (e.g. <agent>/skills/<name>) correct when a
 * vault skill is renamed or deleted through the app. Only links
 * (symlinks / junctions) that point at the vault folder are ever removed;
 * real (copied) folders are never deleted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider } from "../types/vault.ts";
import { linkSkillDir, unlinkOrRemove } from "./linking.ts";

const IS_WINDOWS = os.platform() === "win32";

export interface ProviderOutcome {
  provider_id: string;
  /**
   * relinked:  the old link was replaced by a link under the new name
   * copy-left: the old entry is a real folder — left as is; the new name was linked
   * removed:   (delete) a link to the deleted skill was removed
   * error:     something failed or was refused for this provider (see message)
   */
  outcome: "relinked" | "copy-left" | "removed" | "error";
  message: string;
}

function normalize(p: string): string {
  let s = p.replace(/^\\\\\?\\/, "");
  s = path.resolve(s).replace(/[\\/]+$/, "");
  return IS_WINDOWS ? s.toLowerCase() : s;
}

/**
 * The raw target of a symlink or junction (works when it dangles), or null
 * when `p` is missing or not a link.
 */
export function rawLinkTarget(p: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink() && !(IS_WINDOWS && st.isDirectory())) return null;
  try {
    const t = fs.readlinkSync(p);
    return path.resolve(path.dirname(p), t.replace(/^\\\\\?\\/, ""));
  } catch {
    return null; // a real directory
  }
}

function pointsTo(linkPath: string, dir: string): boolean {
  const t = rawLinkTarget(linkPath);
  return t !== null && normalize(t) === normalize(dir);
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * After <vault>/skills/<oldName> was renamed to <newName> (at `newDir`):
 * for each provider with an entry named `oldName`,
 *  - a link to the old vault folder → removed and re-created as a link named `newName`;
 *  - a real folder → left untouched ("old copy left at …"), `newName` linked;
 *  - a link to somewhere else → not ours, left alone (no outcome).
 * An existing real folder named `newName` in a provider is never replaced.
 */
export function relinkProviders(
  providers: Provider[],
  oldDir: string,
  newDir: string,
  oldName: string,
  newName: string,
): ProviderOutcome[] {
  const out: ProviderOutcome[] = [];
  for (const p of providers) {
    const oldEntry = path.join(p.path, oldName);
    if (!exists(oldEntry)) continue;
    const isOurLink = pointsTo(oldEntry, oldDir);
    const isRealDir = rawLinkTarget(oldEntry) === null;
    if (!isOurLink && !isRealDir) continue;
    try {
      const newEntry = path.join(p.path, newName);
      if (exists(newEntry) && rawLinkTarget(newEntry) === null) {
        out.push({
          provider_id: p.id,
          outcome: "error",
          message: `${newEntry} already exists as a real folder — left as is${isOurLink ? `; old link ${oldEntry} kept` : ""}`,
        });
        continue;
      }
      if (isOurLink) unlinkOrRemove(oldEntry);
      const r = linkSkillDir(newDir, newEntry);
      if (r.method === "skip") throw new Error(r.reason ?? "link skipped");
      out.push(
        isOurLink
          ? { provider_id: p.id, outcome: "relinked", message: `${oldEntry} → ${newEntry} (${r.method})` }
          : { provider_id: p.id, outcome: "copy-left", message: `old copy left at ${oldEntry}; linked ${newEntry} (${r.method})` },
      );
    } catch (err) {
      out.push({ provider_id: p.id, outcome: "error", message: (err as Error).message });
    }
  }
  return out;
}

/**
 * Before/after deleting <vault>/skills/<name> (at `dir`): remove every
 * provider entry named `name` that is a link to `dir`. Real folders and
 * links elsewhere are left alone.
 */
export function unlinkProviders(providers: Provider[], dir: string, name: string): ProviderOutcome[] {
  const out: ProviderOutcome[] = [];
  for (const p of providers) {
    const entry = path.join(p.path, name);
    if (!pointsTo(entry, dir)) continue;
    try {
      unlinkOrRemove(entry);
      out.push({ provider_id: p.id, outcome: "removed", message: `removed link ${entry}` });
    } catch (err) {
      out.push({ provider_id: p.id, outcome: "error", message: (err as Error).message });
    }
  }
  return out;
}
