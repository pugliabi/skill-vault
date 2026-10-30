import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Router } from "express";

// appConfig.ts fixes its config path at import time: point HOME at a temp folder first.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-assistant-route-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
fs.mkdirSync(path.join(fakeHome, "vault"), { recursive: true });
fs.writeFileSync(path.join(fakeHome, ".skill-vault", "config.json"), JSON.stringify({ vault_path: path.join(fakeHome, "vault") }));

const APP_ROOT = path.resolve(import.meta.dirname, "..", "..");
let mod: typeof import("./assistant.ts");
let reg: typeof import("../services/assistant/engines/registry.ts");
let fakes: typeof import("../services/assistant/engines/testFakes.ts");
const servers: Array<() => Promise<void>> = [];

before(async () => {
  mod = await import("./assistant.ts");
  reg = await import("../services/assistant/engines/registry.ts");
  fakes = await import("../services/assistant/engines/testFakes.ts");
  (await import("../services/runtime.ts")).setServerPort(4321);
});
after(async () => {
  for (const close of servers) await close();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function serve(router: Router): Promise<string> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/assistant", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant`;
}

const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const savedAssistant = () => JSON.parse(fs.readFileSync(path.join(fakeHome, ".skill-vault", "config.json"), "utf-8")).assistant;

test("engines: list, select, save a key that is never echoed", async () => {
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]) }));
  const list = (await (await fetch(`${base}/engines`)).json()) as { engines: Array<{ id: string; selected: boolean }> };
  assert.deepEqual(list.engines.map((e) => e.id), ["codex"]);
  assert.equal((await fetch(`${base}/engine`, send("PUT", { engine: "bard" }))).status, 400);
  assert.deepEqual(await (await fetch(`${base}/engine`, send("PUT", { engine: "codex" }))).json(), { engine: "codex" });
  const saved = await (await fetch(`${base}/engines/codex/auth`, send("PUT", { auth: "api_key", api_key: "sk-secret" }))).text();
  assert.ok(!saved.includes("sk-secret"));
  assert.match(saved, /"has_saved_key":true/);
  const cfg = JSON.parse(fs.readFileSync(path.join(fakeHome, ".skill-vault", "config.json"), "utf-8"));
  assert.equal(cfg.assistant.engines.codex.api_key, "sk-secret");
  assert.equal(cfg.vault_path, path.join(fakeHome, "vault"));
});

test("engines/claude/auth takes PUT /auth's path: an empty string clears the saved key", async () => {
  const claude = fakes.fakeEngine({ id: "claude", label: "Fake Claude" });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([claude]) }));
  await fetch(`${base}/engines/claude/auth`, send("PUT", { auth: "api_key", api_key: "sk-ant-x", workspace_id: "wrk" }));
  assert.equal(savedAssistant().api_key, "sk-ant-x");
  const res = await fetch(`${base}/engines/claude/auth`, send("PUT", { api_key: "" }));
  assert.equal(res.status, 200);
  assert.equal(savedAssistant().api_key, undefined, '"" clears the key');
  assert.equal(savedAssistant().workspace_id, "wrk", "omitted fields are kept");
  assert.equal(savedAssistant().auth, "api_key");
  assert.equal((await fetch(`${base}/engines/claude/auth`, send("PUT", { api_key: 5 }))).status, 400);
  assert.equal((await fetch(`${base}/auth`, send("PUT", { auth: "token" }))).status, 400);
});

test("stream: an engine that isn't ready gets a 409 JSON error before any NDJSON", async () => {
  const notInstalled = fakes.fakeEngine({ detect: async () => ({ installed: false }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([notInstalled]) }));
  await fetch(`${base}/engine`, send("PUT", { engine: "codex" }));
  const res = await fetch(`${base}/stream`, send("POST", { message: "hi" }));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /Fake Codex isn't installed/);
});

test("writes from another site are refused", async () => {
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]) }));
  const res = await fetch(`${base}/engine`, { ...send("PUT", { engine: "codex" }), headers: { "content-type": "application/json", Origin: "http://evil.example" } });
  assert.equal(res.status, 403);
});
