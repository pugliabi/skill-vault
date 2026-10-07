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

import net from "node:net";
import open from "open";
import { createApp } from "./index.ts";
import { readCliAppBlock } from "./services/appConfig.ts";
import { setServerPort } from "./services/runtime.ts";

// ── CLI argument parsing ───────────────────────────────────────

interface ParsedArgs {
  port?: number;
  host?: string;
  noOpen?: boolean;
  help?: boolean;
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

// ── Free-port selection ────────────────────────────────────────

async function findFreePort(start: number, host: string): Promise<number> {
  // Try up to 10 ports starting at `start`. Returns 0 on exhaustion so
  // the caller can fall back to OS-assigned ports instead of crashing
  // on a fresh machine where 9994 happens to be taken.
  for (let p = start; p < start + 10; p++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(p, host);
    });
    if (free) return p;
  }
  return 0;
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const preferredPort = resolvePort();
  const host = resolveHost();
  const shouldOpen = resolveOpenBrowser();

  const port = await findFreePort(preferredPort, host);
  const app = await createApp({ mode: MODE });

  const server = app.listen(port, host, () => {
    const effective =
      port ||
      (server.address() as { port: number } | null)?.port ||
      preferredPort;
    // The assistant's MCP bridge needs the *bound* port, not the preferred one.
    setServerPort(effective);
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

  const shutdown = async (): Promise<void> => {
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
    server.close(() => process.exit(0));
    // Safety net: if a stray socket keeps the server open past 3s,
    // exit anyway. Matches the previous synchronous behavior.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((err) => {
  console.error("[skill-vault-app] failed to start:", err);
  process.exit(1);
});
