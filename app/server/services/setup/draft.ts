/**
 * The setup guide's draft: answers held until Finish, in
 * ~/.skill-vault/setup-draft.json (per machine, never in the vault).
 * normalizeDraft() is the only way in — it rebuilds the object field by
 * field, so unknown keys (and any secret a client sends) are dropped.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AssistantChoice,
  NotionChoice,
  NotionRef,
  SetupBase,
  SetupDraft,
  SetupStep,
  SetupTarget,
  SetupVault,
} from "./types.ts";

export class DraftError extends Error {}

const STEPS: SetupStep[] = ["welcome", "vault", "targets", "skills", "notion", "assistant", "review"];
const DATA_SOURCE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** Target names are config keys: any text without path separators or control characters. */
const TARGET_ID = /^[^\\/\x00-\x1f]{1,64}$/;
const isStr = (v: unknown): v is string => typeof v === "string";
const isSafeName = (v: unknown): v is string => isStr(v) && /^[^\\/\x00-\x1f]+$/.test(v) && v !== "." && v !== "..";

export function draftPath(home: string = os.homedir()): string {
  return path.join(home, ".skill-vault", "setup-draft.json");
}

/** Stable fingerprint of the config fields the guide edits (vault, targets, defaults). */
export function configFingerprint(c: Pick<SetupBase, "vault_path" | "agent_locations" | "default_targets">): string {
  const locations = Object.entries(c.agent_locations).sort(([a], [b]) => a.localeCompare(b));
  const json = JSON.stringify([c.vault_path ?? null, locations, [...c.default_targets].sort()]);
  return crypto.createHash("sha1").update(json).digest("hex");
}

/** A new draft pre-filled from the current config. */
export function startDraft(base: SetupBase, now: Date = new Date()): SetupDraft {
  return {
    version: 1,
    started_at: now.toISOString(),
    base: configFingerprint(base),
    step: "vault",
    vault: base.vault_path
      ? { mode: "existing", path: base.vault_path, ...(base.repo_url ? { repo_url: base.repo_url } : {}) }
      : null,
    machine_id: base.machine_id ?? os.hostname(),
    targets: null,
    skills: { adopt: [], push: [] },
    notion: null,
    assistant: null,
  };
}

function normalizeNotionRef(v: unknown): NotionRef | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  return isStr(o.id) && DATA_SOURCE_ID.test(o.id) ? { id: o.id, name: isStr(o.name) ? o.name : "" } : null;
}

function normalizeVault(v: unknown): SetupVault | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (o.mode !== "new" && o.mode !== "existing" && o.mode !== "clone") {
    throw new DraftError("vault.mode must be new, existing or clone");
  }
  const repo = isStr(o.repo_url) && o.repo_url.trim() ? { repo_url: o.repo_url.trim() } : {};
  if (o.mode === "clone") {
    const c = (o.clone ?? {}) as Record<string, unknown>;
    if (!isStr(c.url) || !c.url.trim() || !isStr(c.dest) || !c.dest.trim() || !isStr(c.subdir) || !Array.isArray(c.skill_names)) {
      throw new DraftError("vault.clone needs url, dest, subdir and skill_names");
    }
    const dest = c.dest.trim();
    return {
      mode: "clone",
      path: c.subdir ? path.join(dest, c.subdir) : dest,
      clone: {
        url: c.url.trim(),
        dest,
        subdir: c.subdir,
        skill_names: c.skill_names.filter(isSafeName),
        notion: normalizeNotionRef(c.notion),
      },
      ...repo,
    };
  }
  if (!isStr(o.path) || !o.path.trim()) throw new DraftError("vault.path is required");
  return { mode: o.mode, path: o.path.trim(), ...repo };
}

function normalizeTargets(v: unknown): SetupTarget[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new DraftError("targets must be a list");
  const seen = new Set<string>();
  return v.map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const id = isStr(o.id) ? o.id.trim() : "";
    if (!TARGET_ID.test(id)) throw new DraftError(`bad target name: ${String(o.id)}`);
    if (seen.has(id)) throw new DraftError(`target ${id} is listed twice`);
    seen.add(id);
    if (!isStr(o.path) || !o.path.trim()) throw new DraftError(`target ${id} needs a folder`);
    const enabled = o.enabled === true;
    return { id, path: o.path.trim(), enabled, is_default: enabled && o.is_default === true, known: o.known === true };
  });
}

function normalizeSkills(v: unknown): SetupDraft["skills"] {
  const o = (v ?? {}) as Record<string, unknown>;
  const adoptIn = Array.isArray(o.adopt) ? o.adopt : [];
  const pushIn = Array.isArray(o.push) ? o.push : [];
  const adopt = adoptIn.map((a) => {
    const r = (a ?? {}) as Record<string, unknown>;
    if (!isSafeName(r.name) || !isStr(r.from) || !TARGET_ID.test(r.from)) throw new DraftError("bad adopt item");
    return { name: r.name, from: r.from };
  });
  const push = pushIn.map((p) => {
    if (!isSafeName(p)) throw new DraftError("bad push item");
    return p;
  });
  return { adopt, push };
}

function normalizeNotion(v: unknown): NotionChoice | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.data_source_id) || !DATA_SOURCE_ID.test(o.data_source_id)) {
    throw new DraftError("notion.data_source_id must be a Notion data source id");
  }
  return {
    data_source_id: o.data_source_id,
    data_source_name: isStr(o.data_source_name) ? o.data_source_name : "",
    add_last_edited: o.add_last_edited === true,
  };
}

function normalizeAssistant(v: unknown): AssistantChoice | null {
  if (v == null) return null;
  const o = v as Record<string, unknown>;
  if (o.auth !== "login" && o.auth !== "api_key") throw new DraftError('assistant.auth must be "login" or "api_key"');
  const ws = isStr(o.workspace_id) && o.workspace_id.trim() ? { workspace_id: o.workspace_id.trim() } : {};
  return { auth: o.auth, ...ws };
}

export function normalizeDraft(input: unknown): SetupDraft {
  const o = (input ?? {}) as Record<string, unknown>;
  if (o.version !== 1) throw new DraftError("unsupported draft version");
  if (!isStr(o.started_at) || !isStr(o.base)) throw new DraftError("draft is missing started_at or base");
  return {
    version: 1,
    started_at: o.started_at,
    base: o.base,
    step: STEPS.includes(o.step as SetupStep) ? (o.step as SetupStep) : "welcome",
    vault: normalizeVault(o.vault),
    ...(isStr(o.machine_id) && o.machine_id.trim() ? { machine_id: o.machine_id.trim() } : {}),
    ...(o.skills_reviewed === true ? { skills_reviewed: true } : {}),
    targets: normalizeTargets(o.targets),
    skills: normalizeSkills(o.skills),
    notion: normalizeNotion(o.notion),
    assistant: normalizeAssistant(o.assistant),
  };
}

/** The saved draft, or null when there is none or it can't be read. */
export function readDraft(home?: string): SetupDraft | null {
  try {
    return normalizeDraft(JSON.parse(fs.readFileSync(draftPath(home), "utf8")));
  } catch {
    return null;
  }
}

export function writeDraft(draft: SetupDraft, home?: string): void {
  const file = draftPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeDraft(draft), null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function deleteDraft(home?: string): void {
  fs.rmSync(draftPath(home), { force: true });
}
