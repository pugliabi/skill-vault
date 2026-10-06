/**
 * Builds the `--mcp-config` JSON that tells the `claude` CLI how to launch
 * the vault MCP bridge for one assistant turn.
 *
 * Dev runs the TypeScript source through tsx (the app itself runs under
 * tsx, so it is guaranteed present); production runs the esbuild bundle
 * `dist/assistant-mcp.js` (see the build:server entry in package.json).
 * Everything here is pure given (mode, appRoot, port) so tests can assert
 * the exact JSON without an app server or filesystem.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

export interface McpBridgeConfig {
  mcpServers: {
    vault: {
      command: string;
      args: string[];
      env: { SKILL_VAULT_URL: string };
    };
  };
}

export function buildMcpConfig(opts: {
  mode: "development" | "production";
  /** The app package root (the directory holding package.json). */
  appRoot: string;
  /** The HTTP port the app server actually bound. */
  port: number;
}): McpBridgeConfig {
  const url = `http://127.0.0.1:${opts.port}`;
  // The CLI spawns the bridge with ITS cwd, not the app root, so the bare
  // "tsx" specifier would fail to resolve (--import resolves from cwd).
  // Point at tsx's loader by absolute file:// URL instead.
  const tsxLoader = pathToFileURL(path.join(opts.appRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const args =
    opts.mode === "production"
      ? [path.join(opts.appRoot, "dist", "assistant-mcp.js")]
      : ["--import", tsxLoader, path.join(opts.appRoot, "server", "assistant-mcp", "main.ts")];
  return {
    mcpServers: {
      vault: {
        command: process.execPath, // the running node — never "node" from PATH
        args,
        env: { SKILL_VAULT_URL: url },
      },
    },
  };
}

/** The exact string to pass as the `--mcp-config` argument value. */
export function mcpConfigArg(opts: Parameters<typeof buildMcpConfig>[0]): string {
  return JSON.stringify(buildMcpConfig(opts));
}
