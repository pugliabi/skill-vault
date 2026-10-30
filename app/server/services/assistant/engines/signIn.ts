/**
 * The sign-in window: a visible PowerShell console running the engine's own
 * login command (`claude auth login`, `codex login`, `copilot login`,
 * `grok login`), so each tool handles its own browser or device-code step
 * the way it expects to — Copilot's device code needs a real terminal.
 * The command is built only from the resolved executable and the engine's
 * fixed args. One window at a time; it closes on success (GET /engines/:id
 * sees signed_in), on Cancel, or after 10 minutes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree, type SpawnTarget } from "./exe.ts";
import type { AssistantEngine, EngineId } from "./types.ts";

export const SIGN_IN_TIMEOUT_MS = 600_000;

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function powershellLoginCommand(title: string, target: SpawnTarget, args: string[]): string {
  return `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}; & ${[target.command, ...target.prefixArgs, ...args].map(psQuote).join(" ")}`;
}

export interface SignInDeps {
  platform: NodeJS.Platform;
  /** Opens the window, or says why it couldn't. */
  openWindow(title: string, command: string, env: NodeJS.ProcessEnv): { close(): void } | { error: string };
  setTimer(fn: () => void, ms: number): { cancel(): void };
}

/** Why start() refused: the route answers 409 for the first two and 500 for a window that didn't open. */
export type SignInRefusal = { error: string; reason: "unsupported" | "not_installed" | "spawn_failed" };

export interface SignInManager {
  pending(): boolean;
  current(): EngineId | null;
  start(engine: AssistantEngine, env: NodeJS.ProcessEnv): { started: true } | SignInRefusal;
  finish(id: EngineId): void;
  cancel(): void;
}

function defaultOpenWindow(_title: string, command: string, env: NodeJS.ProcessEnv): { close(): void } | { error: string } {
  let child: ChildProcess;
  try {
    // detached on Windows = the child gets its own (visible) console window.
    child = spawn("powershell.exe", ["-NoProfile", "-NoExit", "-Command", command], {
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
  return { close: () => killProcessTree(child.pid) };
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
  let current: { id: EngineId; close(): void; timer: { cancel(): void } } | null = null;

  const close = (): void => {
    if (!current) return;
    current.timer.cancel();
    current.close();
    current = null;
  };

  return {
    pending: () => current !== null,
    current: () => current?.id ?? null,
    start(engine, env) {
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
      current = { id: engine.id, close: win.close, timer };
      return { started: true };
    },
    finish(id) {
      if (current?.id === id) close();
    },
    cancel: close,
  };
}
