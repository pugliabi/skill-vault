import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, HARD_TIMEOUT_MS, IDLE_TIMEOUT_MS, buildTurnArgs, editRule, runTurn } from "./turn.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseStreamJsonLine } from "./streamEvents.ts";
import { withAuthHint } from "../claude/auth.ts";
import type { AssistantStreamEvent } from "./streamEvents.ts";
import type { ClaudeStreamRunner } from "../claude/cli.ts";
import { ClaudeError } from "../claude/cli.ts";

const BASE_ARGS = {
  sessionId: "11111111-2222-3333-4444-555555555555",
  leadAgent: "vault-assistant",
  contextBlock: "# ctx\nline two",
  mcpConfigJson: '{"mcpServers":{}}',
  vaultPath: "C:\\Github\\vault",
  pluginDir: "C:\\app\\assistant-plugin",
  reposDir: "C:\\Github\\skills-repos",
};

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  assert.ok(i >= 0, `${name} is passed`);
  return args[i + 1];
}

function gitGate(args: string[]) {
  const settings = JSON.parse(flag(args, "--settings"));
  assert.deepEqual(Object.keys(settings).sort(), ["env", "hooks"]);
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  return settings.hooks.PreToolUse[0];
}

test("buildTurnArgs: first turn uses --session-id, later turns --resume; flag set is exact", () => {
  const first = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true });
  assert.deepEqual(first, [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--session-id",
    BASE_ARGS.sessionId,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--plugin-dir",
    "C:\\app\\assistant-plugin",
    "--agent",
    "vault-assistant",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    `${ALLOWED_TOOLS},Edit(//c/Github/vault/**),Edit(//c/Github/skills-repos/**)`,
    "--disallowedTools",
    "PowerShell,Monitor",
    "--settings",
    JSON.stringify({
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [path.join("C:\\app\\assistant-plugin", "hooks", "git-gate.mjs"), "--hook", "C:\\Github\\vault", "C:\\Github\\skills-repos"],
                onFailure: "block",
              },
            ],
          },
        ],
      },
    }),
    "--add-dir",
    "C:\\Github\\skills-repos",
    "--add-dir",
    "C:\\app\\assistant-plugin",
    "--append-system-prompt",
    "# ctx\nline two",
  ]);

  const resumed = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: false });
  assert.ok(resumed.includes("--resume"));
  assert.ok(!resumed.includes("--session-id"));

  // Safety invariants: sessions persist, tools are allowlisted — never bypassed.
  assert.ok(!first.includes("--no-session-persistence"));
  assert.ok(!first.includes("--dangerously-skip-permissions"));
  assert.match(ALLOWED_TOOLS, /Bash\(git:\*\)/);
  assert.match(ALLOWED_TOOLS, /mcp__vault__\*/);
  assert.ok(/(^|,)Task(,|$)/.test(ALLOWED_TOOLS), "Task stays — the lead delegates to the bundled subagents");
  assert.ok(!/(^|,)Bash(,|$)/.test(ALLOWED_TOOLS), "unrestricted Bash must never be allowed");
});

test("buildTurnArgs: a resumed turn keeps every limit", () => {
  const first = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true });
  const resumed = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: false });
  for (const name of ["--permission-mode", "--allowedTools", "--disallowedTools", "--settings"]) {
    assert.equal(flag(resumed, name), flag(first, name), name);
  }
});

test("buildTurnArgs: file edits are limited by path, never a bare Edit or Write", () => {
  const args = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true });
  const allowed = flag(args, "--allowedTools").split(",");
  assert.ok(!allowed.includes("Edit"), "a bare Edit reaches any file");
  assert.ok(!allowed.includes("Write"), "a bare Write reaches any file");
  assert.ok(!allowed.some((rule) => rule.startsWith("Write(")), "Claude Code never matches a Write(path) rule");
  assert.deepEqual(allowed.filter((rule) => rule.startsWith("Edit(")), ["Edit(//c/Github/vault/**)", "Edit(//c/Github/skills-repos/**)"]);
});

test("buildTurnArgs: the plugin bundle stays readable but gets no edit rule", () => {
  const args = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true });
  assert.ok(!flag(args, "--allowedTools").includes("assistant-plugin"), "Claude Code refuses writes to a --plugin-dir anyway");
  assert.equal(args.filter((a) => a === "C:\\app\\assistant-plugin").length, 2, "--plugin-dir and --add-dir");
});

test("buildTurnArgs: no shell tool but Bash, and Bash goes through the git gate", () => {
  const args = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true });
  assert.deepEqual(flag(args, "--disallowedTools").split(","), ["PowerShell", "Monitor"]);
  assert.equal(flag(args, "--permission-mode"), "dontAsk");

  const gate = gitGate(args);
  assert.equal(gate.matcher, "Bash");
  const hook = gate.hooks[0];
  assert.equal(hook.command, process.execPath, "the running node, never node from PATH");
  assert.equal(hook.onFailure, "block");
  assert.equal(path.basename(hook.args[0]), "git-gate.mjs");
  assert.deepEqual(hook.args.slice(1), ["--hook", "C:\\Github\\vault", "C:\\Github\\skills-repos"]);
});

