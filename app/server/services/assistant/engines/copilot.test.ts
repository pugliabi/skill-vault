// app/server/services/assistant/engines/copilot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createCopilotEngine, createCopilotParser } from "./copilot.ts";
import type { EngineDeps } from "./common.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "copilot-turn.jsonl");

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolve: () => ({ command: "C:\\node\\node.exe", prefixArgs: ["C:\\npm\\copilot\\npm-loader.js"], label: "copilot CLI" }),
    forget: () => {},
    run: async () => ({ code: 0, stdout: "GitHub Copilot CLI 1.0.105.\n", stderr: "" }),
    home: "C:\\Users\\me",
    env: {},
    exists: () => true,
    readFile: () => JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "octo" }, loggedInUsers: [{ host: "https://github.com", login: "octo" }] }),
    writeFile: () => {},
    ...over,
  };
}

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hi",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\copilot",
  auth: { auth: "login" },
  baseEnv: { GH_TOKEN: "ghp_stray", PATH: "C:\\bin" },
};

test("turn: -p prompt, JSON output, same session id, plugin agent, no shell tool at all", () => {
  const spec = createCopilotEngine(deps()).buildTurn(INPUT);
  const a = spec.args;
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after("--output-format"), "json");
  assert.equal(after("--session-id"), INPUT.sessionId);
  assert.equal(after("-C"), "C:\\vault");
  assert.equal(after("--plugin-dir"), PLUGIN);
  assert.equal(after("--agent"), "skill-vault-assistant:vault-assistant"); // S9: plugin-qualified
  assert.deepEqual(JSON.parse(after("--additional-mcp-config")).mcpServers.vault.command, "C:\\node.exe");
  const tools = a.indexOf("--available-tools");
  assert.deepEqual(a.slice(tools + 1, tools + 11), ["view", "create", "edit", "grep", "glob", "web_fetch", "skill", "task", "update_todo", "vault"]);
  assert.ok(a[tools + 11].startsWith("--"), "the allowlist ends at the next flag");
  const allowed = a.flatMap((x, i) => (x === "--allow-tool" ? [a[i + 1]] : []));
  assert.deepEqual(allowed, ["write", "vault"]);
  assert.ok(!a.some((x) => x.includes("shell(")), "no shell permission anywhere");
  for (const bad of FORBIDDEN_FLAGS) assert.ok(!a.some((x) => x.includes(bad)), `must not pass ${bad}`);
  assert.ok(!a.includes("--no-remote"), "Copilot has no --no-remote flag");
  for (const flag of ["--disallow-temp-dir", "--disable-builtin-mcps", "--no-ask-user", "--no-auto-update"]) assert.ok(a.includes(flag), `missing ${flag}`);
  assert.match(after("-p"), /running on GitHub Copilot CLI/);
  assert.match(after("-p"), /There is no shell tool here/);
  assert.ok(after("-p").endsWith("hi"));
  assert.equal(spec.env?.GH_TOKEN, undefined, "a stray gh token must not override the login");
  const later = createCopilotEngine(deps()).buildTurn({ ...INPUT, isFirstTurn: false });
  assert.ok(!later.args[later.args.indexOf("-p") + 1].includes("<skill-vault-instructions>"));
  assert.equal(later.args[later.args.indexOf("--session-id") + 1], INPUT.sessionId, "the same flag resumes");
});

test("API-key mode passes the token as COPILOT_GITHUB_TOKEN", () => {
  const spec = createCopilotEngine(deps()).buildTurn({ ...INPUT, auth: { auth: "api_key", api_key: "github_pat_x" } });
  assert.equal(spec.env?.COPILOT_GITHUB_TOKEN, "github_pat_x");
});

test("authStatus reads the signed-in user from config.json (camelCase, S8)", async () => {
  assert.deepEqual(await createCopilotEngine(deps()).authStatus({ auth: "login" }), { signed_in: true, method: "login", account: "octo" });
  const onlyList = deps({ readFile: () => JSON.stringify({ loggedInUsers: [{ host: "https://github.com", login: "mona" }] }) });
  assert.equal((await createCopilotEngine(onlyList).authStatus({ auth: "login" })).account, "mona");
  const snake = deps({ readFile: () => JSON.stringify({ logged_in_users: [{ login: "octo" }] }) });
  assert.equal((await createCopilotEngine(snake).authStatus({ auth: "login" })).signed_in, false);
  assert.equal((await createCopilotEngine(deps({ exists: () => false })).authStatus({ auth: "login" })).signed_in, false);
  assert.equal((await createCopilotEngine(deps({ readFile: () => "{" })).authStatus({ auth: "login" })).signed_in, null);
});

