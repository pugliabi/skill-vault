/**
 * Headless Claude Code CLI runner.
 *
 * Claude only ever runs via the local `claude` CLI in a fully non-interactive,
 * no-tools, no-session mode — never `--bare` (that breaks subscription auth).
 * The lean flag set keeps each call cheap (no full environment/session
 * load) and deterministic: `--strict-mcp-config` + `--setting-sources ""`
 * so nothing from the user's own Claude Code config leaks in, `--tools ""`
 * so the model can't call anything, `--no-session-persistence` so nothing
 * is written to disk, and `--json-schema` to force a shape we can trust.
 *
 * On Windows `claude` resolves to a `.cmd` shim; the default runner resolves
 * that shim to the real `claude.exe` it wraps and spawns it directly, with
 * no shell involved (see the comment further down for why — the short
 * version: a multi-line system prompt cannot survive cmd.exe's argument
 * parsing at all, quoted or not).
 *
 * The actual `spawn` call and the timeout kill are both injectable
 * (`SpawnFn` / `KillTreeFn`, via `createRunner` / `createKillTree`) so the
 * process-tree-kill-on-timeout behaviour can be unit-tested with a fake
 * child instead of a real OS process.
 */
import { spawn as nodeSpawn, spawnSync, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ClaudeRunner = (
  args: string[],
  stdin: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    /** Aborting kills the whole process tree and rejects, like a timeout. */
    signal?: AbortSignal;
  },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

/** Thrown when the CLI reports `is_error`, its output can't be trusted, or it can't be launched at all. */
export class ClaudeError extends Error {}

/** The minimal shape of a spawned child our runner needs — real `ChildProcess` satisfies this, a test fake only needs this much. */
export interface ChildProcessLike {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    /** Real streams emit "error" (e.g. EPIPE when the child exits before reading stdin). */
    on?(event: "error", listener: (err: Error) => void): unknown;
  } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcessLike;
/** Kills a spawned child AND its whole process tree (not just the one pid). */
export type KillTreeFn = (child: ChildProcessLike) => void;

// ── Windows: resolving the real claude.exe behind the .cmd shim ──────────
//
// On Windows, `claude` resolves to a `.cmd` shim, which `spawn` can only
// launch through a shell. That's fine for short single-line args, but our
// system prompt is multi-line free text — and cmd.exe fundamentally can't
// carry a literal newline inside one argument of a `/c "..."` invocation:
// it treats the newline as a statement separator no matter how the
// argument was quoted, silently truncating everything after the first
// line. A `.cmd` shim makes this worse, not better: it forwards its
// arguments to the real binary via `%*`, which cmd.exe re-lexes a *second*
// time, so even the caret-before-newline continuation trick (which works
// for one level of cmd.exe parsing) gets undone by the shim's own
// forwarding line.
//
// The reliable fix is to skip the shim and cmd.exe entirely: resolve the
// `.cmd` shim to the real `claude.exe` it wraps and spawn that directly.
// A plain `.exe` needs no shell — Windows' native CreateProcess argument
// passing (which is what `spawn` uses without `shell`) has no line-based
// parsing at all, so embedded newlines, quotes, `%`, `&`, etc. all survive
// untouched. This was verified against the real CLI (see task-3-report.md).
//
// If the real exe can't be found (unusual install layout), we refuse to
// launch any call whose args contain a newline at all, rather than
// silently truncating the system prompt via the cmd.exe fallback.

/**
 * Pure: given a `.cmd` shim's file text and the directory it lives in,
 * extract the real `.exe` path it wraps. The standard npm-on-Windows shim
 * template ends with a quoted path to a `.exe`, using `%dp0%`/`%~dp0%` for
 * its own directory (e.g. `"%dp0%\node_modules\...\claude.exe"   %*`).
 * Returns null when the shim text doesn't match that shape. No filesystem
 * access here — this is pure text-in, path-out, so it's trivially
 * unit-testable without touching disk.
 */
export function parseClaudeCmdShim(shimContent: string, shimDir: string): string | null {
  const match = shimContent.match(/"([^"]*\.exe)"/i);
  if (!match) return null;
  return path.resolve(match[1].replace(/%~?dp0%?/gi, shimDir + path.sep));
}

