// app/server/services/assistant/engines/codex.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCodexEngine, createCodexParser } from "./codex.ts";
import { defaultEngineDeps, type EngineDeps } from "./common.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "codex-turn.jsonl");
/** Codex's own ways out of the sandbox, on top of the shared list. */
const CODEX_FORBIDDEN = ["danger-full-access", "--full-auto"];

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolve: () => ({ command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\codex.js"], label: "codex CLI" }),
    forget: () => {},
    run: async () => ({ code: 0, stdout: "Logged in using ChatGPT\n", stderr: "" }),
    home: "C:\\Users\\me",
    env: {},
    exists: () => false,
    readFile: () => "",
    writeFile: () => {},
    ...over,
  };
}

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "update my skills",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\codex",
  auth: { auth: "login" },
  baseEnv: { OPENAI_API_KEY: "stray", PATH: "C:\\bin" },
};

test("first turn: exec --json with the sandbox, the vault server, prompt on stdin", () => {
  const spec = createCodexEngine(deps()).buildTurn(INPUT);
  assert.deepEqual(spec.target, { command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\codex.js"], label: "codex CLI" });
  assert.equal(spec.args[0], "exec");
  assert.equal(spec.args.at(-1), "-");
  for (const flag of ["--json", "--ignore-user-config", "--skip-git-repo-check"]) assert.ok(spec.args.includes(flag), `missing ${flag}`);
  for (const setting of [
    'sandbox_mode="workspace-write"',
    'windows.sandbox="unelevated"',
    'sandbox_workspace_write.writable_roots=["C:\\\\vault","C:\\\\repos"]',
    "sandbox_workspace_write.network_access=false",
    'approval_policy="never"',
    'mcp_servers.vault.command="C:\\\\node.exe"',
    'mcp_servers.vault.args=["C:\\\\app\\\\dist\\\\assistant-mcp.js"]',
    'mcp_servers.vault.env={ SKILL_VAULT_URL = "http://127.0.0.1:9994" }',
    'mcp_servers.vault.default_tools_approval_mode="approve"',
  ]) {
    const i = spec.args.indexOf(setting);
    assert.ok(i > 0 && spec.args[i - 1] === "-c", `missing -c ${setting}`);
  }
  for (const bad of [...FORBIDDEN_FLAGS, ...CODEX_FORBIDDEN]) assert.ok(!spec.args.some((a) => a.includes(bad)), `must not pass ${bad}`);
  // User decision 2026-10-30: with network on, a sandboxed command could call the app's own API on 127.0.0.1.
  assert.ok(!spec.args.some((a) => a.includes("network_access=true")), "the sandbox never gets the network");
  assert.match(spec.stdin, /no network access/);
  assert.equal(spec.cwd, "C:\\vault");
  assert.match(spec.stdin, /^<skill-vault-instructions>/);
  assert.match(spec.stdin, /running on OpenAI Codex/);
  assert.ok(spec.stdin.endsWith("update my skills"));
  assert.equal(spec.env?.OPENAI_API_KEY, undefined, "login mode strips stray keys");
  assert.equal(spec.env?.PATH, "C:\\bin");
});

test("later turns resume the thread and skip the instructions", () => {
  const spec = createCodexEngine(deps()).buildTurn({ ...INPUT, isFirstTurn: false, engineSessionId: "thread-1" });
  assert.deepEqual(spec.args.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(spec.args.slice(-2), ["thread-1", "-"]);
  assert.ok(spec.args.includes('windows.sandbox="unelevated"'));
  assert.ok(spec.args.includes("sandbox_workspace_write.network_access=false"), "resumed turns have no network either");
  assert.ok(!spec.args.some((a) => a.includes("network_access=true")));
  assert.ok(!spec.stdin.includes("<skill-vault-instructions>"));
  // A failed first turn left no thread id: start a fresh thread with instructions.
  const fresh = createCodexEngine(deps()).buildTurn({ ...INPUT, isFirstTurn: false });
  assert.notEqual(fresh.args[1], "resume");
  assert.match(fresh.stdin, /<skill-vault-instructions>/);
});

test("API-key mode passes the saved key as CODEX_API_KEY", () => {
  const spec = createCodexEngine(deps()).buildTurn({ ...INPUT, auth: { auth: "api_key", api_key: "sk-o" } });
  assert.equal(spec.env?.CODEX_API_KEY, "sk-o");
});

test("authStatus: login status exit code decides; api key mode needs a key", async () => {
  assert.deepEqual(await createCodexEngine(deps()).authStatus({ auth: "login" }), { signed_in: true, method: "login", account: "ChatGPT" });
  const out = createCodexEngine(deps({ run: async () => ({ code: 1, stdout: "Not logged in\n", stderr: "" }) }));
  assert.equal((await out.authStatus({ auth: "login" })).signed_in, false);
  assert.equal((await out.authStatus({ auth: "api_key" })).signed_in, false);
  assert.equal((await out.authStatus({ auth: "api_key", api_key: "k" })).signed_in, true);
});

test("authStatus: the account is a fixed word, never the status line (an API-key login shows part of the key)", async () => {
  const withKey = createCodexEngine(deps({ run: async () => ({ code: 0, stdout: "Logged in using an API key - sk-proj-***ABCD\n", stderr: "" }) }));
  const status = await withKey.authStatus({ auth: "login" });
  assert.deepEqual(status, { signed_in: true, method: "login" });
  assert.ok(!JSON.stringify(status).includes("sk-"));
  const other = createCodexEngine(deps({ run: async () => ({ code: 0, stdout: "Logged in as someone@example.com\n", stderr: "" }) }));
  assert.deepEqual(await other.authStatus({ auth: "login" }), { signed_in: true, method: "login" });
});

test("detect and authStatus never throw when the CLI can't be run", async () => {
  const boom = createCodexEngine(deps({ run: async () => { throw new Error("spawn EPERM"); } }));
  const d = await boom.detect();
  assert.equal(d.installed, false);
  assert.match(d.reason ?? "", /EPERM/);
  assert.equal((await boom.authStatus({ auth: "login" })).signed_in, null);
  const missing = createCodexEngine(deps({ resolve: () => { throw new Error("registry unreadable"); } }));
  assert.equal((await missing.detect()).installed, false);
  assert.equal((await missing.authStatus({ auth: "login" })).signed_in, null);
});

test("the executable is looked up once per name; detect({ refresh: true }) forgets it first", async () => {
  const looked: string[] = [];
  const d = defaultEngineDeps((name, label) => (looked.push(name), { command: `C:\\${name}.exe`, prefixArgs: [], label }));
  d.resolve("codex", "codex CLI");
  d.resolve("codex", "codex CLI");
  d.resolve("grok", "grok CLI");
  d.forget("codex");
  d.resolve("codex", "codex CLI");
  d.resolve("grok", "grok CLI");
  assert.deepEqual(looked, ["codex", "grok", "codex"]);

  const forgot: string[] = [];
  const engine = createCodexEngine(deps({ forget: (n) => forgot.push(n) }));
  await engine.detect();
  assert.deepEqual(forgot, []);
  await engine.detect({ refresh: true });
  assert.deepEqual(forgot, ["codex"]);
});

test("parser: thread id, whole messages, tool calls with results, refusals, end of turn", () => {
  const p = createCodexParser((m) => m);
  const lines = [
    { type: "thread.started", thread_id: "thread-7" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "vault", tool: "list_skills", arguments: {}, result: null, error: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "i1", type: "mcp_tool_call", server: "vault", tool: "list_skills", arguments: {}, result: { content: [{ type: "text", text: "12 skills" }] }, error: null, status: "completed" } },
    { type: "item.completed", item: { id: "i2", type: "command_execution", command: "hostname", aggregated_output: "PC1", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "i3", type: "command_execution", command: "del x", aggregated_output: "", exit_code: null, status: "declined" } },
    { type: "item.completed", item: { id: "i4", type: "mcp_tool_call", server: "vault", tool: "push_skill", arguments: {}, result: null, error: { message: "user cancelled MCP tool call" }, status: "failed" } },
    { type: "item.completed", item: { id: "i5", type: "agent_message", text: "You have 12 skills." } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
  ];
  const events = lines.flatMap((l) => p.parse(JSON.stringify(l)));
  assert.equal(p.engineSessionId?.(), "thread-7");
  assert.deepEqual(events.map((e) => e.type), [
    "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "turn_end",
  ]);
  assert.equal(events[0].type === "tool_start" && events[0].label, "vault: list_skills");
  assert.equal(events[2].type === "tool_start" && events[2].label, "Running: hostname");
  assert.equal(events[1].type === "tool_result" && events[1].output_preview, "12 skills");
  assert.equal(events[3].type === "tool_result" && events[3].ok, true);
  assert.equal(events[5].type === "tool_result" && events[5].ok, false, "a declined command is a refusal");
  assert.equal(events[7].type === "tool_result" && events[7].ok, false, "a failed MCP call is a refusal");
  assert.equal(events[7].type === "tool_result" && events[7].output_preview, "user cancelled MCP tool call");
  assert.deepEqual(p.parse("not json"), []);
  assert.deepEqual(p.parse(JSON.stringify({ type: "turn.failed", error: { message: "boom" } })), [{ type: "error", message: "boom" }]);
});

test("parser: the recorded Codex turn (S7) — thread id, the vault call, a shell call, text, end of turn", () => {
  const p = createCodexParser((m) => m);
  const events = fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((l) => p.parse(l));
  assert.equal(p.engineSessionId?.(), "01a189ea-394d-7400-b24a-ed9345e12f08");
  assert.deepEqual(events.map((e) => e.type), ["text_delta", "tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "turn_end"]);
  const vault = events[1];
  assert.ok(vault.type === "tool_start" && vault.name === "mcp__vault__list_skills");
  assert.ok(events[2].type === "tool_result" && events[2].ok && events[2].output_preview?.includes('"total":3'));
  // The sandbox allows commands by design (hostname ran); the outside write left no item at all.
  assert.ok(events[3].type === "tool_start" && events[3].name === "Bash");
  assert.ok(events[4].type === "tool_result" && events[4].ok);
});
