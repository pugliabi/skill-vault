/**
 * The Global Constraints, checked across every engine at once: no bypass /
 * yolo / allow-all flag in any turn (new or resumed chat, login or API key),
 * Copilot has no shell permission at all, Grok has no shell and no file-write
 * tool (fail-closed until its live check), Claude's shell is git-only, and
 * Codex always runs in its workspace-write sandbox.
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

test("shell: none on Copilot and Grok, git-only on Claude, sandboxed on Codex", () => {
  const byId = (id: string) => ENGINES.find((e) => e.id === id) as AssistantEngine;
  for (const args of turns(byId("copilot"))) assert.ok(!args.some((a) => a.includes("shell(")), "Copilot gets no shell permission");
  // Grok is fail-closed until the live check (grok.ts GROK_TOOLS): no shell tool, no shell rule, no file-write tool.
  for (const args of turns(byId("grok"))) {
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
    assert.ok(tools.includes("read_file"), "the --tools allowlist is there");
    for (const t of ["run_terminal_cmd", "write_file", "search_replace"]) assert.ok(!tools.includes(t), `Grok must not get ${t}`);
    assert.ok(!args.includes("--allow"), "Grok gets no shell rule");
    assert.ok(!args.some((a) => /Bash\(/.test(a)), "Grok gets no Bash(...) permission");
  }
  for (const id of ["claude"]) {
    for (const args of turns(byId(id))) {
      const shells = args.flatMap((a) => a.match(/Bash\([^)]*\)/g) ?? []);
      assert.ok(shells.length > 0, `${id} declares its shell rule`);
      for (const s of shells) assert.match(s, /^Bash\(git[ :]\*\)$/, `${id}: ${s} isn't git-only`);
    }
  }
  for (const args of turns(byId("codex"))) {
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(!args.some((a) => a.includes("danger-full-access")));
  }
});
