/**
 * Background Notion checker + multi-device git guard.
 *
 * `startNotionChecker` polls the Notion cache on an interval (first run 30 s
 * after start, then every `intervalMs`, default 10 min): when connected and
 * configured, it refreshes the shared cache and, for any *linked* skill whose
 * Notion `version_id` moved since the previous cache, downloads that page and
 * records a notion-side history version — no pull, no vault write. Ticks
 * never overlap (single-flight), yield entirely to a foreground Notion job
 * (link/run/force — see `isBusy`), and errors are logged, never thrown.
 *
 * `gitGuard` answers the multi-device guard question for a vault: is it a git
 * repo, and if so is it behind its remote? Used by GET /api/notion/guard and
 * by the run/force routes (see routes/notionSync.ts) to refuse a sync while
 * another machine's changes haven't been pulled yet.
 */
import simpleGit, { type SimpleGit } from "simple-git";
import { recordVersion } from "../history.ts";
import { readManifest } from "../vault.ts";
import { NotionApi } from "./api.ts";
import { downloadAndExtract } from "./archive.ts";
import { getNotionClient, callToolJson } from "./connection.ts";
import { refreshNotionCache } from "./linker.ts";
import { readNotionAuth, readNotionCache, readNotionSettings, type NotionCache } from "./store.ts";

const FETCH_TIMEOUT_MS = 20_000;

export interface GuardStatus {
  is_repo: boolean;
  behind: number;
  ahead: number;
  error?: string;
}

/** Short "ClassName: message" for a log line — never the full stack. */
function shortError(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  return `${e.constructor.name}: ${e.message.slice(0, 200)}`;
}

// ── gitGuard ───────────────────────────────────────────────────────

/** Builds the `SimpleGit` instance gitGuard runs against; injectable for tests. */
export type GitFactory = (vaultPath: string) => SimpleGit;

/**
 * Parent env vars git needs to find itself, the user's config/credentials
 * and a temp dir (matched case-insensitively — Windows spells them
 * variously). Everything else is dropped, so editor/pager/askpass/proxy/
 * config-path overrides set on the machine never reach this git process.
 */
const PASS_THROUGH_ENV = new Set(
  [
    "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP",
    // Credential lookup for a non-interactive fetch: Git Credential Manager
    // stores under the app-data dirs; ssh uses the agent socket.
    "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "SSH_AUTH_SOCK",
  ],
);

/**
 * A minimal, explicit git environment (see PASS_THROUGH_ENV) that never
 * prompts for credentials and never waits on an interactive SSH/GCM
 * prompt — a hung `git fetch` behind a credential prompt would otherwise
 * block the guard (and the checker) indefinitely regardless of the git-level
 * timeout, since the timeout plugin only fires once the child process starts
 * producing/receiving data.
 */
export function nonInteractiveEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && PASS_THROUGH_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
}

/**
 * simple-git refuses (with a thrown `GitPluginError`) to run a command
 * whose environment sets GIT_SSH_COMMAND (and other override vars) unless
 * the matching `allowUnsafe*` flag is on, since they can be attack vectors
 * when git arguments come from untrusted input. gitGuard passes only fixed
 * literal arguments and sets GIT_SSH_COMMAND itself (BatchMode); every
 * other override is kept out by the explicit env above, so only that one
 * flag is needed.
 */
const UNSAFE_ALLOWED = { allowUnsafeSshCommand: true } as const;

const defaultGitFactory: GitFactory = (vaultPath) =>
  simpleGit({ baseDir: vaultPath, timeout: { block: FETCH_TIMEOUT_MS }, unsafe: UNSAFE_ALLOWED });

/**
 * Multi-device guard: is `vaultPath` a git repo, and is it behind its remote?
 * Never throws — a failure (including a missing/unreadable vault directory)
 * surfaces as `error` (with `is_repo`/`behind` best-effort) so callers can
 * still render a status. `git fetch` (and every other call here) is
 * non-interactive and capped at 20 s via simple-git's `timeout.block`; a repo
 * with no upstream reports `behind: 0, error: "no upstream"`.
 */
export async function gitGuard(vaultPath: string, gitFactory: GitFactory = defaultGitFactory): Promise<GuardStatus> {
  let git: SimpleGit;
  try {
    git = gitFactory(vaultPath).env(nonInteractiveEnv());
  } catch (err) {
    return { is_repo: false, behind: 0, ahead: 0, error: (err as Error).message.slice(0, 200) };
  }

  let isRepo: boolean;
  try {
    isRepo = await git.checkIsRepo();
  } catch {
    isRepo = false;
  }
  if (!isRepo) return { is_repo: false, behind: 0, ahead: 0 };

  try {
    await git.fetch(["--quiet"]);
  } catch (err) {
    return { is_repo: true, behind: 0, ahead: 0, error: (err as Error).message.slice(0, 200) };
  }

  try {
    const out = await git.raw(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    const [aheadStr, behindStr] = out.trim().split(/\s+/);
    return { is_repo: true, ahead: Number(aheadStr) || 0, behind: Number(behindStr) || 0 };
  } catch {
    return { is_repo: true, behind: 0, ahead: 0, error: "no upstream" };
  }
}

// ── Background checker ──────────────────────────────────────────

type ApiConn = { api: NotionApi; close(): Promise<void> };

async function defaultOpenApi(): Promise<ApiConn> {
  const redirectUrl = readNotionAuth().redirect_url ?? "http://localhost:9994/api/notion/callback";
  const client = await getNotionClient(redirectUrl);
  return {
    api: new NotionApi((name, args) => callToolJson(client, name, args)),
    close: () => client.close(),
  };
}

/** page_id → vault skill name, for skills currently linked (non-legacy). */
function linkedSkillsByPage(vaultPath: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(readManifest(vaultPath).skills)) {
    const link = entry.notion;
    if (link?.page_id && link.state === "linked") out.set(link.page_id, name);
  }
  return out;
}

