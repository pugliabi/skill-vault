/**
 * In-app updates for a git-cloned install (design: docs/superpowers/specs/
 * 2026-10-27-install-and-launch-design.md §5).
 *
 * Check: `git fetch origin` 5 s after start and every 6 h, then compare
 * HEAD with origin/main. A higher app/package.json version on origin/main is
 * a new version (the client prompts for it at startup, with its CHANGELOG
 * section as release notes); other commits only light the Update pill.
 * Apply (below): pull --ff-only → `npm ci` only when
 * package-lock.json changed → build into dist-next/ and swap it into dist/
 * → hand over to a fresh server (deps.restart). Any failure before the
 * hand-over resets the checkout to the old commit (`git reset --keep`: a
 * clean tree is required to start, and edits made meanwhile are never
 * discarded), logs the failed step's full output, and the running server
 * keeps serving its build. Only one apply runs at a time.
 *
 * Every command goes through an injectable Run, so tests never touch git or npm.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultKillTree, type ChildProcessLike } from "./claude/cli.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** git only: allow Git Credential Manager's own sign-in window (still never a terminal prompt). */
    interactiveAuth?: boolean;
  },
) => Promise<RunResult>;

/**
 * Spawn options for every command. On macOS/Linux the child leads its own
 * process group (as the Claude runner's do), so defaultKillTree's group kill
 * reaches npm's build and lifecycle-script descendants on timeout; Windows
 * kills the tree with taskkill instead.
 */
export function runSpawnOptions(platform: NodeJS.Platform = process.platform): {
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
  detached: boolean;
} {
  return { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32" };
}

/**
 * Real runner. `npm` is a .cmd shim on Windows, which spawn can only start
 * through cmd.exe. Stdin is closed and git is told never to prompt, so a
 * background fetch can't hang waiting for credentials. On timeout the whole
 * process tree is killed and the promise resolves at once; a late `close` or
 * `error` is ignored.
 */
export const defaultRun: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    const viaCmd = cmd === "npm" && process.platform === "win32";
    const file = viaCmd ? process.env.ComSpec || "cmd.exe" : cmd;
    const argv = viaCmd ? ["/d", "/s", "/c", "npm", ...args] : args;
    const baseEnv = opts.env ?? process.env;
    const env: NodeJS.ProcessEnv =
      cmd === "git"
        ? { ...baseEnv, GIT_TERMINAL_PROMPT: "0", ...(opts.interactiveAuth ? {} : { GCM_INTERACTIVE: "never" }) }
        : baseEnv;
    const child = spawn(file, argv, { cwd: opts.cwd, env, ...runSpawnOptions() });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      defaultKillTree(child as unknown as ChildProcessLike);
      settle({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => settle({ code: -1, stdout, stderr: stderr + err.message }));
    child.on("close", (code) => settle({ code: code ?? -1, stdout, stderr }));
  });

export interface GitFacts {
  isRepo: boolean;
  hasOrigin: boolean;
  repoRoot: string | null;
  /** The checkout's root is the app folder's parent (this repo's layout), so pull/reset act on this app. */
  appInRoot: boolean;
  branch: string | null;
  current: string | null;
  latest: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  /** app/package.json "version" at HEAD and on origin/main (null when unreadable). */
  version: string | null;
  latestVersion: string | null;
  /** CHANGELOG sections for the versions between them ("" when there are none). */
  notes: string;
  fetchError?: string;
}

const NO_FACTS: GitFacts = {
  isRepo: false,
  hasOrigin: false,
  repoRoot: null,
  appInRoot: false,
  branch: null,
  current: null,
  latest: null,
  ahead: 0,
  behind: 0,
  dirty: false,
  commits: [],
  version: null,
  latestVersion: null,
  notes: "",
};

/** Real path (symlinks, junctions, 8.3 names resolved) for comparing folders; case-folded on Windows. */
function canonicalDir(p: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(p);
  } catch {
    real = path.resolve(p);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function isSameDir(a: string, b: string): boolean {
  return canonicalDir(a) === canonicalDir(b);
}

export function parseLeftRight(out: string): { ahead: number; behind: number } {
  const [a, b] = out.trim().split(/\s+/).map(Number);
  return { ahead: Number.isFinite(a) ? a : 0, behind: Number.isFinite(b) ? b : 0 };
}

export function parseCommits(out: string): Array<{ sha: string; subject: string }> {
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      return tab < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    });
}