let resolvedExeCache: string | null | undefined;

/**
 * Best-effort: find the `claude` command on PATH and, if it's a `.cmd`
 * shim, resolve it to the real executable via `parseClaudeCmdShim`. Cached
 * for the process lifetime — call `resetResolvedExeCache` in tests.
 */
function resolveClaudeExe(): string | null {
  if (resolvedExeCache !== undefined) return resolvedExeCache;

  let result: string | null = null;
  try {
    const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const exeCandidate = path.join(dir, "claude.exe");
      if (fsSync.existsSync(exeCandidate)) {
        result = exeCandidate;
        break;
      }
      const cmdCandidate = path.join(dir, "claude.cmd");
      if (fsSync.existsSync(cmdCandidate)) {
        const content = fsSync.readFileSync(cmdCandidate, "utf-8");
        const parsed = parseClaudeCmdShim(content, dir);
        if (parsed && fsSync.existsSync(parsed)) result = parsed;
        break;
      }
    }
  } catch {
    result = null;
  }

  resolvedExeCache = result;
  return result;
}

/** Test-only: clears the resolved-`claude.exe` cache so tests don't leak state into each other. */
export function resetResolvedExeCache(): void {
  resolvedExeCache = undefined;
}

// ── cmd.exe fallback quoting (only used when claude.exe can't be resolved) ──

const CMD_META_CHARS_RE = /([()[\]%!^"`<>&|;, *?])/g;

/** No quoting — just meta-char escaping — for the command name itself. */
function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS_RE, "^$1");
}

/** Quotes and escapes one argument so cmd.exe passes it through verbatim. */
function escapeCmdArg(arg: string): string {
  let a = String(arg);
  // A run of backslashes right before a double quote (or the end of the
  // string, where a closing quote will be appended next) must be doubled,
  // and the quote itself backslash-escaped.
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(CMD_META_CHARS_RE, "^$1");
  return a;
}

/**
 * Builds the `{ command, args }` to hand to `spawn` (with
 * `windowsVerbatimArguments: true`) to run `file args...` correctly through
 * `cmd.exe`. Exported so the quoting itself can be unit-tested without
 * spawning any process. Only used as a fallback when `claude.exe` can't be
 * resolved, and even then never for an argument containing a newline (see
 * `buildSpawnInvocation`) — cmd.exe cannot carry one correctly regardless
 * of quoting.
 */
export function buildWindowsShellInvocation(file: string, args: string[]): { command: string; args: string[] } {
  const shellCommand = [escapeCmdCommand(file), ...args.map(escapeCmdArg)].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
  };
}