export interface NotionCheckerDeps {
  /** Resolved fresh on every tick — the active vault may change between ticks. */
  getVaultPath: () => string | null;
  /** Time between ticks after the first. Default 10 minutes. */
  intervalMs?: number;
  /** Delay before the very first tick. Default 30 seconds. */
  firstRunDelayMs?: number;
  /**
   * True while a foreground Notion job (link, run, or force — both job
   * registries in routes/notion.ts and routes/notionSync.ts) is running. A
   * tick that finds this true at the start skips entirely; one that finds it
   * true partway through (checked again right before each history write)
   * abandons the rest of the tick rather than race a foreground job's own
   * history writes. Defaults to never busy.
   */
  isBusy?: () => boolean;
  /** Refreshes the shared Notion cache; defaults to refreshNotionCache. Overridable for tests. */
  refresh?: (api: NotionApi, vaultPath: string) => Promise<NotionCache>;
  /** Opens a connected API client (closed at the end of the tick); defaults to getNotionClient + callToolJson. */
  openApi?: () => Promise<ApiConn>;
  /** Downloads + extracts a Notion skill archive; defaults to downloadAndExtract. */
  extract?: (url: string) => Promise<{ skillRoot: string; cleanup(): void }>;
}

export interface NotionChecker {
  /** Clears both timers. Safe to call more than once. */
  stop(): void;
}

/**
 * Starts the background checker. Every tick is skipped outright (no timers
 * cleared, no error) when there's no active vault, a foreground Notion job is
 * running, Notion isn't connected, or no data source is configured — and
 * ticks never overlap: a slow tick simply makes the next scheduled one a
 * no-op.
 */
export function startNotionChecker(deps: NotionCheckerDeps): NotionChecker {
  const intervalMs = deps.intervalMs ?? 600_000;
  const firstRunDelayMs = deps.firstRunDelayMs ?? 30_000;
  const isBusy = deps.isBusy ?? (() => false);
  const refresh = deps.refresh ?? refreshNotionCache;
  const openApi = deps.openApi ?? defaultOpenApi;
  const extract = deps.extract ?? ((url: string) => downloadAndExtract(url));

  let stopped = false;
  let running = false;

  async function tick(): Promise<void> {
    if (stopped || running) return;
    const vaultPath = deps.getVaultPath();
    if (!vaultPath) return;
    if (isBusy()) return;
    if (!readNotionAuth().tokens) return;
    const dsId = readNotionSettings(vaultPath).data_source_id;
    if (!dsId) return;

    running = true;
    let conn: ApiConn | undefined;
    try {
      conn = await openApi();
      const prevCache = readNotionCache();
      // A first check (no cache yet) or a cache from a different data source
      // has nothing meaningful to diff against — refresh only, so the next
      // tick has a real baseline instead of treating every row as "changed".
      const baseline = !prevCache.checked_at || prevCache.data_source_id !== dsId;
      const prevByPage = new Map(prevCache.rows.map((r) => [r.page_id, r.version_id] as const));
      const cache = await refresh(conn.api, vaultPath);
      if (baseline) return;

      const linked = linkedSkillsByPage(vaultPath);
      for (const row of cache.rows) {
        const skill = linked.get(row.page_id);
        if (!skill || !row.version_id || row.version_id === prevByPage.get(row.page_id)) continue;
        try {
          const dl = await conn.api.downloadSkill(row.page_id);
          const ex = await extract(dl.url);
          try {
            // A foreground job (e.g. the user ran a pull) may have started
            // since the tick began — don't race its own history writes.
            if (isBusy()) break;
            recordVersion(vaultPath, skill, { side: "notion", source: "notion-edit", note: "Notion edit", dir: ex.skillRoot });
          } finally {
            ex.cleanup();
          }
        } catch (err) {
          console.error(`[notion-checker] ${shortError(err)}`);
        }
      }
    } catch (err) {
      console.error(`[notion-checker] ${shortError(err)}`);
    } finally {
      if (conn) await conn.close().catch(() => {});
      running = false;
    }
  }

  const firstTimer: NodeJS.Timeout = setTimeout(() => {
    void tick();
  }, firstRunDelayMs);
  const interval: NodeJS.Timeout = setInterval(() => {
    void tick();
  }, intervalMs);
  firstTimer.unref?.();
  interval.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearTimeout(firstTimer);
      clearInterval(interval);
    },
  };
}