test("detect and authStatus never throw", async () => {
  const boom = createCopilotEngine(deps({ run: async () => { throw new Error("spawn EPERM"); } }));
  const d = await boom.detect();
  assert.equal(d.installed, false);
  assert.match(d.reason ?? "", /EPERM/);
  const missing = createCopilotEngine(deps({ resolve: () => { throw new Error("registry unreadable"); } }));
  assert.equal((await missing.detect()).installed, false);
  const bad = createCopilotEngine(deps({ exists: () => { throw new Error("EACCES"); } }));
  assert.equal((await bad.authStatus({ auth: "login" })).signed_in, null);
});

test("parser: deltas, tools (vault + a denied write), one end of turn", () => {
  const p = createCopilotParser((m) => m);
  const lines = [
    { type: "assistant.turn_start", data: { turnId: "0" } },
    { type: "assistant.message", data: { messageId: "m0", content: "", toolRequests: [{ toolCallId: "c1", name: "vault-list_skills", arguments: {} }] } },
    { type: "tool.execution_start", data: { toolCallId: "c1", toolName: "vault-list_skills", arguments: {}, mcpServerName: "vault", mcpToolName: "list_skills" } },
    { type: "tool.execution_complete", data: { toolCallId: "c1", success: true, result: { content: "12", detailedContent: "12" } } },
    { type: "tool.execution_start", data: { toolCallId: "c2", toolName: "create", arguments: { path: "C:\\outside.txt", file_text: "hi" } } },
    { type: "tool.execution_complete", data: { toolCallId: "c2", success: false, error: { message: "Permission denied", code: "denied" } } },
    { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "You have " } },
    { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "12 skills." } },
    { type: "assistant.message", data: { messageId: "m1", content: "You have 12 skills.", toolRequests: [] } },
    { type: "assistant.idle", data: {}, ephemeral: true },
    { type: "result", sessionId: "s", exitCode: 0, usage: { premiumRequests: 1 } },
  ];
  const events = lines.flatMap((l) => p.parse(JSON.stringify(l)));
  assert.deepEqual(events.map((e) => e.type), ["tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "text_delta", "turn_end"]);
  assert.equal(events[0].type === "tool_start" && events[0].label, "vault: list_skills");
  assert.equal(events[2].type === "tool_start" && events[2].label, "Writing C:/outside.txt");
  assert.equal(events[3].type === "tool_result" && events[3].ok, false);
  assert.equal(events[3].type === "tool_result" && events[3].output_preview, "Permission denied");
  const failed = createCopilotParser((m) => m).parse(JSON.stringify({ type: "result", exitCode: 1 }));
  assert.deepEqual(failed.map((e) => e.type), ["error"]);
});

test("parser: the recorded Copilot turn (S9) — text, the vault call, the denied write, end of turn", () => {
  // Recorded before the --available-tools allowlist, so it still has a powershell call; shapes only.
  const lines = fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/).filter(Boolean);
  const p = createCopilotParser((m) => m);
  const events = lines.flatMap((l) => p.parse(l));
  const final = lines.map((l) => JSON.parse(l)).filter((m) => m.type === "assistant.message" && m.data.content).at(-1);
  const text = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
  assert.equal(text, final.data.content, "the deltas add up to the final message, which isn't repeated");
  assert.ok(events.some((e) => e.type === "tool_start" && e.name === "mcp__vault__list_skills"));
  const write = events.find((e) => e.type === "tool_start" && e.name === "Write");
  assert.ok(write && write.type === "tool_start");
  const result = events.find((e) => e.type === "tool_result" && e.tool_use_id === write.tool_use_id);
  assert.ok(result && result.type === "tool_result" && result.ok === false, "the denied create is a refused tool_result");
  assert.equal(events.filter((e) => e.type === "turn_end").length, 1);
  assert.equal(events.at(-1)?.type, "turn_end");
});
