/**
 * Entry for the vault bridge (built to dist/assistant-mcp.js).
 *
 *   - The in-app assistant launches it per turn with SKILL_VAULT_URL set
 *     (services/assistant/mcpConfig.ts).
 *   - Claude Desktop and Claude Code launch it as the "skill-vault" MCP
 *     server, and ~/.skill-vault/bin/skill-vault runs its command mode
 *     (cli.ts). With no SKILL_VAULT_URL it finds or starts the server
 *     itself (server.ts).
 *
 * Kept separate from bridge.ts so the tool table stays importable by unit
 * tests without touching a transport.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttp, registerTools } from "./bridge.ts";
import { USAGE, defaultClient, missingTool, parseBridgeArgs, readStdinWithin, runCommand, type CommandInput } from "./cli.ts";
import { createResolvingFetch, findOrStartServer, realServerDeps } from "./server.ts";

const args = parseBridgeArgs(process.argv.slice(2), defaultClient(process.env));

// <app>/dist/assistant-mcp.js when built, <app>/server/assistant-mcp/main.ts in dev.
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.basename(here) === "dist" ? path.dirname(here) : path.resolve(here, "..", "..");

const http = process.env.SKILL_VAULT_URL
  ? createHttp(process.env.SKILL_VAULT_URL, fetch, args.client)
  : createHttp("", createResolvingFetch(() => findOrStartServer(realServerDeps(appDir))), args.client);

if (missingTool(args)) {
  process.stdout.write(JSON.stringify({ error: USAGE }, null, 2) + "\n");
  process.exitCode = 1;
} else if (args.command) {
  // With --file, stdin is never read (or waited on).
  const input: CommandInput =
    args.file !== null
      ? { file: args.file }
      : args.command === "tools" || process.stdin.isTTY
        ? ""
        : await readStdinWithin(process.stdin, 2_000);
  const { code, out } = await runCommand(args.command, input, http, (ms) => new Promise((r) => setTimeout(r, ms)));
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = code;
} else {
  const server = new McpServer({ name: "vault", version: "1.0.0" });
  registerTools(server, http);
  await server.connect(new StdioServerTransport());
}
