/**
 * The Global Constraints, checked across every engine at once: no bypass /
 * yolo / allow-all flag in any turn (new or resumed chat, login or API key),
 * Copilot has no shell permission at all, Grok has no shell and no file-write
 * tool, Codex has no shell and runs its edits in the workspace-write sandbox,
 * and Claude's shell is git-only with its edits limited to the vault and repos.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createClaudeEngine } from "./claude.ts";
import { createCodexEngine } from "./codex.ts";
import type { EngineDeps } from "./common.ts";
import { createCopilotEngine } from "./copilot.ts";
import { createGrokEngine } from "./grok.ts";
import { defaultRegistry } from "./registry.ts";
import { FORBIDDEN_FLAGS } from "./testFakes.ts";
import type { AssistantEngine, TurnInput } from "./types.ts";

const PLUGIN = path.resolve(import.meta.dirname, "..", "..", "..", "..", "assistant-plugin");

const fakeDeps = (): EngineDeps => ({
  resolve: (name, label) => ({ command: `C:\\bin\\${name}.exe`, prefixArgs: [], label }),
  forget: () => {},
  run: async () => ({ code: 0, stdout: "1.0.0\n", stderr: "" }),
  home: "C:\\Users\\me",
  env: {},
  exists: () => false,
  readFile: () => "",
  writeFile: () => {},
});

const ENGINES: AssistantEngine[] = [createClaudeEngine(), createCodexEngine(fakeDeps()), createCopilotEngine(fakeDeps()), createGrokEngine(fakeDeps())];

const BASE: TurnInput = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  isFirstTurn: true,
  message: "hi",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx",
  mcp: { command: "C:\\node.exe", args: ["C:\\app\\dist\\assistant-mcp.js"], env: { SKILL_VAULT_URL: "http://127.0.0.1:9994" } },
  vaultPath: "C:\\vault",
  reposDir: "C:\\repos",
  pluginDir: PLUGIN,
  workDir: "C:\\Users\\me\\.skill-vault\\engines\\x",
  auth: { auth: "login" },
  baseEnv: {},
};

/** New and resumed chat × login and API key. */
function turns(engine: AssistantEngine): string[][] {
  const out: string[][] = [];
  for (const auth of [{ auth: "login" as const }, { auth: "api_key" as const, api_key: "k" }]) {
    out.push(engine.buildTurn({ ...BASE, auth }).args);
    out.push(engine.buildTurn({ ...BASE, auth, isFirstTurn: false, engineSessionId: "thread-1" }).args);
  }
  return out;
}

test("every registered engine is covered here", () => {
  assert.deepEqual(ENGINES.map((e) => e.id), defaultRegistry().list().map((e) => e.id));
});

test("no engine's turn carries a bypass, yolo or allow-all flag", () => {
  for (const engine of ENGINES) {
    for (const args of turns(engine)) {
      const hit = FORBIDDEN_FLAGS.find((f) => args.some((a) => a.includes(f)));
      assert.equal(hit, undefined, `${engine.id} passes ${hit}`);
    }
  }
});

test("shell: none on Codex, Copilot and Grok; git-only on Claude", () => {
  const byId = (id: string) => ENGINES.find((e) => e.id === id) as AssistantEngine;
  for (const args of turns(byId("copilot"))) assert.ok(!args.some((a) => a.includes("shell(")), "Copilot gets no shell permission");
  // Grok has no shell and no file writes (grok.ts GROK_TOOLS): its only allow rule is for the vault's MCP tools.
  for (const args of turns(byId("grok"))) {
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
    assert.ok(tools.includes("read_file"), "the --tools allowlist is there");
    for (const t of ["run_terminal_cmd", "write_file", "search_replace"]) assert.ok(!tools.includes(t), `Grok must not get ${t}`);
    assert.deepEqual(args.flatMap((a, i) => (a === "--allow" ? [args[i + 1]] : [])), ["MCPTool(vault__*)"], "Grok's only allow rule");
    assert.ok(!args.some((a) => /Bash\(/.test(a)), "Grok gets no Bash(...) permission");
  }
  for (const id of ["claude"]) {
    for (const args of turns(byId(id))) {
      const shells = args.flatMap((a) => a.match(/Bash\([^)]*\)/g) ?? []);
      assert.ok(shells.length > 0, `${id} declares its shell rule`);
      for (const s of shells) assert.match(s, /^Bash\(git[ :]\*\)$/, `${id}: ${s} isn't git-only`);
      // Claude Code runs its read-only commands whatever the allow rules say; these close that.
      assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk", "nothing unlisted runs, in any start mode");
      assert.deepEqual(args[args.indexOf("--disallowedTools") + 1].split(","), ["PowerShell", "Monitor"]);
      assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).hooks.PreToolUse[0].matcher, "Bash", "Bash goes through the git gate");
      const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
      assert.ok(!allowed.includes("Edit") && !allowed.includes("Write"), "file edits are limited by path");
      assert.ok(allowed.includes("Edit(//c/vault/**)") && allowed.includes("Edit(//c/repos/**)"));
    }
  }
  for (const args of turns(byId("codex"))) {
    // User decision 2026-10-30: no shell, because on Windows the sandbox reached the app's own API with network off.
    const i = args.indexOf("features.shell_tool=false");
    assert.ok(i > 0 && args[i - 1] === "-c", "Codex has no shell tool");
    assert.ok(!args.some((a) => /^features\.(shell_tool|unified_exec|computer_use)=true$/.test(a)));
    assert.ok(args.includes('sandbox_mode="workspace-write"'), "its own edits stay in the writable roots");
    assert.ok(!args.some((a) => a.includes("danger-full-access")));
    assert.ok(!args.some((a) => a.includes("network_access=true")), "never network on");
  }
});