interface SpawnInvocation {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * Decides exactly how to invoke `claude args...`. Throws `ClaudeError`
 * (never spawns anything) when running on Windows, the real `claude.exe`
 * can't be resolved, AND an argument contains a newline — the one case
 * with no safe way to launch at all (see the module comment).
 */
function buildSpawnInvocation(
  args: string[],
  cwd: string,
  resolveExe: () => string | null,
  platform: NodeJS.Platform,
): SpawnInvocation {
  if (platform !== "win32") {
    // `detached: true` makes the child the leader of its own process
    // group, so a timeout can kill the whole tree via `process.kill(-pid, …)`.
    return { command: "claude", args, options: { cwd, detached: true } };
  }

  const resolvedExe = resolveExe();
  if (resolvedExe) {
    // A real .exe: no shell, no cmd.exe line parsing, plain argv — safe
    // for multi-line prompts, quotes, and every other special character.
    return { command: resolvedExe, args, options: { cwd } };
  }

  if (args.some((a) => a.includes("\n"))) {
    throw new ClaudeError(
      "Claude CLI could not be launched safely on this system (claude.exe not found next to the claude.cmd shim)",
    );
  }

  const shellInvocation = buildWindowsShellInvocation("claude", args);
  return {
    command: shellInvocation.command,
    args: shellInvocation.args,
    options: { cwd, windowsVerbatimArguments: true },
  };
}

// ── Kill-on-timeout: the whole process tree, not just the one pid ────────

/**
 * Builds a `KillTreeFn`. The low-level primitives (`taskkill` on Windows,
 * killing the process group everywhere else) are themselves injectable so
 * tests can assert exactly how a kill was attempted without touching a
 * real OS process.
 */
export function createKillTree(
  deps: {
    platform?: NodeJS.Platform;
    /** Windows: kill pid's whole tree. Default: `taskkill /pid <pid> /T /F`, spawned without a shell. */
    taskkill?: (pid: number) => void;
    /** Everywhere else: kill pid's whole process group. Default: `process.kill(-pid, "SIGKILL")`. */
    killGroup?: (pid: number) => void;
  } = {},
): KillTreeFn {
  const platform = deps.platform ?? process.platform;
  const taskkill =
    deps.taskkill ??
    ((pid: number) => {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    });
  const killGroup =
    deps.killGroup ??
    ((pid: number) => {
      process.kill(-pid, "SIGKILL");
    });

  return (child: ChildProcessLike) => {
    if (platform === "win32") {
      if (typeof child.pid === "number") {
        taskkill(child.pid);
      } else {
        child.kill();
      }
      return;
    }

    if (typeof child.pid === "number") {
      try {
        killGroup(child.pid);
        return;
      } catch {
        // Not a group leader (or already dead) — fall back to killing just the child.
      }
    }
    child.kill("SIGKILL");
  };
}

/** Default tree-kill: real `taskkill`/`process.kill`. Never used in tests. */
export const defaultKillTree: KillTreeFn = createKillTree();

const realSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options) as unknown as ChildProcessLike;

/**
 * Builds a `ClaudeRunner` from an injectable `spawn` and tree-kill. The
 * promise always settles exactly once: on `close` it resolves with
 * stdout/stderr/code; on `error` or a timeout it rejects (a timeout kills
 * the whole process tree first via `killTreeFn`, then rejects immediately
 * — it never waits for a `close` that a broken kill might not produce).
 */
