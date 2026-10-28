/**
 * The setup guide's Finish job. Fixed order:
 *   1 vault folder (create / check / git clone) + initVault
 *   2 config (one write) + watcher rebuild — then the draft is deleted
 *   3 adopt, 4 push, 5 Notion database — item by item
 * Steps 1–2 stop the job on failure (config untouched). Steps 3–5 record a
 * failed item and carry on; retry() re-runs only those. One job at a time.
 * The API key goes straight into the config patch and never into an event.
 */
import fs from "node:fs";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { SetupConfigPatch } from "../appConfig.ts";
import type { AppConfig, Provider } from "../../types/vault.ts";
import { friendlyGitError } from "./clonePreview.ts";
import { effectiveTargets, type EffectiveTarget } from "./plan.ts";
import type { NotionChoice, SetupDraft, SetupVault } from "./types.ts";

export type ApplyStep = "vault" | "config" | "adopt" | "push" | "notion";

export interface SetupEvent {
  step: ApplyStep | "done";
  state: "start" | "done" | "skip" | "error";
  item?: string;
  message?: string;
}

export interface FailedItem {
  step: "adopt" | "push" | "notion";
  item: string;
  message: string;
}

export interface SetupJobState {
  running: boolean;
  /** null until a job finished; true = everything done. */
  ok: boolean | null;
  /** Set once config was saved (steps 1–2 succeeded). */
  vault_path: string | null;
  events: SetupEvent[];
  failed: FailedItem[];
}

export interface ApplyRequest {
  draft: SetupDraft;
  api_key?: string;
  /** Notion OAuth redirect URL for this server (routes/notion.ts redirectUrlFor). */
  notion_redirect_url?: string;
}

export interface SetupApplyDeps {
  run: Run;
  readConfig: () => Pick<AppConfig, "providers" | "default_targets">;
  initVault: (vaultPath: string) => void;
  writeConfig: (patch: SetupConfigPatch) => void;
  rebuildWatcher: () => void;
  adopt: (vaultPath: string, item: { name: string; path: string; providerId: string }) => "imported" | "skipped";
  push: (vaultPath: string, skill: string, provider: Provider) => void;
  saveNotion: (vaultPath: string, choice: NotionChoice, redirectUrl?: string) => Promise<{ warning?: string }>;
  deleteDraft: () => void;
  cloneTimeoutMs?: number;
}

export interface SetupApplier {
  isRunning(): boolean;
  status(): SetupJobState;
  apply(req: ApplyRequest, onEvent: (e: SetupEvent) => void): Promise<SetupJobState>;
  retry(onEvent: (e: SetupEvent) => void): Promise<SetupJobState>;
}

export class SetupBusyError extends Error {}

type WorkItem =
  | { kind: "adopt"; label: string; name: string; path: string; providerId: string }
  | { kind: "push"; label: string; name: string; provider: Provider }
  | { kind: "notion"; label: string; choice: NotionChoice };