/** Compare "x.y.z" versions numerically (a leading "v" and any "-pre" suffix are ignored). */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => v.trim().replace(/^v/, "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const NOTES_MAX = 4000;

/**
 * The CHANGELOG sections ("## [0.2.0] - 2026-10-29" or "## 0.2.0") newer
 * than `from`, up to and including `to`, in file order. "## [Unreleased]"
 * and any other non-version heading end a section.
 */
export function releaseNotes(changelog: string, from: string, to: string): string {
  const out: string[] = [];
  let keep = false;
  for (const line of changelog.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      const v = /^##\s+\[?v?(\d+(?:\.\d+)*)/.exec(line)?.[1];
      keep = !!v && compareVersions(v, from) > 0 && compareVersions(v, to) <= 0;
    }
    if (keep) out.push(line);
  }
  const text = out.join("\n").trim();
  if (text.length <= NOTES_MAX) return text;
  // Cut at a line break so the markdown stays well formed.
  const cut = text.lastIndexOf("\n", NOTES_MAX);
  return `${text.slice(0, cut > 0 ? cut : NOTES_MAX).trimEnd()}\n\n…`;
}

/** The "version" field of a package.json text, or null. */
function packageVersion(text: string): string | null {
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export async function readGitFacts(run: Run, appDir: string, opts: { fetch: boolean }): Promise<GitFacts> {
  const git = (...args: string[]) => run("git", args, { cwd: appDir, timeoutMs: 60_000 });
  const top = await git("rev-parse", "--show-toplevel");
  if (top.code !== 0) return NO_FACTS;
  const repoRoot = top.stdout.trim();
  const appInRoot = isSameDir(repoRoot, path.dirname(appDir));
  if ((await git("remote", "get-url", "origin")).code !== 0) return { ...NO_FACTS, isRepo: true, repoRoot, appInRoot };
  let fetchError: string | undefined;
  if (opts.fetch) {
    const f = await git("fetch", "origin", "--quiet");
    if (f.code !== 0) fetchError = f.stderr.trim() || "git fetch failed";
  }
  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || null;
  const head = await git("rev-parse", "HEAD");
  const current = head.code === 0 ? head.stdout.trim() || null : null;
  const latestRes = await git("rev-parse", "origin/main");
  const hasMain = latestRes.code === 0;
  if (!hasMain && !fetchError) fetchError = "origin/main not found";
  const counts = hasMain
    ? parseLeftRight((await git("rev-list", "--left-right", "--count", "HEAD...origin/main")).stdout)
    : { ahead: 0, behind: 0 };
  const porcelain = await git("status", "--porcelain");
  // A failed status is treated as dirty: refusing an update is the safe direction.
  const dirty = porcelain.code !== 0 || porcelain.stdout.trim().length > 0;
  const commits = hasMain ? parseCommits((await git("log", "--format=%h%x09%s", "HEAD..origin/main")).stdout) : [];
  // Versions are read from the app folder, which is the checkout root's child when appInRoot.
  const show = async (rev: string, file: string) => {
    if (!appInRoot) return null;
    const r = await git("show", `${rev}:${path.basename(appDir)}/${file}`);
    return r.code === 0 ? r.stdout : null;
  };
  const version = packageVersion((await show("HEAD", "package.json")) ?? "");
  const latestVersion = hasMain ? packageVersion((await show("origin/main", "package.json")) ?? "") : null;
  const newer = !!version && !!latestVersion && compareVersions(latestVersion, version) > 0;
  const notes = newer ? releaseNotes((await show("origin/main", "CHANGELOG.md")) ?? "", version, latestVersion) : "";
  return {
    isRepo: true,
    hasOrigin: true,
    repoRoot,
    appInRoot,
    branch,
    current,
    latest: hasMain ? latestRes.stdout.trim() : null,
    ...counts,
    dirty,
    commits,
    version,
    latestVersion,
    notes,
    ...(fetchError ? { fetchError } : {}),
  };
}

export function decideCanApply(
  f: GitFacts,
  ctx: { mode: "development" | "production"; busy: boolean; applying: boolean },
): { can_apply: boolean; reason?: string } {
  const no = (reason: string) => ({ can_apply: false, reason });
  if (!f.isRepo) return no("this copy isn't a git checkout");
  // pull and the rollback's reset act on the checkout root: it must be this app's own repo.
  if (!f.appInRoot) return no("the app folder isn't directly inside its git checkout");
  if (!f.hasOrigin) return no("the checkout has no origin remote");
  if (f.latest === null) return no("GitHub's main branch (origin/main) wasn't found");
  if (ctx.mode !== "production") return no("running from source (npm run dev); pull and restart yourself");
  if (f.branch !== "main") return no(`on branch "${f.branch}", not main`);
  if (f.dirty) return no("the checkout has uncommitted changes");
  if (f.ahead > 0) return no(`${f.ahead} local commit${f.ahead === 1 ? " isn't" : "s aren't"} on GitHub`);
  if (f.behind === 0) return no("already up to date");
  if (ctx.applying) return no("an update is already running");
  if (ctx.busy) return no("a job is running; try again when it finishes");
  return { can_apply: true };
}

export interface AppUpdateStatus {
  supported: boolean;
  branch: string | null;
  current: string | null;
  latest: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  /** The installed app version and the one on GitHub's main. */
  version: string | null;
  latest_version: string | null;
  /** main carries a higher version, not just new commits: the client prompts at startup. */
  new_version: boolean;
  /** CHANGELOG sections for the new version(s) (markdown, "" when none). */
  notes: string;
  checked_at: string | null;
  can_apply: boolean;
  reason?: string;
  last_error?: string;
  applying: boolean;
}

export interface ApplyEvent {
  step: "check" | "pull" | "install" | "build" | "restart";
  /** "wait": the new build is ready and the restart is held until running jobs finish. */
  state: "start" | "done" | "skip" | "wait" | "error";
  message?: string;
}

const SUMMARY_MAX = 200;

/**
 * One line for the UI and last_error from a failed command: the first line
 * that looks like an error (a Node crash ends with "Node.js vX", so the last
 * line says nothing), else the first non-empty line; stderr before stdout.
 */
export function summarizeOutput(out: RunResult): string {
  const lines = [out.stderr, out.stdout]
    .flatMap((s) => s.split(/\r?\n/))
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|failed|ERR_/i.test(l)) ?? lines[0];
  if (!line) return `exited with code ${out.code}`;
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** Remove a staging folder; a leftover one is harmless (git ignores it, the next update clears it). */
function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[update] couldn't remove ${dir}: ${(err as Error).message}`);
  }
}

