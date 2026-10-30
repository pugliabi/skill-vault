import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnArgs } from "../turn.ts";
import { createClaudeEngine } from "./claude.ts";
import type { TurnInput } from "./types.ts";

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hello",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: "C:\\app\\assistant-plugin",
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\claude",
  auth: { auth: "login" },
  baseEnv: {},
};

test("Claude's turn is exactly today's buildTurnArgs, message on stdin, no target or env override", () => {
  const spec = createClaudeEngine().buildTurn(INPUT);
  assert.deepEqual(
    spec.args,
    buildTurnArgs({
      sessionId: INPUT.sessionId,
      isFirstTurn: true,
      leadAgent: "vault-assistant",
      contextBlock: "# ctx",
      mcpConfigJson: JSON.stringify({ mcpServers: { vault: INPUT.mcp } }),
      pluginDir: INPUT.pluginDir,
      reposDir: INPUT.reposDir,
    }),
  );
  assert.equal(spec.stdin, "hello");
  assert.equal(spec.cwd, "C:\\vault");
  assert.equal(spec.target, undefined);
  assert.equal(spec.env, undefined);
  assert.equal(spec.label, "claude CLI");
});

test("Claude's login env drops ANTHROPIC_API_KEY; API-key mode sets the saved key", () => {
  const e = createClaudeEngine();
  assert.equal(e.childEnv({ auth: "login" }, { ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY, undefined);
  assert.equal(e.childEnv({ auth: "api_key", api_key: "sk-ant" }, {}).ANTHROPIC_API_KEY, "sk-ant");
  assert.deepEqual(e.loginArgs, ["auth", "login"]);
});
