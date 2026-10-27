/**
 * CLI launcher: `npx skill-vault-app`, `npm run dev`, or a direct
 * `tsx server/launcher.ts` invocation.
 *
 * Responsibilities:
 *   1. Load `.env` (if present) so the user can persist port/host
 *      without touching their shell profile
 *   2. Parse CLI flags (--port, --host, --no-open, --help)
 *   3. Read the CLI's `~/.skill-vault/config.json` `app` block as the
 *      next fallback, so a user who customized `sv app --port 5050`
 *      back when `sv app` existed still gets the same port here
 *   4. Pick a free port in case the preferred one is busy
 *   5. Bind, optionally open the browser, forward Ctrl+C to shutdown
 *
 * Precedence (highest wins):
 *
 *     CLI flag
 *   → process.env (set on the shell invocation)
 *   → .env file in this directory (loaded by dotenv)
 *   → `app` block in ~/.skill-vault/config.json
 *   → built-in default (port 9994, host 127.0.0.1, open browser on)
 *
 * Note: steps 2 and 3 look at the SAME variables (PORT, HOST,
 * OPEN_BROWSER). `.env` just seeds process.env before we read it.
 */

import "dotenv/config";

import type { Server } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import { createApp } from "./index.ts";
import { readCliAppBlock } from "./services/appConfig.ts";
import { acquireLock, buildVersion, readLock, releaseLock } from "./services/instanceLock.ts";
import { sseClientCount } from "./routes/events.ts";
import { startIdleStop } from "./services/idleStop.ts";
import { installLogFile } from "./services/logFile.ts";
import { isPortFree } from "./services/portProbe.ts";
import { getServerPort, setServerPort } from "./services/runtime.ts";

// ── CLI argument parsing ───────────────────────────────────────

interface ParsedArgs {
  port?: number;
  host?: string;
  noOpen?: boolean;
  help?: boolean;
  logFile?: string;
  exitWhenIdle?: boolean;
  strictPort?: boolean;
}

/**
 * Tiny argv parser — no dependency on minimist/yargs. Supports:
 *   -p 5500         --port 5500          --port=5500
 *   -h 0.0.0.0      --host 0.0.0.0       --host=0.0.0.0
 *   --no-open       --help
 *
 * Anything unrecognized is silently ignored so that `npm run dev --
 * --port 5500` works even when npm injects extra tokens.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") {
      const n = Number(argv[++i]);
      if (!Number.isNaN(n)) out.port = n;
    } else if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (!Number.isNaN(n)) out.port = n;
    } else if (a === "--host" || a === "-h") {
      out.host = argv[++i];
    } else if (a.startsWith("--host=")) {
      out.host = a.slice("--host=".length);
    } else if (a === "--log-file") {
      out.logFile = argv[++i];
    } else if (a.startsWith("--log-file=")) {
      out.logFile = a.slice("--log-file=".length);
    } else if (a === "--exit-when-idle") {
      out.exitWhenIdle = true;
    } else if (a === "--strict-port") {
      out.strictPort = true;
    } else if (a === "--no-open") {
      out.noOpen = true;
    } else if (a === "--help") {
      out.help = true;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
  Skill Vault App

  Usage: skill-vault-app [options]
         npm run dev -- [options]

  Options:
    -p, --port <port>    Port to bind (default: 9994)
    -h, --host <host>    Host to bind (default: 127.0.0.1)
        --no-open        Don't auto-open the browser
        --log-file <path>  Also write all output to <path> (rotated at 5 MB)
        --exit-when-idle   Stop 60 s after the last app window closes (used by the Start Menu launcher)
        --strict-port      Use exactly --port; wait up to 10 s for it, else exit
        --help           Show this message

  Precedence (highest wins):
    1. CLI flags (--port, --host, --no-open)
    2. Environment variables (PORT, HOST, OPEN_BROWSER)
    3. .env file next to package.json
    4. 'app' block in ~/.skill-vault/config.json
    5. Built-in defaults
`);
}

// ── Configuration resolution ───────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
// Before anything else logs, so the whole run lands in the file.
if (args.logFile) installLogFile(args.logFile);

const cliAppBlock = readCliAppBlock();

// Port: CLI flag → PORT env (set by dotenv or shell) → CLI config → default
function resolvePort(): number {
  if (args.port !== undefined) return args.port;
  if (process.env.PORT) {
    const n = Number(process.env.PORT);
    if (!Number.isNaN(n)) return n;
  }
  if (typeof cliAppBlock.port === "number") return cliAppBlock.port;
  return 9994;
}

function resolveHost(): string {
  if (args.host) return args.host;
  if (process.env.HOST) return process.env.HOST;
  if (typeof cliAppBlock.host === "string" && cliAppBlock.host) {
    return cliAppBlock.host;
  }
  return "127.0.0.1";
}

function resolveOpenBrowser(): boolean {
  if (args.noOpen) return false;
  if (process.env.OPEN_BROWSER === "0") return false;
  if (process.env.OPEN_BROWSER === "1") return true;
  if (typeof cliAppBlock.auto_open_browser === "boolean") {
    return cliAppBlock.auto_open_browser;
  }
  return true;
}

const MODE =
  (process.env.NODE_ENV as "development" | "production" | undefined) ??
  "development";

/** app/ — the same root index.ts computes (this file is server/launcher.ts or dist/launcher.js). */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Free-port selection ────────────────────────────────────────