test("buildTurnArgs: git won't use a bare repository it merely finds in a folder", () => {
  const { env } = JSON.parse(flag(buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true }), "--settings"));
  assert.deepEqual(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" });
});

test("the git gate script ships inside the plugin bundle", () => {
  const plugin = path.resolve(import.meta.dirname, "..", "..", "..", "assistant-plugin");
  const args = buildTurnArgs({ ...BASE_ARGS, pluginDir: plugin, isFirstTurn: true });
  assert.ok(fs.existsSync(gitGate(args).hooks[0].args[0]));
});

test("buildTurnArgs: --setting-sources stays empty and the hook comes from --settings alone", () => {
  const args = buildTurnArgs({ ...BASE_ARGS, isFirstTurn: true });
  assert.equal(flag(args, "--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
});

test("editRule writes each path the way Claude Code matches it", () => {
  assert.equal(editRule("C:\\Github\\vault"), "Edit(//c/Github/vault/**)");
  assert.equal(editRule("C:\\Github\\vault\\"), "Edit(//c/Github/vault/**)");
  assert.equal(editRule("D:/My Skills/vault"), "Edit(//d/My Skills/vault/**)");
  assert.equal(editRule("C:\\Github\\a\\..\\vault"), "Edit(//c/Github/vault/**)");
  assert.equal(editRule("C:\\"), "Edit(//c/**)");
  assert.equal(editRule("/home/me/vault"), "Edit(//home/me/vault/**)");
  assert.equal(editRule("/home/me/vault/"), "Edit(//home/me/vault/**)");
});

test("editRule escapes gitignore pattern characters, or the rule would match nothing", () => {
  assert.equal(editRule("C:\\[work]\\vault"), "Edit(//c/\\[work\\]/vault/**)");
  assert.equal(editRule("/home/me/a*b?c"), "Edit(//home/me/a\\*b\\?c/**)");
});

test("buildTurnArgs: a folder behind a junction or symlink gets a rule for both paths", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sv-turn-args-"));
  try {
    const real = path.join(base, "real-vault");
    const link = path.join(base, "linked-vault");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, "junction");
    const args = buildTurnArgs({ ...BASE_ARGS, vaultPath: link, isFirstTurn: true });

    const realPath = fs.realpathSync(real);
    const allowed = flag(args, "--allowedTools");
    assert.ok(allowed.includes(editRule(link)), "the path as configured");
    assert.ok(allowed.includes(editRule(realPath)), "the path it resolves to");
    assert.deepEqual(gitGate(args).hooks[0].args.slice(2), [link, realPath, "C:\\Github\\skills-repos"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function scriptedRunner(lines: string[]): ClaudeStreamRunner & { calls: Array<{ args: string[]; stdin: string; cwd: string; idle: number; hard: number }> } {
  const calls: Array<{ args: string[]; stdin: string; cwd: string; idle: number; hard: number }> = [];
  const runner = (async (args, stdin, opts) => {
    calls.push({ args, stdin, cwd: opts.cwd, idle: opts.idleTimeoutMs, hard: opts.hardTimeoutMs });
    for (const l of lines) opts.onLine(l);
    return { code: 0, stderr: "" };
  }) as ClaudeStreamRunner & { calls: typeof calls };
  runner.calls = calls;
  return runner;
}

test("runTurn streams live events, compacts deltas for history, and extracts cost", async () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Check" } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ing…" } } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__vault__check_updates", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } } }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.07, duration_ms: 1234 }),
  ];
  const runner = scriptedRunner(lines);
  const emitted: AssistantStreamEvent[] = [];
  const result = await runTurn({
    spec: { label: "claude CLI", args: ["-p"], stdin: "update everything", cwd: "C:\\vault" },
    parser: { parse: (l) => parseStreamJsonLine(l) },
    authHint: withAuthHint,
    abort: new AbortController(),
    emit: (ev) => emitted.push(ev),
    streamRunner: runner,
  });

  assert.equal(runner.calls[0].stdin, "update everything");
  assert.equal(runner.calls[0].cwd, "C:\\vault");
  assert.equal(runner.calls[0].idle, IDLE_TIMEOUT_MS);
  assert.equal(runner.calls[0].hard, HARD_TIMEOUT_MS);

  // Live: every delta forwarded (session echo suppressed — the route already sent it).
  assert.deepEqual(
    emitted.map((e) => e.type),
    ["text_delta", "text_delta", "tool_start", "tool_result", "text_delta", "turn_end"],
  );

  // History: deltas folded, order preserved around tool events.
  assert.deepEqual(
    result.events.map((e) => (e.type === "text_delta" ? `text:${e.text}` : e.type)),
    ["text:Checking…", "tool_start", "tool_result", "text:Done.", "turn_end"],
  );
  assert.equal(result.costUsd, 0.07);
  assert.equal(result.errorMessage, undefined);
});

test("runTurn surfaces a missing result record as an error event with stderr detail", async () => {
  const runner = (async (_args, _stdin, opts) => {
    opts.onLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }));
    return { code: 1, stderr: "something exploded\nlast line" };
  }) as ClaudeStreamRunner;
  const emitted: AssistantStreamEvent[] = [];
  const result = await runTurn({
    spec: { label: "claude CLI", args: [], stdin: "hi", cwd: "C:\\vault" },
    parser: { parse: (l) => parseStreamJsonLine(l) },
    authHint: withAuthHint,
    abort: new AbortController(),
    emit: (ev) => emitted.push(ev),
    streamRunner: runner,
  });
  assert.match(result.errorMessage ?? "", /exited \(code 1\)/);
  assert.match(result.errorMessage ?? "", /last line/);
  assert.equal(emitted.at(-1)?.type, "error");
});

