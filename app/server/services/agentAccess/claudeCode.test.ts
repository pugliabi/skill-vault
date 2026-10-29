import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeRunner } from "../claude/cli.ts";
import { ClaudeCodeError, REMOVE_ARGS, addArgs, connectClaudeCode, disconnectClaudeCode, readClaudeCodeEntry } from "./claudeCode.ts";

const ours = { type: "stdio", command: "node", args: ["C:/a/dist/assistant-mcp.js", "--client", "claude-code"] };
const foreign = { type: "stdio", command: "npx", args: ["other"] };

function runner(results: Array<{ code: number; stderr?: string }> = []): ClaudeRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const queue = results.slice();
  const r = (async (args: string[]) => {
    calls.push(args);
    const next = queue.shift() ?? { code: 0 };
    return { stdout: "", stderr: next.stderr ?? "", code: next.code };
  }) as unknown as ClaudeRunner & { calls: string[][] };
  r.calls = calls;
  return r;
}

test("addArgs registers the bridge at user scope", () => {
  assert.deepEqual(addArgs("N", "B"), ["mcp", "add", "--scope", "user", "skill-vault", "--", "N", "B", "--client", "claude-code"]);
  assert.deepEqual(REMOVE_ARGS, ["mcp", "remove", "--scope", "user", "skill-vault"]);
});

test("connect adds when missing, and replaces our own entry", async () => {
  const fresh = runner();
  await connectClaudeCode("N", "B", undefined, fresh);
  assert.deepEqual(fresh.calls, [addArgs("N", "B")]);

  const again = runner();
  await connectClaudeCode("N", "B", ours, again);
  assert.deepEqual(again.calls, [REMOVE_ARGS, addArgs("N", "B")]);
});

test("connect refuses a foreign entry and reports CLI failures", async () => {
  const r = runner();
  await assert.rejects(connectClaudeCode("N", "B", foreign, r), ClaudeCodeError);
  assert.deepEqual(r.calls, []);

  const failing = runner([{ code: 1, stderr: "boom" }]);
  await assert.rejects(connectClaudeCode("N", "B", undefined, failing), (e: unknown) => e instanceof ClaudeCodeError && /boom/.test(e.message));

  const missing = (async () => {
    throw new Error("spawn claude ENOENT");
  }) as unknown as ClaudeRunner;
  await assert.rejects(connectClaudeCode("N", "B", undefined, missing), (e: unknown) => e instanceof ClaudeCodeError && /claude CLI/.test(e.message));
});

test("disconnect removes only our entry", async () => {
  const r = runner();
  await disconnectClaudeCode(ours, r);
  await disconnectClaudeCode(foreign, r);
  await disconnectClaudeCode(undefined, r);
  assert.deepEqual(r.calls, [REMOVE_ARGS]);
});

test("readClaudeCodeEntry reads the user-scope entry and tolerates a missing or broken file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-cc-"));
  try {
    const f = path.join(dir, ".claude.json");
    assert.equal(readClaudeCodeEntry(f), undefined);
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { "skill-vault": ours }, projects: {} }));
    assert.deepEqual(readClaudeCodeEntry(f), ours);
    fs.writeFileSync(f, "{");
    assert.equal(readClaudeCodeEntry(f), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
