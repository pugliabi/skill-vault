/**
 * Stdio entrypoint for the vault MCP bridge. Launched by the `claude` CLI
 * per assistant turn (see services/assistant/mcpConfig.ts), never by the
 * app server itself. `SKILL_VAULT_URL` carries the app's bound port.
 *
 * Kept separate from bridge.ts so the tool table stays importable by unit
 * tests without touching a transport, and so esbuild gets a clean entry
 * (built to dist/assistant-mcp.js by `npm run build:server`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHttp, registerTools } from "./bridge.ts";

const baseUrl = process.env.SKILL_VAULT_URL;
if (!baseUrl) {
  console.error("[vault-mcp] SKILL_VAULT_URL is not set — refusing to start");
  process.exit(1);
}

const server = new McpServer({ name: "vault", version: "1.0.0" });
registerTools(server, createHttp(baseUrl));
await server.connect(new StdioServerTransport());