test("runTurn maps an abort to the quiet 'stopped' error and keeps partial text in history", async () => {
  const abort = new AbortController();
  const runner = (async (_args, _stdin, opts) => {
    opts.onLine(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial…" } } }));
    abort.abort();
    throw new ClaudeError("claude CLI call aborted");
  }) as ClaudeStreamRunner;
  const emitted: AssistantStreamEvent[] = [];
  const result = await runTurn({
    spec: { label: "claude CLI", args: [], stdin: "long job", cwd: "C:\\vault" },
    parser: { parse: (l) => parseStreamJsonLine(l) },
    authHint: withAuthHint,
    abort,
    emit: (ev) => emitted.push(ev),
    streamRunner: runner,
  });
  assert.equal(result.errorMessage, "stopped");
  assert.deepEqual(
    result.events.map((e) => (e.type === "text_delta" ? `text:${e.text}` : e.type)),
    ["text:partial…", "error"],
  );
  assert.deepEqual(emitted.map((e) => e.type), ["text_delta", "error"]);
});

test("runTurn drops a line whose parser throws and still completes the turn", async () => {
  const emitted: AssistantStreamEvent[] = [];
  const result = await runTurn({
    spec: { label: "grok CLI", args: [], stdin: "", cwd: "C:\\vault" },
    parser: {
      parse: (l) => {
        if (l === "boom") throw new TypeError("name.match is not a function");
        return l === "done" ? [{ type: "turn_end" }] : [{ type: "text_delta", text: l }];
      },
    },
    authHint: (m) => m,
    abort: new AbortController(),
    emit: (ev) => emitted.push(ev),
    streamRunner: scriptedRunner(["hello", "boom", "done"]),
  });
  assert.equal(result.errorMessage, undefined);
  assert.deepEqual(emitted.map((e) => e.type), ["text_delta", "turn_end"]);
  assert.deepEqual(result.events.map((e) => e.type), ["text_delta", "turn_end"]);
});

test("runTurn passes the target and env through, returns the engine's session id, and deletes temp files", async () => {
  const tmp = path.join(os.tmpdir(), `sv-turn-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "prompt");
  let seen: { target?: unknown; env?: unknown } = {};
  const runner = (async (_args, _stdin, opts) => {
    seen = { target: opts.target, env: opts.env };
    opts.onLine("done");
    return { code: 0, stderr: "" };
  }) as ClaudeStreamRunner;
  const target = { command: "C:\\codex.exe", prefixArgs: [], label: "codex CLI" };
  const result = await runTurn({
    spec: { label: "codex CLI", target, args: ["exec"], stdin: "x", env: { A: "1" }, cwd: "C:\\vault", tempFiles: [tmp] },
    parser: { parse: (l) => (l === "done" ? [{ type: "turn_end" }] : []), engineSessionId: () => "thread-9" },
    authHint: (m) => m,
    abort: new AbortController(),
    emit: () => {},
    streamRunner: runner,
  });
  assert.deepEqual(seen, { target, env: { A: "1" } });
  assert.equal(result.engineSessionId, "thread-9");
  assert.equal(fs.existsSync(tmp), false);
});

test("runTurn still returns its result and deletes the other temp files when one delete throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-turn-undeletable-"));
  fs.writeFileSync(path.join(dir, "inner.txt"), "x"); // rmSync without recursive throws on a non-empty directory
  const second = path.join(os.tmpdir(), `sv-turn-second-${Date.now()}.txt`);
  fs.writeFileSync(second, "prompt");
  const runner = (async (_args, _stdin, opts) => {
    opts.onLine("done");
    return { code: 0, stderr: "" };
  }) as ClaudeStreamRunner;
  const result = await runTurn({
    spec: { label: "codex CLI", args: [], stdin: "x", cwd: "C:\\vault", tempFiles: [dir, second] },
    parser: { parse: (l) => (l === "done" ? [{ type: "turn_end", cost_usd: 0.5 }] : []), engineSessionId: () => "thread-1" },
    authHint: (m) => m,
    abort: new AbortController(),
    emit: () => {},
    streamRunner: runner,
  });
  assert.equal(result.costUsd, 0.5);
  assert.equal(result.engineSessionId, "thread-1");
  assert.equal(fs.existsSync(second), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
