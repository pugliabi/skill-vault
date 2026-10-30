/**
 * The sign-in window: a visible PowerShell console running the engine's own
 * login command (`claude auth login`, `codex login`, `copilot login`,
 * `grok login`), so each tool handles its own browser or device-code step
 * the way it expects to — Copilot's device code needs a real terminal.
 * The command is built only from the resolved executable and the engine's
 * fixed args, and the window exits with the login command's exit code (on a
 * failure it waits for Enter first, so the error stays readable). One window
 * at a time; the app closes it on success (GET /engines/:id sees signed_in),
 * on Cancel, or after 10 minutes. When the provider already read as signed in
 * at start ("Sign in again"), signed_in proves nothing: only the window's
 * exit code 0 counts, and the app never closes that window early.
 */
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, type SpawnTarget } from "./exe.ts";
import type { AssistantEngine, EngineId } from "./types.ts";

export const SIGN_IN_TIMEOUT_MS = 600_000;

// PowerShell treats U+2018-U+201B like an ASCII quote, so double those too.
const psQuote = (s: string): string => `'${s.replace(/['‘-‛]/g, "$&$&")}'`;

/**
 * The window's whole script. `$LASTEXITCODE` is $null when the command never ran, which must not read
 * as success; a failure pauses on Read-Host so the user can read the error before the window closes.
 */
export function powershellLoginCommand(title: string, target: SpawnTarget, args: string[]): string {
  return [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    `& ${[target.command, ...target.prefixArgs, ...args].map(psQuote).join(" ")}`,
    "$code = if ($null -eq $LASTEXITCODE) { 1 } else { $LASTEXITCODE }",
    'if ($code -ne 0) { Read-Host "Sign-in did not finish (exit code $code). Press Enter to close this window" | Out-Null }',
    "exit $code",
  ].join("; ");
}

export interface SignInWindow {
  close(): void;
  isOpen(): boolean;
  /** The window's exit code once it exited on its own; null while open, or after the app closed it. */
  exitCode?(): number | null;
}

export interface SignInDeps {
  platform: NodeJS.Platform;
  /** Opens the window, or says why it couldn't. */
  openWindow(title: string, command: string, env: NodeJS.ProcessEnv): SignInWindow | { error: string };
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

/** Why start() refused: the route answers 409 for the first two and 500 for a window that didn't open. */
export type SignInRefusal = { error: string; reason: "unsupported" | "not_installed" | "spawn_failed" };

/** The latest sign-in window for one engine, as GET /engines/:id reports it. */
export interface SignInWindowState {
  open: boolean;
  /** Set once the window exited on its own: 0 = the login command succeeded. */
  exit_code: number | null;
  /** The provider read as signed in when this sign-in started, so only exit_code 0 means success. */
  already_signed_in: boolean;
}

export interface SignInManager {
  pending(): boolean;
  current(): EngineId | null;
  start(engine: AssistantEngine, env: NodeJS.ProcessEnv, opts?: { alreadySignedIn?: boolean }): { started: true } | SignInRefusal;
  /** Close the window of a sign-in that just succeeded. Never closes a window started already signed in. */
  finish(id: EngineId): void;
  cancel(): void;
  /** The latest sign-in for `id` (open, or exited on its own), until the next start or cancel. */
  state(id: EngineId): SignInWindowState | null;
}

function powershellExe(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return root ? path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

function defaultOpenWindow(_title: string, command: string, env: NodeJS.ProcessEnv): SignInWindow | { error: string } {
  let child: ChildProcess;
  try {
    // detached on Windows = the child gets its own (visible) console window.
    child = spawn(powershellExe(), ["-NoProfile", "-Command", command], {
      detached: true,
      windowsHide: false,
      stdio: "ignore",
      env,
    });
  } catch (err) {
    return { error: `Couldn't open the sign-in window: ${(err as Error).message}` };
  }
  // A launch that failed (powershell.exe missing or blocked) has no pid; its "error" event follows a tick later.
  child.on("error", () => {});
  if (typeof child.pid !== "number") return { error: "Couldn't open the sign-in window: powershell.exe didn't start." };
  child.unref();
  // Once the window is gone its PID may be reused: never kill after exit.
  let alive = true;
  let killed = false;
  let code: number | null = null;
  child.once("exit", (c) => {
    alive = false;
    code = typeof c === "number" ? c : null;
  });
  return {
    isOpen: () => alive,
    exitCode: () => (alive || killed ? null : code),
    close: () => {
      if (alive) {
        killed = true;
        killProcessTree(child.pid);
      }
      alive = false;
    },
  };
}

export function createSignInManager(over: Partial<SignInDeps> = {}): SignInManager {
  const deps: SignInDeps = {
    platform: over.platform ?? process.platform,
    openWindow: over.openWindow ?? defaultOpenWindow,
    setTimer:
      over.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return { cancel: () => clearTimeout(t) };
      }),
  };
  // Kept after the window exits on its own, so its exit code can still be read.
  let run: { id: EngineId; win: SignInWindow; timer: { cancel(): void }; alreadySignedIn: boolean } | null = null;

  /** True while the window is open. A window the user closed is finished: its timer stops, nothing is killed. */
  const open = (): boolean => {
    if (!run) return false;
    if (run.win.isOpen()) return true;
    run.timer.cancel();
    return false;
  };

  const close = (): void => {
    if (!run) return;
    run.timer.cancel();
    if (run.win.isOpen()) run.win.close();
    run = null;
  };

  return {
    pending: open,
    current: () => (open() ? (run?.id ?? null) : null),
    start(engine, env, opts = {}) {
      if (deps.platform !== "win32") {
        const command = `${engine.cliName} ${engine.loginArgs.join(" ")}`.trim();
        return { error: `Sign-in from the app is Windows only. Run "${command}" in a terminal.`, reason: "unsupported" };
      }
      const target = engine.target();
      if (!target) return { error: `${engine.label} isn't installed — install it first.`, reason: "not_installed" };
      close();
      const title = `Sign in to ${engine.label}`;
      const win = deps.openWindow(title, powershellLoginCommand(title, target, engine.loginArgs), env);
      if ("error" in win) return { error: win.error, reason: "spawn_failed" };
      const timer = deps.setTimer(close, SIGN_IN_TIMEOUT_MS);
      run = { id: engine.id, win, timer, alreadySignedIn: opts.alreadySignedIn === true };
      return { started: true };
    },
    finish(id) {
      if (run?.id === id && !run.alreadySignedIn) close();
    },
    cancel: close,
    state(id) {
      if (run?.id !== id) return null;
      const isOpen = open();
      return { open: isOpen, exit_code: isOpen ? null : (run.win.exitCode?.() ?? null), already_signed_in: run.alreadySignedIn };
    },
  };
}