export function createRunner(
  spawnFn: SpawnFn,
  killTreeFn: KillTreeFn,
  deps: { resolveExe?: () => string | null; platform?: NodeJS.Platform } = {},
): ClaudeRunner {
  const resolveExe = deps.resolveExe ?? resolveClaudeExe;
  const platform = deps.platform ?? process.platform;

  return (args, stdin, opts) => {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new ClaudeError("claude CLI call aborted"));
        return;
      }
      let invocation: SpawnInvocation;
      try {
        invocation = buildSpawnInvocation(args, opts.cwd, resolveExe, platform);
      } catch (err) {
        reject(err);
        return;
      }

      const child = spawnFn(invocation.command, invocation.args, invocation.options);

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settleResolve = (value: { stdout: string; stderr: string; code: number | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      };
      const onAbort = () => {
        if (settled) return;
        killTreeFn(child);
        settleReject(new ClaudeError("claude CLI call aborted"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        killTreeFn(child);
        settleReject(new ClaudeError(`claude CLI timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
      }, opts.timeoutMs);

      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => settleReject(err));
      child.on("close", (code) => settleResolve({ stdout, stderr, code }));
      // A child that exits before reading its prompt makes stdin emit EPIPE;
      // without a listener that would be an uncaught exception. The promise
      // still settles via "close" (or "error"/timeout), so just note it.
      child.stdin?.on?.("error", (err) => {
        stderr += `${stderr ? "\n" : ""}[stdin] ${err.message}`;
      });

      child.stdin?.write(stdin);
      child.stdin?.end();
    });
  };
}

/** Default runner: spawns the real `claude` binary. Never used in tests. */
export const defaultRunner: ClaudeRunner = createRunner(realSpawn, defaultKillTree);

let availabilityCache: { at: number; value: { available: boolean; version?: string; reason?: string } } | null = null;
const AVAILABILITY_CACHE_MS = 60_000;

/**
 * Is the `claude` CLI usable from here? Cheap and cached for 60 s so the UI
 * can poll it without spawning a process on every render.
 *
 * On Windows this requires the real `claude.exe` to be resolvable (not just
 * the `.cmd` shim) — the cmd.exe fallback can't run every call safely (see
 * `buildSpawnInvocation`), so the UI should treat Claude as unavailable
 * rather than let a merge fail later with a confusing launch error.
 */
export async function claudeAvailable(
  runner: ClaudeRunner = defaultRunner,
  deps: { resolveExe?: () => string | null; platform?: NodeJS.Platform } = {},
): Promise<{ available: boolean; version?: string; reason?: string }> {
  const now = Date.now();
  if (availabilityCache && now - availabilityCache.at < AVAILABILITY_CACHE_MS) {
    return availabilityCache.value;
  }

  const resolveExe = deps.resolveExe ?? resolveClaudeExe;
  const platform = deps.platform ?? process.platform;

  let value: { available: boolean; version?: string; reason?: string };
  if (platform === "win32" && !resolveExe()) {
    value = { available: false, reason: "claude.exe not found next to the claude.cmd shim" };
  } else {
    try {
      const { stdout, code } = await runner(["--version"], "", { cwd: os.tmpdir(), timeoutMs: 10_000 });
      value =
        code === 0 && stdout.trim()
          ? { available: true, version: stdout.trim() }
          : { available: false, reason: "claude --version failed" };
    } catch (err) {
      value = { available: false, reason: err instanceof Error ? err.message : "claude --version failed" };
    }
  }

  availabilityCache = { at: now, value };
  return value;
}

/** Test-only: clears the 60 s availability cache so tests don't leak state into each other. */
export function resetClaudeAvailableCache(): void {
  availabilityCache = null;
}

interface ClaudeCliJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

/**
 * Default CLI timeout: 180 s per the sync spec. Callers can pass a longer
 * one — the hunk-based merge uses 600 s (merge.ts MERGE_TIMEOUT_MS).
 */
export const RUN_TIMEOUT_MS = 180_000;

/**
 * Run one headless, structured-output Claude call: the prompt goes on
 * stdin, `schema` becomes `--json-schema`, and the CLI's `structured_output`
 * field is parsed out and returned as `T`. Throws `ClaudeError` when the
 * CLI reports an error or doesn't return usable structured output.
 */
export async function runClaudeJson<T>(
  prompt: string,
  systemPrompt: string,
  schema: object,
  runner: ClaudeRunner = defaultRunner,
  opts: {
    timeoutMs?: number;
    /** `--model` alias or id; omitted → the CLI's default model. */
    model?: string;
    /** Abort → the CLI's process tree is killed and this rejects. */
    signal?: AbortSignal;
  } = {},
): Promise<{ output: T; costUsd?: number }> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--system-prompt",
    systemPrompt,
    "--json-schema",
    JSON.stringify(schema),
    ...(opts.model ? ["--model", opts.model] : []),
  ];

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-vault-claude-"));
  try {
    const { stdout, stderr } = await runner(args, prompt, {
      cwd,
      timeoutMs: opts.timeoutMs ?? RUN_TIMEOUT_MS,
      signal: opts.signal,
    });

    let parsed: ClaudeCliJson;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new ClaudeError(
        `claude CLI returned non-JSON output${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      );
    }

    if (parsed.is_error) {
      throw new ClaudeError(
        typeof parsed.result === "string" && parsed.result
          ? parsed.result
          : "claude CLI reported an error",
      );
    }
    if (parsed.structured_output === undefined || parsed.structured_output === null) {
      throw new ClaudeError("claude CLI did not return structured_output");
    }

    return {
      output: parsed.structured_output as T,
      costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined,
    };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
