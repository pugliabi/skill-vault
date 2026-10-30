import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GROK_TOOLS, createGrokEngine, grokConfigToml, grokHome } from "./grok.ts";
import type { EngineDeps } from "./common.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");
/** Hand-written from xAI's docs, not recorded: it pins the parser to the documented shapes until Task 20. */
const FIXTURE = path.join(import.meta.dirname, "fixtures", "grok-turn.jsonl");
const MCP = { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } };

function deps(written: Record<string, string>, over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolve: () => ({ command: "C:\\Users\\me\\.grok\\bin\\grok.exe", prefixArgs: [], label: "grok CLI" }),
    forget: () => {},
    run: async () => ({ code: 0, stdout: "grok 1.0.0\n", stderr: "" }),
    home: "C:\\Users\\me",
    env: {},
    exists: (p) => p in written,
    readFile: (p) => written[p] ?? "",
    writeFile: (p, t) => {
      written[p] = t;
    },
    ...over,
  };
}

const INPUT: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hi",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: MCP,
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\grok",
  auth: { auth: "login" },
  baseEnv: { XAI_API_KEY: "stray" },
};

test("config.toml: only the vault server, Claude/Cursor MCP and hook imports off", () => {
  const t = grokConfigToml(MCP);
  assert.match(t, /\[mcp_servers\.vault\]\ncommand = "C:\\\\node\.exe"/);
  assert.match(t, /\[compat\.claude\]\nmcps = false\nhooks = false/);
  assert.match(t, /\[compat\.cursor\]\nmcps = false\nhooks = false/);
});

test("turn: prompt file, Claude-format stream, app-owned GROK_HOME, no shell and no file writes (fail-closed)", () => {
  const written: Record<string, string> = {};
  const spec = createGrokEngine(deps(written)).buildTurn(INPUT);
  const a = spec.args;
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  const promptFile = after("--prompt-file");
  assert.ok(spec.tempFiles?.includes(promptFile));
  assert.match(written[promptFile], /^<skill-vault-instructions>/);
  assert.match(written[promptFile], /There is no shell tool here/);
  assert.match(written[promptFile], /can't edit or create files directly here/);
  assert.equal(after("--output-format"), "streaming-messages-json");
  assert.ok(a.includes("--include-partial-messages"));
  assert.equal(after("-s"), INPUT.sessionId);
  assert.equal(after("--cwd"), "C:\\vault");
  assert.equal(after("--tools"), GROK_TOOLS);
  assert.deepEqual(GROK_TOOLS.split(","), ["read_file", "grep", "list_dir", "web_search", "web_fetch"]);
  // One allow rule, for the vault's MCP tools (headless Grok cancels anything that would prompt). No shell rule.
  assert.deepEqual(a.flatMap((x, i) => (x === "--allow" ? [a[i + 1]] : [])), ["MCPTool(vault__*)"]);
  for (const bad of [...FORBIDDEN_FLAGS, "--always-approve"]) assert.ok(!a.some((x) => x.includes(bad)), `must not pass ${bad}`);
  assert.equal(spec.env?.GROK_HOME, grokHome("C:\\Users\\me", "login"));
  assert.equal(spec.env?.XAI_API_KEY, undefined);
  assert.ok(written[path.join(grokHome("C:\\Users\\me", "login"), "config.toml")]);
  const later = createGrokEngine(deps({})).buildTurn({ ...INPUT, isFirstTurn: false });
  assert.equal(later.args[later.args.indexOf("-r") + 1], INPUT.sessionId);
});

test("API-key mode uses a separate home with no login in it", () => {
  const spec = createGrokEngine(deps({})).buildTurn({ ...INPUT, auth: { auth: "api_key", api_key: "xai-k" } });
  assert.equal(spec.env?.GROK_HOME, grokHome("C:\\Users\\me", "api_key"));
  assert.equal(spec.env?.XAI_API_KEY, "xai-k");
});

test("authStatus: auth.json in the app's Grok home", async () => {
  const signedIn = { [path.join(grokHome("C:\\Users\\me", "login"), "auth.json")]: "{}" };
  assert.equal((await createGrokEngine(deps(signedIn)).authStatus({ auth: "login" })).signed_in, true);
  assert.equal((await createGrokEngine(deps({})).authStatus({ auth: "login" })).signed_in, false);
  assert.deepEqual(createGrokEngine(deps({})).loginEnv(), { GROK_HOME: grokHome("C:\\Users\\me", "login") });
});

test("detect and authStatus never throw", async () => {
  const boom = (): never => {
    throw new Error("disk on fire");
  };
  const engine = createGrokEngine(deps({}, { run: async () => boom(), exists: boom }));
  const d = await engine.detect({ refresh: true });
  assert.equal(d.installed, false);
  const noResolve = createGrokEngine(deps({}, { resolve: boom }));
  assert.equal((await noResolve.detect()).installed, false);
  assert.equal((await engine.authStatus({ auth: "login" })).signed_in, null);
});

test("parser: the hand-written Grok fixture maps tools to the shared vocabulary", () => {
  const p = createGrokEngine(deps({})).createParser();
  const events = fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/).filter(Boolean).flatMap((l) => p.parse(l));
  assert.deepEqual(events.map((e) => e.type), [
    "session", "text_delta", "tool_start", "tool_result", "tool_start", "tool_result", "tool_start", "tool_result", "text_delta", "turn_end",
  ]);
  assert.ok(events.some((e) => e.type === "tool_start" && e.name === "mcp__vault__list_skills"));
  const shell = events.find((e) => e.type === "tool_start" && e.name === "Bash");
  const write = events.find((e) => e.type === "tool_start" && e.name === "Write");
  assert.ok(shell?.type === "tool_start" && shell.label === "Running: hostname");
  assert.ok(write?.type === "tool_start");
  for (const start of [shell, write]) {
    const r = events.find((e) => e.type === "tool_result" && start?.type === "tool_start" && e.tool_use_id === start.tool_use_id);
    assert.ok(r?.type === "tool_result" && r.ok === false, "an is_error result is a refusal");
  }
  const end = events.at(-1);
  assert.ok(end?.type === "turn_end" && end.cost_usd === 0.0042, "cost comes from the result record");
});

test("parser: Grok's live use_tool shape and a cancelled turn's error", () => {
  const p = createGrokEngine(deps({})).createParser();
  const call = { type: "tool_use", id: "c1", name: "use_tool", input: { tool_name: "vault__list_skills", tool_input: {} } };
  const [start] = p.parse(JSON.stringify({ type: "assistant", message: { content: [call] } }));
  assert.ok(start.type === "tool_start" && start.name === "mcp__vault__list_skills" && start.label === "vault: list_skills");
  const [err] = p.parse(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["cancelled"] }));
  assert.ok(err.type === "error" && err.message.startsWith("Grok Build reported an error: cancelled"), "names Grok, not claude");
});

test("parser: a model-chosen tool name like constructor or __proto__ never throws", () => {
  const p = createGrokEngine(deps({})).createParser();
  for (const [i, name] of ["constructor", "__proto__", "toString"].entries()) {
    const viaUseTool = { type: "tool_use", id: `u${i}`, name: "use_tool", input: { name, arguments: {} } };
    const direct = { type: "tool_use", id: `d${i}`, name, input: {} };
    const events = p.parse(JSON.stringify({ type: "assistant", message: { content: [viaUseTool, direct] } }));
    assert.deepEqual(
      events.map((e) => (e.type === "tool_start" ? `${e.name}|${e.label}` : e.type)),
      [`${name}|${name}`, `${name}|${name}`],
    );
  }
});