function isEmptyOrMissing(p: string): boolean {
  try {
    return fs.readdirSync(p).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * A "new" vault folder may hold the skeleton a previous, half-finished run left
 * (initVault's empty skills/ and a skills.json with no skills). Unreadable JSON
 * counts as not empty.
 */
function isEmptyOrSkeleton(p: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(p);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  for (const name of entries) {
    const full = path.join(p, name);
    try {
      if (name === "skills" && fs.statSync(full).isDirectory() && fs.readdirSync(full).length === 0) continue;
      if (name === "skills.json" && fs.statSync(full).isFile()) {
        const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { skills?: unknown };
        const skills = parsed?.skills;
        if (skills === undefined || (skills !== null && typeof skills === "object" && Object.keys(skills).length === 0)) continue;
      }
    } catch {
      return false;
    }
    return false;
  }
  return true;
}

async function prepareVault(v: SetupVault, run: Run, timeoutMs: number): Promise<void> {
  if (v.mode === "existing") {
    if (!fs.existsSync(v.path) || !fs.statSync(v.path).isDirectory()) throw new Error(`The folder doesn't exist: ${v.path}`);
    return;
  }
  if (v.mode === "new") {
    if (!isEmptyOrSkeleton(v.path)) throw new Error(`The folder isn't empty: ${v.path}`);
    fs.mkdirSync(v.path, { recursive: true });
    return;
  }
  const clone = v.clone;
  if (!clone) throw new Error("The clone details are missing.");
  if (!isEmptyOrMissing(clone.dest)) throw new Error(`The clone folder isn't empty: ${clone.dest}`);
  fs.mkdirSync(path.dirname(clone.dest), { recursive: true });
  const r = await run("git", ["clone", "--quiet", "--", clone.url, clone.dest], {
    cwd: path.dirname(clone.dest),
    timeoutMs,
    interactiveAuth: true,
  });
  if (r.code !== 0) throw new Error(friendlyGitError(r.stderr));
}

function vaultStartMessage(v: SetupVault): string {
  if (v.mode === "new") return `Creating ${v.path}`;
  if (v.mode === "existing") return `Using ${v.path}`;
  return `Cloning ${v.clone?.url ?? ""}`;
}

/** Finish step 2: the whole config write. Skipped areas (null) are left out. */
export function configPatch(draft: SetupDraft, targets: EffectiveTarget[], apiKey?: string): SetupConfigPatch {
  const vault = draft.vault as SetupVault;
  const patch: SetupConfigPatch = {
    vault_path: vault.path,
    repo_url: vault.mode === "clone" && vault.clone ? vault.clone.url : (vault.repo_url ?? ""),
  };
  if (draft.targets) {
    patch.providers = targets.map((t) => ({ id: t.id, path: t.path }));
    patch.default_targets = targets.filter((t) => t.is_default).map((t) => t.id);
  }
  if (draft.machine_id) patch.machine_id = draft.machine_id;
  if (draft.assistant) {
    patch.assistant = {
      auth: draft.assistant.auth,
      workspace_id: draft.assistant.workspace_id ?? "",
      ...(apiKey?.trim() ? { api_key: apiKey.trim() } : {}),
    };
  }
  return patch;
}

function workItems(draft: SetupDraft, targets: EffectiveTarget[]): { items: WorkItem[]; unretryable: FailedItem[] } {
  const items: WorkItem[] = [];
  const unretryable: FailedItem[] = [];
  for (const a of draft.skills.adopt) {
    const t = targets.find((x) => x.id === a.from);
    if (!t) {
      unretryable.push({ step: "adopt", item: a.name, message: `${a.from} is no longer a selected target` });
      continue;
    }
    items.push({ kind: "adopt", label: `${a.name} (from ${t.id})`, name: a.name, path: path.join(t.path, a.name), providerId: t.id });
  }
  for (const name of draft.skills.push) {
    for (const t of targets.filter((x) => x.is_default)) {
      if (fs.existsSync(path.join(t.path, name))) continue;
      items.push({ kind: "push", label: `${name} → ${t.id}`, name, provider: { id: t.id, path: t.path } });
    }
  }
  if (draft.notion) {
    items.push({ kind: "notion", label: draft.notion.data_source_name || draft.notion.data_source_id, choice: draft.notion });
  }
  return { items, unretryable };
}

export function createSetupApplier(deps: SetupApplyDeps): SetupApplier {
  let running = false;
  let state: SetupJobState = { running: false, ok: null, vault_path: null, events: [], failed: [] };
  let retryItems: WorkItem[] = [];
  let unretryable: FailedItem[] = [];
  let redirectUrl: string | undefined;

  const snapshot = (): SetupJobState => ({ ...state, events: [...state.events], failed: [...state.failed] });

  const emitter = (onEvent: (e: SetupEvent) => void) => (e: SetupEvent) => {
    state.events.push(e);
    try {
      onEvent(e);
    } catch {
      /* a closed stream must not stop the job */
    }
  };

  async function runItems(items: WorkItem[], vaultPath: string, emit: (e: SetupEvent) => void): Promise<WorkItem[]> {
    const failed: WorkItem[] = [];
    let current: ApplyStep | null = null;
    for (const it of items) {
      if (it.kind !== current) {
        current = it.kind;
        emit({ step: it.kind, state: "start" });
      }
      try {
        if (it.kind === "adopt") {
          const r = deps.adopt(vaultPath, { name: it.name, path: it.path, providerId: it.providerId });
          emit(r === "imported" ? { step: "adopt", state: "done", item: it.label } : { step: "adopt", state: "skip", item: it.label, message: "already in the vault" });
        } else if (it.kind === "push") {
          deps.push(vaultPath, it.name, it.provider);
          emit({ step: "push", state: "done", item: it.label });
        } else {
          const r = await deps.saveNotion(vaultPath, it.choice, redirectUrl);
          emit({ step: "notion", state: "done", item: it.label, ...(r.warning ? { message: r.warning } : {}) });
        }
      } catch (err) {
        const message = (err as Error).message;
        failed.push(it);
        state.failed.push({ step: it.kind, item: it.label, message });
        emit({ step: it.kind, state: "error", item: it.label, message });
      }
    }
    return failed;
  }

  function finish(emit: (e: SetupEvent) => void): void {
    state.ok = state.failed.length === 0;
    emit({
      step: "done",
      state: state.ok ? "done" : "error",
      message: state.ok ? "Setup finished" : `${state.failed.length} item(s) need attention`,
    });
  }

  return {
    isRunning: () => running,
    status: snapshot,

    async apply(req, onEvent) {
      if (running) throw new SetupBusyError("Setup is already running");
      running = true;
      state = { running: true, ok: null, vault_path: null, events: [], failed: [] };
      retryItems = [];
      unretryable = [];
      redirectUrl = req.notion_redirect_url;
      const emit = emitter(onEvent);
      try {
        const { draft } = req;
        const vault = draft.vault;
        if (!vault) {
          emit({ step: "vault", state: "error", message: "Choose a vault first." });
          state.ok = false;
          return snapshot();
        }

        emit({ step: "vault", state: "start", message: vaultStartMessage(vault) });
        try {
          await prepareVault(vault, deps.run, deps.cloneTimeoutMs ?? 600_000);
          deps.initVault(vault.path);
        } catch (err) {
          emit({ step: "vault", state: "error", message: (err as Error).message });
          state.ok = false;
          return snapshot();
        }
        emit({ step: "vault", state: "done", message: vault.path });

        emit({ step: "config", state: "start" });
        const targets = effectiveTargets(draft, deps.readConfig());
        try {
          deps.writeConfig(configPatch(draft, targets, req.api_key));
        } catch (err) {
          const where = vault.mode === "clone" && vault.clone
            ? ` The repo was cloned to ${vault.clone.dest}: delete that folder, or choose it as an existing vault.`
            : "";
          emit({ step: "config", state: "error", message: `Couldn't save settings: ${(err as Error).message}.${where}` });
          state.ok = false;
          return snapshot();
        }
        try {
          deps.rebuildWatcher();
          emit({ step: "config", state: "done" });
        } catch {
          emit({ step: "config", state: "done", message: "Settings saved. Restart Skill Vault to watch the new folders." });
        }
        state.vault_path = vault.path;
        try {
          deps.deleteDraft();
        } catch {
          /* best effort: a stale draft is caught by its fingerprint */
        }

        const work = workItems(draft, targets);
        unretryable = work.unretryable;
        for (const f of unretryable) {
          state.failed.push(f);
          emit({ step: f.step, state: "error", item: f.item, message: f.message });
        }
        retryItems = await runItems(work.items, vault.path, emit);
        finish(emit);
        return snapshot();
      } finally {
        running = false;
        state.running = false;
      }
    },

    async retry(onEvent) {
      if (running) throw new SetupBusyError("Setup is already running");
      if (!state.vault_path || retryItems.length === 0) return snapshot();
      running = true;
      state.running = true;
      const emit = emitter(onEvent);
      try {
        state.failed = [...unretryable];
        retryItems = await runItems(retryItems, state.vault_path, emit);
        finish(emit);
        return snapshot();
      } finally {
        running = false;
        state.running = false;
      }
    },
  };
}