/**
 * Replace dist/ with the staged dist-next/ by renaming, never by copying over
 * the live build (a copy that fails partway would leave dist/ a mix that a
 * git rollback can't repair). Windows refuses to rename a folder holding an
 * open file; then this throws with dist/ untouched and the update rolls back.
 * Cleaning up the staging folders afterwards is best-effort.
 */
export function swapDist(appDir: string): void {
  const dist = path.join(appDir, "dist");
  const next = path.join(appDir, "dist-next");
  const old = path.join(appDir, "dist-old");
  removeQuietly(old);
  try {
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
  } catch (err) {
    throw new Error(
      `couldn't move the current build aside (${(err as Error).message}); a file in app/dist may be in use, try again`,
    );
  }
  try {
    fs.renameSync(next, dist);
  } catch (err) {
    if (fs.existsSync(old) && !fs.existsSync(dist)) fs.renameSync(old, dist);
    throw err;
  }
  removeQuietly(old);
}

/** The environment for npm ci and the build: dev dependencies must be installed and usable. */
function buildEnv(): NodeJS.ProcessEnv {
  const { NODE_ENV: _drop, ...rest } = process.env;
  return rest;
}

export interface AppUpdaterDeps {
  appDir: string;
  mode: "development" | "production";
  isBusy: () => boolean;
  /**
   * Start the new build and stop this process (launcher.ts). Resolves once
   * the successor has spawned; rejects (old server keeps running) if it can't.
   */
  restart: () => void | Promise<void>;
  run?: Run;
  /** How often the hand-over re-checks isBusy() while jobs run (tests shorten it). */
  busyPollMs?: number;
  now?: () => string;
  firstRunDelayMs?: number;
  intervalMs?: number;
}

