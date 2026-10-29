/**
 * Where the bridge finds the app server when the app didn't launch it
 * (Claude Desktop, Claude Code, the shared `skill-vault` command):
 *
 * 1. ~/.skill-vault/app.lock names the running server, and GET /api/health
 *    must answer with the same pid.
 * 2. Otherwise, on Windows, start it hidden through scripts/launch.ps1
 *    -Headless (the Start Menu launch's mutex, stale-lock cleanup and
 *    rebuild step, without the window) and wait up to 60 s.
 *
 * Everything that touches the OS comes in through ServerDeps so tests can
 * drive the timing.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readLock, type InstanceLock } from "../services/instanceLock.ts";

export interface ServerDeps {
  readLock: () => InstanceLock | null;
  health: (port: number) => Promise<{ ok?: boolean; pid?: number } | null>;
  startHeadless: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  platform: NodeJS.Platform;
}

export const START_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

export class ServerUnavailableError extends Error {}

async function liveUrl(deps: ServerDeps): Promise<string | null> {
  const lock = deps.readLock();
  if (!lock) return null;
  const h = await deps.health(lock.port);
  return h?.ok && h.pid === lock.pid ? `http://127.0.0.1:${lock.port}` : null;
}

export async function findOrStartServer(deps: ServerDeps): Promise<string> {
  const live = await liveUrl(deps);
  if (live) return live;
  if (deps.platform !== "win32") {
    throw new ServerUnavailableError("Skill Vault isn't running. Open Skill Vault, then retry.");
  }
  deps.startHeadless();
  const deadline = deps.now() + START_TIMEOUT_MS;
  for (;;) {
    await deps.sleep(POLL_MS);
    const url = await liveUrl(deps);
    if (url) return url;
    if (deps.now() >= deadline) {
      const log = path.join(os.homedir(), ".skill-vault", "logs", "launch.log");
      throw new ServerUnavailableError(`Skill Vault didn't start within ${START_TIMEOUT_MS / 1000} seconds. See ${log}.`);
    }
  }
}

export function realServerDeps(appDir: string): ServerDeps {
  return {
    readLock,
    health: async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2_000) });
        return res.ok ? ((await res.json()) as { ok?: boolean; pid?: number }) : null;
      } catch {
        return null;
      }
    },
    startHeadless: () => {
      const script = path.join(appDir, "scripts", "launch.ps1");
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-Headless"],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.on("error", () => {
        /* reported by the 60 s wait instead */
      });
      child.unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    platform: process.platform,
  };
}

const isRefused = (err: unknown): boolean => (err as { cause?: { code?: string } })?.cause?.code === "ECONNREFUSED";

/**
 * A fetch over paths ("/api/...") that finds the server on first use and
 * caches it. A refused connection (the server idled out, or moved ports)
 * forgets it and finds it again, once. Use with createHttp("", ...).
 */
export function createResolvingFetch(resolve: () => Promise<string>, fetchFn: typeof fetch = fetch): typeof fetch {
  let base: string | null = null;
  let pending: Promise<string> | null = null;
  // Single-flight: parallel first calls share one search/start.
  const baseUrl = (): Promise<string> => {
    if (base) return Promise.resolve(base);
    pending ??= resolve()
      .then((b) => (base = b))
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      const used = await baseUrl();
      try {
        return await fetchFn(`${used}${String(input)}`, init);
      } catch (err) {
        if (!isRefused(err)) throw err;
        if (base === used) base = null;
        if (attempt >= 1) throw err;
      }
    }
  }) as typeof fetch;
}