// isPortFree (services/portProbe.ts): for a loopback host a port also has to
// be bindable on 0.0.0.0 and ::, so the app never shadows another server.

async function findFreePort(start: number, host: string): Promise<number> {
  // Try up to 10 ports starting at `start`. Returns 0 on exhaustion so
  // the caller can fall back to OS-assigned ports instead of crashing
  // on a fresh machine where 9994 happens to be taken.
  for (let p = start; p < start + 10; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return 0;
}

/** --strict-port: wait for exactly this port (the previous server releasing it after an update). */
async function waitForPortFree(p: number, host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortFree(p, host)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── Main ──────────────────────────────────────────────────────

/** Positive integer from an env var (tests shorten the idle timers), else the fallback. */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function main(): Promise<void> {
  const preferredPort = resolvePort();
  const host = resolveHost();
  const shouldOpen = resolveOpenBrowser();

  let port: number;
  if (args.strictPort) {
    // Restart after an in-app update: the open window points at this exact
    // port, so wait for the old server to let go of it instead of moving on.
    if (!(await waitForPortFree(preferredPort, host, 10_000))) {
      console.error(`[skill-vault-app] port ${preferredPort} is still in use; giving up`);
      process.exit(1);
    }
    port = preferredPort;
  } else {
    port = await findFreePort(preferredPort, host);
  }

  let server: Server | undefined;
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    releaseLock(process.pid);
    // Run the live-updates cleanup BEFORE closing the HTTP server so
    // chokidar and the SSE client set tear down while the event loop
    // still has them. createApp() hangs the cleanup off app.locals so
    // tests can exercise it without booting a real port.
    try {
      const cleanup = (
        app as unknown as {
          locals: { cleanupLiveUpdates?: () => Promise<void> };
        }
      ).locals.cleanupLiveUpdates;
      if (cleanup) await cleanup();
    } catch (err) {
      console.error("[shutdown] cleanupLiveUpdates threw:", err);
    }
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
    // Safety net: if a stray socket keeps the server open past 3s,
    // exit anyway. Matches the previous synchronous behavior.
    setTimeout(() => process.exit(0), 3000).unref();
  }

  /** After an in-app update: start the new build on this same port, then hand over. */
  function restart(): void {
    releaseLock(process.pid);
    const next = [
      path.join(APP_ROOT, "dist", "launcher.js"),
      "--no-open",
      "--port",
      String(getServerPort() ?? port),
      "--host",
      host,
      "--strict-port",
    ];
    if (args.exitWhenIdle) next.push("--exit-when-idle");
    if (args.logFile) next.push("--log-file", args.logFile);
    try {
      const child = spawn(process.execPath, next, {
        cwd: APP_ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, NODE_ENV: "production" },
      });
      child.once("error", (err) => console.error("[update] the new server failed to start:", err));
      child.unref();
    } catch (err) {
      // Stay up: take the lock back and let the updater report the failure.
      acquireLock({
        pid: process.pid,
        port: getServerPort() ?? port,
        started_at: new Date().toISOString(),
        version: buildVersion(APP_ROOT, MODE),
        mode: MODE,
      });
      throw err;
    }
    setTimeout(() => void shutdown(), 500);
  }

  const app = await createApp({ mode: MODE, restart });

  server = app.listen(port, host, () => {
    const effective =
      port ||
      (server?.address() as { port: number } | null)?.port ||
      preferredPort;
    // The assistant's MCP bridge needs the *bound* port, not the preferred one.
    setServerPort(effective);
    const owned = acquireLock({
      pid: process.pid,
      port: effective,
      started_at: new Date().toISOString(),
      version: buildVersion(APP_ROOT, MODE),
      mode: MODE,
    });
    if (!owned) {
      console.log(`  [lock] another Skill Vault server (pid ${readLock()?.pid}) owns the app lock; this one runs without it.`);
    }
    const displayHost =
      host === "0.0.0.0" || host === "::" ? "localhost" : host;
    const url = `http://${displayHost}:${effective}`;
    console.log(`\n  Skill Vault App  —  ${url}`);
    if (host === "0.0.0.0") {
      console.log("  [!] Binding to 0.0.0.0 — reachable on the LAN.");
    }
    console.log("  (Ctrl+C to stop)\n");
    if (shouldOpen) {
      open(url).catch(() => {
        /* user can click the link */
      });
    }
  });

  // SIGHUP: the console window closing (Windows) or the terminal hanging up;
  // SIGBREAK: Ctrl+Break on Windows. All of them release the lock on the way out.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.on(signal, () => {
      void shutdown();
    });
  }
  process.on("exit", () => releaseLock(process.pid));

  if (args.exitWhenIdle) {
    startIdleStop({
      clients: sseClientCount,
      isBusy: () => (app.locals.isBusy as () => boolean)(),
      graceMs: envMs("SKILL_VAULT_IDLE_GRACE_MS", 60_000),
      bootGraceMs: envMs("SKILL_VAULT_IDLE_BOOT_GRACE_MS", 120_000),
      tickMs: envMs("SKILL_VAULT_IDLE_TICK_MS", 5_000),
      onIdle: () => {
        console.log("[idle] no app window for a while; stopping");
        void shutdown();
      },
    });
  }
}

main().catch((err) => {
  console.error("[skill-vault-app] failed to start:", err);
  process.exit(1);
});
