/**
 * Setup guide API (server: routes/setup.ts). Finish and Retry stream NDJSON
 * progress events, like the in-app update (lib/appUpdate.ts).
 */
import { ApiError, readNdjson } from "./api";

export type SetupStep = "welcome" | "vault" | "targets" | "skills" | "notion" | "assistant" | "review";

export interface NotionRef {
  id: string;
  name: string;
}

export interface SetupVault {
  mode: "new" | "existing" | "clone";
  path: string;
  clone?: { url: string; dest: string; subdir: string; skill_names: string[]; notion: NotionRef | null };
  repo_url?: string;
}

export interface SetupTarget {
  id: string;
  path: string;
  enabled: boolean;
  is_default: boolean;
  known: boolean;
}

export interface SetupDraft {
  version: 1;
  started_at: string;
  base: string;
  step: SetupStep;
  vault: SetupVault | null;
  machine_id?: string;
  /** true once the user has been through the Skills step (Next or Skip). */
  skills_reviewed?: boolean;
  targets: SetupTarget[] | null;
  skills: { adopt: { name: string; from: string }[]; push: string[] };
  notion: { data_source_id: string; data_source_name: string; add_last_edited: boolean } | null;
  assistant: { auth: "login" | "api_key"; workspace_id?: string } | null;
}

export type FolderKind =
  | "missing"
  | "not_dir"
  | "unreadable"
  | "empty"
  | "vault"
  | "vault_no_manifest"
  | "skills_folder"
  | "other";

export interface FolderInfo {
  path: string;
  kind: FolderKind;
  writable: boolean;
  skill_count: number;
  git: { root: string; origin: string | null } | null;
  notion: NotionRef | null;
}

export interface DetectedTarget {
  id: string;
  label: string;
  path: string;
  status: "found" | "installed" | "not_found";
  configured: boolean;
  is_default: boolean;
  known: boolean;
}

export interface VaultCandidate {
  subdir: string;
  skill_names: string[];
  notion: NotionRef | null;
}

export interface SkillsPlan {
  adopt: { name: string; from: string; path: string }[];
  adopt_conflicts: { name: string; targets: string[] }[];
  push: { name: string; missing_in: string[] }[];
  differs: { name: string; target: string; unknown: boolean }[];
}

export interface SetupEvent {
  step: "vault" | "config" | "adopt" | "push" | "notion" | "done";
  state: "start" | "done" | "skip" | "error";
  item?: string;
  message?: string;
}

export interface SetupJobState {
  running: boolean;
  ok: boolean | null;
  vault_path: string | null;
  events: SetupEvent[];
  failed: { step: "adopt" | "push" | "notion"; item: string; message: string }[];
}

export interface AssistantCheck {
  installed: boolean;
  version: string | null;
  reason: string | null;
  login: { logged_in: boolean; auth_method: string | null; email: string | null } | null;
  saved: { auth: "login" | "api_key"; has_saved_key: boolean; env_key_present: boolean; workspace_id: string | null };
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

async function stream(url: string, body: unknown, onEvent: (e: SetupEvent) => void): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError((data as { error?: string } | null)?.error ?? `Setup failed to start (${res.status})`, res.status, data);
  }
  await readNdjson<SetupEvent>(res, onEvent);
}

export const setupApi = {
  capabilities: () => call<{ folder_dialog: boolean }>("GET", "/api/setup/capabilities"),
  getDraft: () => call<{ draft: SetupDraft | null; stale: boolean }>("GET", "/api/setup/draft"),
  startDraft: () => call<{ draft: SetupDraft }>("POST", "/api/setup/draft/start"),
  saveDraft: (draft: SetupDraft) => call<{ draft: SetupDraft }>("PUT", "/api/setup/draft", draft),
  discardDraft: () => call<null>("DELETE", "/api/setup/draft"),
  pickFolder: (opts: { title?: string; initial?: string }) =>
    call<{ path: string } | { cancelled: true }>("POST", "/api/setup/pick-folder", opts),
  inspect: (path: string) => call<FolderInfo>("POST", "/api/setup/inspect", { path }),
  targets: () => call<{ targets: DetectedTarget[] }>("GET", "/api/setup/targets"),
  clonePreview: (url: string) => call<{ candidates: VaultCandidate[] }>("POST", "/api/setup/clone-preview", { url }),
  plan: (draft: SetupDraft) => call<SkillsPlan>("POST", "/api/setup/plan", { draft }),
  assistant: (refresh = false) => call<AssistantCheck>("GET", `/api/setup/assistant${refresh ? "?refresh=1" : ""}`),
  apply: (draft: SetupDraft, apiKey: string, onEvent: (e: SetupEvent) => void) =>
    stream("/api/setup/apply", { draft, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }, onEvent),
  retry: (onEvent: (e: SetupEvent) => void) => stream("/api/setup/apply/retry", {}, onEvent),
  applyStatus: () => call<SetupJobState>("GET", "/api/setup/apply/status"),
};

/** True for C:\x, C:/x, \\server\share and /x — the server rejects anything else. */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || /^\//.test(p);
}

/** Join a folder and a name with the folder's own separator (paths come from Windows or POSIX). */
export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/** "https://github.com/me/my-vault.git" → "my-vault". */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || "skill-vault";
}
