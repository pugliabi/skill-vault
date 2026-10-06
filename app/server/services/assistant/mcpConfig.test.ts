import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildMcpConfig, mcpConfigArg } from "./mcpConfig.ts";

const APP = "C:\\apps\\skill-vault\\app";

test("dev mode launches the TS bridge through tsx's loader by absolute file:// URL (cwd-independent)", () => {
  const cfg = buildMcpConfig({ mode: "development", appRoot: APP, port: 5199 });
  const vault = cfg.mcpServers.vault;
  assert.equal(vault.command, process.execPath);
  assert.equal(vault.args[0], "--import");
  assert.match(vault.args[1], /^file:\/\/\//, "tsx loader must be a file URL, not a bare specifier");
  assert.match(vault.args[1], /node_modules\/tsx\/dist\/loader\.mjs$/);
  assert.equal(vault.args[2], path.join(APP, "server", "assistant-mcp", "main.ts"));
  assert.deepEqual(vault.env, { SKILL_VAULT_URL: "http://127.0.0.1:5199" });
});

test("production mode launches the esbuild bundle directly", () => {
  const cfg = buildMcpConfig({ mode: "production", appRoot: APP, port: 6001 });
  assert.deepEqual(cfg.mcpServers.vault.args, [path.join(APP, "dist", "assistant-mcp.js")]);
  assert.equal(cfg.mcpServers.vault.env.SKILL_VAULT_URL, "http://127.0.0.1:6001");
});

test("mcpConfigArg is the JSON string of the same config", () => {
  const opts = { mode: "production" as const, appRoot: APP, port: 7000 };
  assert.deepEqual(JSON.parse(mcpConfigArg(opts)), buildMcpConfig(opts));
});
