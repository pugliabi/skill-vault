import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { BridgeHttp } from "./bridge.ts";
import { defaultClient, listTools, missingTool, parseBridgeArgs, readStdinWithin, runCommand } from "./cli.ts";

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

test("parseBridgeArgs reads --client, --file and the first positional", () => {
  assert.deepEqual(parseBridgeArgs([], "assistant"), { client: "assistant", command: null, file: null });
  assert.deepEqual(parseBridgeArgs(["--client", "claude-desktop"], "agent"), { client: "claude-desktop", command: null, file: null });
  assert.deepEqual(parseBridgeArgs(["--client=command", "list_skills", "extra"], "agent"), { client: "command", command: "list_skills", file: null });
  assert.deepEqual(parseBridgeArgs(["save_skill", "--file", "args.json"], "agent"), { client: "agent", command: "save_skill", file: "args.json" });
  assert.deepEqual(parseBridgeArgs(["--file=a b.json", "save_skill"], "agent"), { client: "agent", command: "save_skill", file: "a b.json" });
});

/** Run the real bridge with stdin held open, so one that falls into MCP mode hangs instead of exiting. */
function runBridge(argv: string[]): Promise<{ code: number | null; stdout: string; hung: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "server/assistant-mcp/main.ts", ...argv], {
      env: { ...process.env, SKILL_VAULT_URL: "http://127.0.0.1:9" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let hung = false;
    child.stdout.on("data", (d) => (stdout += d));
    const timer = setTimeout(() => {
      hung = true;
      child.kill();
    }, 8_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, hung });
    });
  });
}

for (const argv of [["--file", "args.json"], ["--client", "command"]]) {
  test(`${argv.join(" ")} with no tool prints usage instead of waiting as an MCP server`, async () => {
    const r = await runBridge(argv);
    assert.equal(r.hung, false);
    assert.equal(r.code, 1);
    assert.match((JSON.parse(r.stdout) as { error: string }).error, /usage: skill-vault/);
  });
}

test("a real MCP client (any --client but command, no --file) still gets MCP mode", () => {
  assert.equal(missingTool(parseBridgeArgs(["--client", "claude-desktop"], "agent")), false);
  assert.equal(missingTool(parseBridgeArgs([], "agent")), false);
  assert.equal(missingTool(parseBridgeArgs(["--client", "command", "tools"], "agent")), false);
});

test("without --client the bridge is the assistant only when SKILL_VAULT_URL is set", () => {
  assert.equal(defaultClient({ SKILL_VAULT_URL: "http://127.0.0.1:5173" }), "assistant");
  assert.equal(defaultClient({}), "agent");
  assert.equal(parseBridgeArgs([], defaultClient({})).client, "agent");
  assert.equal(parseBridgeArgs(["--client", "claude-code"], defaultClient({})).client, "claude-code");
});

test("runCommand reads --file as UTF-8, UTF-8 with a BOM, or UTF-16LE with a BOM", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-cli-"));
  try {
    const json = '{"query":"café ✓"}';
    const files: Array<[string, Buffer]> = [
      ["utf8.json", Buffer.from(json, "utf-8")],
      ["utf8-bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf-8")])],
      ["utf16le-bom.json", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")])],
    ];
    for (const [name, bytes] of files) {
      fs.writeFileSync(path.join(dir, name), bytes);
      const http = httpReturning({ matches: [] });
      const r = await runCommand("search_skills", { file: path.join(dir, name) }, http, noSleep);
      assert.deepEqual(r, { code: 0, out: { matches: [] } }, name);
      assert.equal((http.calls[0] as { path: string }).path, `/api/skills/search?q=${encodeURIComponent("café ✓")}`, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand reports a missing --file as a JSON error with exit code 1", async () => {
  const http = httpReturning({});
  const r = await runCommand("search_skills", { file: path.join(os.tmpdir(), "sv-cli-missing", "args.json") }, http, noSleep);
  assert.equal(r.code, 1);
  assert.match((r.out as { error: string }).error, /--file/);
  assert.deepEqual(http.calls, []);
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