export interface AppUpdater {
  status(): AppUpdateStatus;
  check(): Promise<AppUpdateStatus>;
  isApplying(): boolean;
  apply(onEvent: (e: ApplyEvent) => void): Promise<boolean>;
  start(): void;
  stop(): void;
}

const FIRST_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

export function createAppUpdater(deps: AppUpdaterDeps): AppUpdater {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? (() => new Date().toISOString());
  let facts: GitFacts | null = null;
  let checkedAt: string | null = null;
  let checkError: string | undefined;
  let applyError: string | undefined;
  let applying = false;
  let inFlight: Promise<AppUpdateStatus> | null = null;
  const timers: NodeJS.Timeout[] = [];

  function status(): AppUpdateStatus {
    if (!facts) {
      return {
        supported: false,
        branch: null,
        current: null,
        latest: null,
        behind: 0,
        ahead: 0,
        dirty: false,
        commits: [],
        version: null,
        latest_version: null,
        new_version: false,
        notes: "",
        checked_at: null,
        can_apply: false,
        reason: "not checked yet",
        ...(checkError ? { last_error: checkError } : {}),
        applying,
      };
    }
    const error = applyError ?? checkError ?? facts.fetchError;
    return {
      supported: facts.isRepo && facts.hasOrigin,
      branch: facts.branch,
      current: short(facts.current),
      latest: short(facts.latest),
      behind: facts.behind,
      ahead: facts.ahead,
      dirty: facts.dirty,
      commits: facts.commits,
      version: facts.version,
      latest_version: facts.latestVersion,
      new_version:
        facts.behind > 0 &&
        !!facts.version &&
        !!facts.latestVersion &&
        compareVersions(facts.latestVersion, facts.version) > 0,
      notes: facts.notes,
      checked_at: checkedAt,
      ...decideCanApply(facts, { mode: deps.mode, busy: deps.isBusy(), applying }),
      ...(error ? { last_error: error } : {}),
      applying,
    };
  }

  function check(): Promise<AppUpdateStatus> {
    if (!inFlight) {
      inFlight = readGitFacts(run, deps.appDir, { fetch: true })
        .then((f) => {
          facts = f;
          checkedAt = now();
          checkError = undefined;
          return status();
        })
        .catch((err) => {
          checkError = `update check failed: ${(err as Error).message}`;
          return status();
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /** Run a scheduled check unless something is busy; true when it ran. */
  const tick = (): boolean => {
    if (applying || deps.isBusy()) return false;
    void check();
    return true;
  };

  /** Full output of a failed command into the server log (--log-file tees it to server.log). */
  const logFailure = (what: string, out: RunResult) => {
    console.error(
      `[update] ${what} failed (exit ${out.code})\n--- stdout ---\n${out.stdout.trimEnd()}\n--- stderr ---\n${out.stderr.trimEnd()}\n---`,
    );
  };

  async function apply(onEvent: (e: ApplyEvent) => void): Promise<boolean> {
    // Claimed before the first await, so a second request can't slip past
    // while this one is still fetching.
    if (applying) {
      onEvent({ step: "check", state: "error", message: "an update is already running" });
      return false;
    }
    applying = true;
    let f: GitFacts;
    try {
      f = await readGitFacts(run, deps.appDir, { fetch: true });
    } catch (err) {
      applying = false;
      onEvent({ step: "check", state: "error", message: `can't read the checkout: ${(err as Error).message}` });
      return false;
    }
    facts = f;
    checkedAt = now();
    const decision = decideCanApply(f, { mode: deps.mode, busy: deps.isBusy(), applying: false });
    if (!decision.can_apply || !f.repoRoot || !f.current) {
      applying = false;
      onEvent({ step: "check", state: "error", message: decision.reason ?? "can't read the checkout" });
      return false;
    }
    applyError = undefined;
    const repo = f.repoRoot;
    const oldSha = f.current;
    console.log(`[update] updating ${short(oldSha)} → ${short(f.latest)} (${f.behind} commit${f.behind === 1 ? "" : "s"})`);
    const env = buildEnv();
    const npmCi = () =>
      run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: deps.appDir, env, timeoutMs: 600_000 });
    let step: ApplyEvent["step"] = "pull";
    const must = async (r: Promise<RunResult>): Promise<RunResult> => {
      const out = await r;
      if (out.code !== 0) {
        logFailure(`${step} step`, out);
        throw new Error(summarizeOutput(out));
      }
      return out;
    };
    const rollbackFailed = (what: string, r: RunResult) => {
      logFailure(`rollback (${what})`, r);
      const msg = `rollback also failed: ${what}: ${summarizeOutput(r)}`;
      applyError = `${applyError}; ${msg}`;
      onEvent({ step, state: "error", message: msg });
    };
    let reinstalled = false;
    try {
      onEvent({ step, state: "start" });
      await must(run("git", ["pull", "--ff-only", "origin", "main"], { cwd: repo, timeoutMs: 120_000 }));
      onEvent({ step, state: "done" });

      step = "install";
      const lockRel = path.relative(repo, path.join(deps.appDir, "package-lock.json")).split(path.sep).join("/");
      const changed = await must(run("git", ["diff", "--name-only", oldSha, "HEAD", "--", lockRel], { cwd: repo }));
      if (changed.stdout.trim()) {
        onEvent({ step, state: "start" });
        reinstalled = true;
        await must(npmCi());
        onEvent({ step, state: "done" });
      } else {
        onEvent({ step, state: "skip", message: "packages unchanged" });
      }

      step = "build";
      onEvent({ step, state: "start" });
      await must(run(process.execPath, ["scripts/build.mjs", "--out", "dist-next"], { cwd: deps.appDir, env, timeoutMs: 600_000 }));
      swapDist(deps.appDir);
      onEvent({ step, state: "done" });
    } catch (err) {
      const message = (err as Error).message;
      applyError = `${step} failed: ${message}`;
      console.error(`[update] ${step} failed: ${message}; rolling back to ${short(oldSha)}`);
      onEvent({ step, state: "error", message });
      try {
        // --keep, not --hard: it refuses (and the failure is reported) rather
        // than discard edits made to tracked files while the update ran.
        const reset = await run("git", ["reset", "--keep", oldSha], { cwd: repo });
        if (reset.code !== 0) rollbackFailed("git reset", reset);
        else if (reinstalled) {
          const again = await npmCi();
          if (again.code !== 0) rollbackFailed("npm ci", again);
        }
      } catch (rbErr) {
        rollbackFailed("rollback", { code: -1, stderr: (rbErr as Error).message, stdout: "" });
      } finally {
        try {
          fs.rmSync(path.join(deps.appDir, "dist-next"), { recursive: true, force: true });
        } catch {
          /* a leftover staging folder is harmless; the next build clears it */
        }
        applying = false;
      }
      return false;
    }
    // Code and build now match the new commit, so a hand-over failure is
    // not rolled back: the next launch starts the new build.
    //
    // Jobs can start while pull/install/build run; the restart would abort
    // them (assistant turns, Notion jobs), so it waits until they finish.
    if (deps.isBusy()) {
      onEvent({ step: "restart", state: "wait", message: "waiting for running jobs to finish" });
      console.log("[update] new build ready; waiting for running jobs before restarting");
      while (deps.isBusy()) await new Promise((r) => setTimeout(r, deps.busyPollMs ?? 1000));
    }
    onEvent({ step: "restart", state: "start" });
    console.log(`[update] built ${short(f.latest)}; handing over to the new server`);
    try {
      await deps.restart();
    } catch (err) {
      const message = (err as Error).message;
      applyError = `restart failed: ${message}`;
      console.error(`[update] ${applyError}`);
      onEvent({ step: "restart", state: "error", message });
      applying = false;
      return false;
    }
    return true;
  }

  return {
    status,
    check,
    apply,
    isApplying: () => applying,
    start() {
      const delay = deps.firstRunDelayMs ?? FIRST_CHECK_DELAY_MS;
      // The startup check retries while a job runs rather than waiting out
      // the 6-hour cadence: the startup new-version prompt depends on it.
      const later = (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        timers.push(t);
      };
      const first = () => {
        if (!tick()) later(first, delay);
      };
      later(first, delay);
      const every = setInterval(tick, deps.intervalMs ?? CHECK_INTERVAL_MS);
      every.unref?.();
      timers.push(every);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
