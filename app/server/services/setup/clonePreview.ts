/**
 * Look inside a vault repo before Finish without keeping a copy: a shallow,
 * blobless, no-checkout clone into a temp folder gives the file list; the
 * manifest (and notion.json) are read with `git show`, which fetches just
 * those blobs. The temp folder is always removed. The real clone happens on
 * Finish (services/setup/apply.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { NotionRef } from "./types.ts";

const CLONE_URL = /^(?:https:\/\/|ssh:\/\/)\S+$|^[A-Za-z0-9_][\w.-]*@[\w.-]+:\S+$/;

export function isCloneUrl(url: string): boolean {
  return CLONE_URL.test(url.trim());
}

export class CloneError extends Error {}

/** One plain sentence for a failed git command. */
export function friendlyGitError(stderr: string): string {
  if (/ENOENT|not recognized as an internal or external command/i.test(stderr)) {
    return "Git isn't installed on this PC. Install Git for Windows, then try again.";
  }
  if (/timed out/i.test(stderr)) return "Timed out. Check the URL and your connection, then try again.";
  if (/repository not found|not found|authentication failed|could not read username|permission denied|access denied|\b403\b/i.test(stderr)) {
    return "The repo wasn't found, or it needs a sign-in this PC doesn't have.";
  }
  if (/could not resolve host/i.test(stderr)) return "Couldn't reach the server. Check the URL and your connection.";
  const line = stderr
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^warning:/i.test(s) && !/^Cloning into/i.test(s));
  return line ?? "git clone failed";
}

export interface VaultCandidate {
  /** Folder inside the repo that holds skills.json ("" = repo root). */
  subdir: string;
  skill_names: string[];
  notion: NotionRef | null;
}

/** skills.json paths in the top two levels of the repo, shallowest only. */
export function findVaultManifests(paths: string[]): string[] {
  const hits = paths.filter((p) => /^(?:[^/]+\/)?skills\.json$/.test(p));
  if (hits.length === 0) return [];
  const depth = (p: string) => p.split("/").length;
  const min = Math.min(...hits.map(depth));
  return hits.filter((p) => depth(p) === min).sort();
}

function skillDirsUnder(paths: string[], subdir: string): string[] {
  const prefix = subdir ? `${subdir}/skills/` : "skills/";
  const names = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length).split("/");
    if (rest.length === 2 && rest[1] === "SKILL.md") names.add(rest[0]);
  }
  return [...names];
}

/** rm -rf that also clears read-only bits (git marks pack files read-only on Windows). */
export function removeTree(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch {
    /* fall through: clear read-only bits, then retry */
  }
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    try {
      fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666);
    } catch {
      /* ignore */
    }
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  walk(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    console.error(`[setup] couldn't remove ${dir}: ${(err as Error).message}`);
  }
}

async function showJson(run: Run, cwd: string, file: string): Promise<Record<string, unknown> | null> {
  const r = await run("git", ["show", `HEAD:${file}`], { cwd, timeoutMs: 60_000, interactiveAuth: true });
  if (r.code !== 0) throw new CloneError(friendlyGitError(r.stderr));
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function previewClone(
  url: string,
  deps: { run: Run; tmpRoot?: string; timeoutMs?: number },
): Promise<VaultCandidate[]> {
  const tmp = fs.mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), "sv-clone-preview-"));
  try {
    const clone = await deps.run(
      "git",
      ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--quiet", "--", url, tmp],
      { cwd: path.dirname(tmp), timeoutMs: deps.timeoutMs ?? 120_000, interactiveAuth: true },
    );
    if (clone.code !== 0) throw new CloneError(friendlyGitError(clone.stderr));
    const tree = await deps.run("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: tmp,
      timeoutMs: 30_000,
    });
    if (tree.code !== 0) {
      if (/not a valid object name|ambiguous argument 'HEAD'/i.test(tree.stderr)) return []; // empty repo
      throw new CloneError(friendlyGitError(tree.stderr));
    }
    const paths = tree.stdout.split(/\r?\n/).filter(Boolean);
    const out: VaultCandidate[] = [];
    for (const manifest of findVaultManifests(paths)) {
      const subdir = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : "";
      const names = new Set(skillDirsUnder(paths, subdir));
      const m = await showJson(deps.run, tmp, manifest);
      const skills = m?.skills;
      if (skills && typeof skills === "object") for (const k of Object.keys(skills)) names.add(k);
      const notionFile = subdir ? `${subdir}/notion.json` : "notion.json";
      const n = paths.includes(notionFile) ? await showJson(deps.run, tmp, notionFile) : null;
      out.push({
        subdir,
        skill_names: [...names].sort((a, b) => a.localeCompare(b)),
        notion:
          n && typeof n.data_source_id === "string" && n.data_source_id
            ? { id: n.data_source_id, name: typeof n.data_source_name === "string" ? n.data_source_name : "" }
            : null,
      });
    }
    return out;
  } finally {
    removeTree(tmp);
  }
}
