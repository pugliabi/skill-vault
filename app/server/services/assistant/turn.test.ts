import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TOOLS, HARD_TIMEOUT_MS, IDLE_TIMEOUT_MS, buildTurnArgs, runTurn } from "./turn.ts";
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
  pluginDir: "C:\\app\\assistant-plugin",
  reposDir: "C:\\Github\\skills-repos",
};

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
    "--allowedTools",
    ALLOWED_TOOLS,
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
    spec: { label: "codex CLI", args: [], stdin: "x", cwd: "C:\vault", tempFiles: [dir, second] },
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
