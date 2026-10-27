/**
 * In-app updates for a git-cloned install (design: docs/superpowers/specs/
 * 2026-10-27-install-and-launch-design.md §5).
 *
 * Check: `git fetch origin` 30 s after start and every 6 h, then compare
 * HEAD with origin/main. Apply (below): pull --ff-only → `npm ci` only when
 * package-lock.json changed → build into dist-next/ and swap it into dist/
 * → hand over to a fresh server (deps.restart). Any failure before the
 * hand-over resets the checkout to the old commit (safe: a clean tree is
 * required) and the running server keeps serving its build.
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
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<RunResult>;

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
      cmd === "git" ? { ...baseEnv, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } : baseEnv;
    const child = spawn(file, argv, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  branch: string | null;
  current: string | null;
  latest: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  commits: Array<{ sha: string; subject: string }>;
  fetchError?: string;
}

const NO_FACTS: GitFacts = {
  isRepo: false,
  hasOrigin: false,
  repoRoot: null,
  branch: null,
  current: null,
  latest: null,
  ahead: 0,
  behind: 0,
  dirty: false,
  commits: [],
};

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

export async function readGitFacts(run: Run, appDir: string, opts: { fetch: boolean }): Promise<GitFacts> {
  const git = (...args: string[]) => run("git", args, { cwd: appDir, timeoutMs: 60_000 });
  const top = await git("rev-parse", "--show-toplevel");
  if (top.code !== 0) return NO_FACTS;
  const repoRoot = top.stdout.trim();
  if ((await git("remote", "get-url", "origin")).code !== 0) return { ...NO_FACTS, isRepo: true, repoRoot };
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
  return {
    isRepo: true,
    hasOrigin: true,
    repoRoot,
    branch,
    current,
    latest: hasMain ? latestRes.stdout.trim() : null,
    ...counts,
    dirty,
    commits,
    ...(fetchError ? { fetchError } : {}),
  };
}

export function decideCanApply(
  f: GitFacts,
  ctx: { mode: "development" | "production"; busy: boolean; applying: boolean },
): { can_apply: boolean; reason?: string } {
  const no = (reason: string) => ({ can_apply: false, reason });
  if (!f.isRepo) return no("this copy isn't a git checkout");
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
  checked_at: string | null;
  can_apply: boolean;
  reason?: string;
  last_error?: string;
  applying: boolean;
}

export interface ApplyEvent {
  step: "check" | "pull" | "install" | "build" | "restart";
  state: "start" | "done" | "skip" | "error";
  message?: string;
}

/**
 * Replace dist/ with the staged dist-next/. Windows can refuse to rename a
 * folder holding an open file; then copy over it instead.
 */
export function swapDist(appDir: string): void {
  const dist = path.join(appDir, "dist");
  const next = path.join(appDir, "dist-next");
  const old = path.join(appDir, "dist-old");
  fs.rmSync(old, { recursive: true, force: true });
  try {
    if (fs.existsSync(dist)) fs.renameSync(dist, old);
  } catch {
    fs.cpSync(next, dist, { recursive: true, force: true });
    fs.rmSync(next, { recursive: true, force: true });
    return;
  }
  try {
    fs.renameSync(next, dist);
  } catch (err) {
    if (fs.existsSync(old) && !fs.existsSync(dist)) fs.renameSync(old, dist);
    throw err;
  }
  fs.rmSync(old, { recursive: true, force: true });
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
  /** Start the new build and stop this process (launcher.ts). */
  restart: () => void;
  run?: Run;
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

const FIRST_CHECK_DELAY_MS = 30_000;
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

  const tick = () => {
    if (!applying && !deps.isBusy()) void check();
  };

  async function apply(onEvent: (e: ApplyEvent) => void): Promise<boolean> {
    const f = await readGitFacts(run, deps.appDir, { fetch: true });
    facts = f;
    checkedAt = now();
    const decision = decideCanApply(f, { mode: deps.mode, busy: deps.isBusy(), applying });
    if (!decision.can_apply || !f.repoRoot || !f.current) {
      onEvent({ step: "check", state: "error", message: decision.reason ?? "can't read the checkout" });
      return false;
    }
    applying = true;
    applyError = undefined;
    const repo = f.repoRoot;
    const oldSha = f.current;
    const env = buildEnv();
    const npmCi = () =>
      run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: deps.appDir, env, timeoutMs: 600_000 });
    const must = async (r: Promise<RunResult>): Promise<RunResult> => {
      const out = await r;
      if (out.code !== 0) {
        const tail = (out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ");
        throw new Error(tail || `exited with code ${out.code}`);
      }
      return out;
    };
    let step: ApplyEvent["step"] = "pull";
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
      onEvent({ step, state: "error", message });
      await run("git", ["reset", "--hard", oldSha], { cwd: repo });
      if (reinstalled) await npmCi();
      fs.rmSync(path.join(deps.appDir, "dist-next"), { recursive: true, force: true });
      applying = false;
      return false;
    }
    // Code and build now match the new commit, so a hand-over failure is
    // not rolled back: the next launch starts the new build.
    onEvent({ step: "restart", state: "start" });
    deps.restart();
    return true;
  }

  return {
    status,
    check,
    apply,
    isApplying: () => applying,
    start() {
      const first = setTimeout(tick, deps.firstRunDelayMs ?? FIRST_CHECK_DELAY_MS);
      const every = setInterval(tick, deps.intervalMs ?? CHECK_INTERVAL_MS);
      first.unref?.();
      every.unref?.();
      timers.push(first, every);
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    },
  };
}
