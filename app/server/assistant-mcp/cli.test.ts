import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { BridgeHttp } from "./bridge.ts";
import { listTools, parseBridgeArgs, readStdinWithin, runCommand } from "./cli.ts";

const noSleep = async (): Promise<void> => {};
const httpReturning = (json: unknown, status = 200): BridgeHttp & { calls: unknown[] } => {
  const calls: unknown[] = [];
  const http = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return { status, json };
  }) as BridgeHttp & { calls: unknown[] };
  http.calls = calls;
  return http;
};

test("parseBridgeArgs reads --client and the first positional", () => {
  assert.deepEqual(parseBridgeArgs([]), { client: "assistant", command: null });
  assert.deepEqual(parseBridgeArgs(["--client", "claude-desktop"]), { client: "claude-desktop", command: null });
  assert.deepEqual(parseBridgeArgs(["--client=command", "list_skills", "extra"]), { client: "command", command: "list_skills" });
});

test("listTools gives every tool a JSON schema", () => {
  const tools = listTools();
  const save = tools.find((t) => t.name === "save_skill");
  assert.ok(save);
  const schema = save.input_schema as { type: string; properties: Record<string, unknown>; required: string[] };
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["files", "mode", "name"]);
  assert.deepEqual(schema.required.sort(), ["files", "mode", "name"]);
});

test("runCommand runs a tool with JSON args from stdin", async () => {
  const http = httpReturning({ matches: [] });
  const r = await runCommand("search_skills", '{"query":"pdf"}', http, noSleep);
  assert.deepEqual(r, { code: 0, out: { matches: [] } });
  assert.deepEqual(http.calls, [{ method: "GET", path: "/api/skills/search?q=pdf", body: undefined }]);
});

test("runCommand treats empty stdin as no arguments", async () => {
  const r = await runCommand("get_config", "  \n", httpReturning({ vault_path: "v" }), noSleep);
  assert.deepEqual(r, { code: 0, out: { vault_path: "v" } });
});

test("runCommand ignores a leading byte-order mark on stdin", async () => {
  const http = httpReturning({ matches: [] });
  const r = await runCommand("search_skills", '﻿{"query":"pdf"}', http, noSleep);
  assert.deepEqual(r, { code: 0, out: { matches: [] } });
  assert.equal((http.calls[0] as { path: string }).path, "/api/skills/search?q=pdf");
});

test("runCommand reports unknown tools, bad JSON, invalid args and tool errors with exit code 1", async () => {
  const http = httpReturning({ error: "nope" }, 500);
  assert.match(((await runCommand("nope", "", http, noSleep)).out as { error: string }).error, /unknown tool/);
  assert.match(((await runCommand("get_skill", "{", http, noSleep)).out as { error: string }).error, /must be JSON/);
  const invalid = await runCommand("get_skill", "{}", http, noSleep);
  assert.equal(invalid.code, 1);
  assert.match((invalid.out as { error: string }).error, /invalid arguments for get_skill: name/);
  const failed = await runCommand("get_skill", '{"name":"x"}', http, noSleep);
  assert.equal(failed.code, 1);
  assert.match((failed.out as { error: string }).error, /get_skill failed \(500\): nope/);
});

test("runCommand treats Object.prototype names as unknown tools", async () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const r = await runCommand(name, "", httpReturning({}), noSleep);
    assert.equal(r.code, 1);
    assert.match((r.out as { error: string }).error, /unknown tool/);
  }
});

test("runCommand tools lists the tools", async () => {
  const r = await runCommand("tools", "", httpReturning({}), noSleep);
  assert.equal(r.code, 0);
  assert.ok((r.out as Array<{ name: string }>).some((t) => t.name === "read_skill_files"));
});

test("readStdinWithin returns piped input, or empty when nothing arrives in time", async () => {
  const piped = new PassThrough();
  const p = readStdinWithin(piped, 1_000);
  piped.end('{"a":1}');
  assert.equal(await p, '{"a":1}');

  const silent = new PassThrough();
  assert.equal(await readStdinWithin(silent, 20), "");
});
