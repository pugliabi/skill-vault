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

test("status: a provider that isn't installed reports its own reason", async () => {
  const notInstalled = fakes.fakeEngine({ detect: async () => ({ installed: false, reason: "codex --version failed" }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([notInstalled]) }));
  await fetch(`${base}/engine`, send("PUT", { engine: "codex" }));
  const s = (await (await fetch(`${base}/status`)).json()) as { available: boolean; reason?: string };
  assert.equal(s.available, false);
  assert.match(s.reason ?? "", /Fake Codex isn't installed \(codex --version failed\)/);
});

test("writes from another site are refused", async () => {
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]) }));
  const res = await fetch(`${base}/engine`, { ...send("PUT", { engine: "codex" }), headers: { "content-type": "application/json", Origin: "http://evil.example" } });
  assert.equal(res.status, 403);
});

test("install: streams the engine's own steps and a done line; one at a time", async () => {
  const { createInstaller } = await import("../services/assistant/engines/install.ts");
  const { createEngineJobs } = await import("../services/assistant/engines/jobs.ts");
  let release!: () => void;
  const gate = new Promise<number>((r) => (release = () => r(0)));
  const seen: string[][] = [];
  const installer = createInstaller({
    platform: "win32",
    npmPath: () => "npm.cmd",
    spawnLines: (_c, args, _o, onLine) => {
      seen.push(args);
      onLine("working");
      return { done: gate, kill: () => {} };
    },
  });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs: createEngineJobs({ installer }) }));
  const first = fetch(`${base}/engines/codex/install`, send("POST", { args: ["evil"] }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(`${base}/engines/codex/install`, send("POST", {}))).status, 409);
  release();
  const lines = (await (await first).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["step", "line", "done"]);
  assert.equal(lines.at(-1).ok, true);
  assert.ok(!seen.flat().join(" ").includes("evil"), "commands never come from the request");
});

test("install: a throwing installer still ends the stream with one done line", async () => {
  const { createEngineJobs } = await import("../services/assistant/engines/jobs.ts");
  const installer = { isRunning: () => false, stop: () => {}, run: async () => { throw new Error("spawn exploded"); } };
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs: createEngineJobs({ installer }) }));
  const lines = (await (await fetch(`${base}/engines/codex/install`, send("POST", {}))).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ type: "done", ok: false, message: "spawn exploded" }]);
});

/** A sign-in manager whose window is recorded instead of opened; exit(code) is the login command ending. */
async function signInHarness(over: { openWindow?: () => { close(): void; isOpen(): boolean } | { error: string } } = {}) {
  const { createSignInManager } = await import("../services/assistant/engines/signIn.ts");
  const { createEngineJobs } = await import("../services/assistant/engines/jobs.ts");
  const win = { opened: 0, closed: 0, open: false, code: null as number | null };
  const signIn = createSignInManager({
    platform: "win32",
    openWindow:
      over.openWindow ??
      (() => {
        win.opened++;
        win.open = true;
        win.code = null;
        return {
          isOpen: () => win.open,
          close: () => void (win.open = false, win.closed++),
          exitCode: () => (win.open ? null : win.code),
        };
      }),
    setTimer: () => ({ cancel: () => {} }),
  });
  const exit = (code: number) => {
    win.open = false;
    win.code = code;
  };
  return { win, exit, jobs: createEngineJobs({ signIn }) };
}

test("login: opens the window, and the window closes once the engine reports signed in", async () => {
  let signedIn = false;
  const { win, jobs } = await signInHarness();
  const engine = fakes.fakeEngine({ authStatus: async () => ({ signed_in: signedIn, method: "login" }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([engine]), jobs }));
  assert.deepEqual(await (await fetch(`${base}/engines/codex/login`, send("POST", {}))).json(), {
    started: true,
    hint: "Do the thing.",
    already_signed_in: false,
  });
  assert.equal(win.opened, 1);
  const waiting = (await (await fetch(`${base}/engines/codex?refresh=1`)).json()) as { sign_in: unknown };
  assert.deepEqual(waiting.sign_in, { open: true, exit_code: null, already_signed_in: false });
  assert.equal(win.closed, 0);
  signedIn = true;
  await fetch(`${base}/engines/codex?refresh=1&mode=login`);
  assert.equal(win.closed, 1);
});

test("login when already signed in (Sign in again): signed_in never closes the window; its exit code decides", async () => {
  const { win, exit, jobs } = await signInHarness();
  const engine = fakes.fakeEngine({ authStatus: async () => ({ signed_in: true, method: "login", account: "me" }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([engine]), jobs }));
  const started = (await (await fetch(`${base}/engines/codex/login`, send("POST", {}))).json()) as { already_signed_in: boolean };
  assert.equal(started.already_signed_in, true);
  const poll = async () => ((await (await fetch(`${base}/engines/codex?refresh=1&mode=login`)).json()) as { sign_in: unknown }).sign_in;
  assert.deepEqual(await poll(), { open: true, exit_code: null, already_signed_in: true });
  assert.equal(win.closed, 0, "a signed-in reading doesn't close the window mid-login");
  exit(0);
  assert.deepEqual(await poll(), { open: false, exit_code: 0, already_signed_in: true }, "exit 0: finished");
  assert.equal(win.closed, 0);

  await fetch(`${base}/engines/codex/login`, send("POST", {}));
  exit(1);
  assert.deepEqual(await poll(), { open: false, exit_code: 1, already_signed_in: true }, "exit 1: reported as failed");
});

test("login/cancel closes the window", async () => {
  const { win, jobs } = await signInHarness();
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs }));
  await fetch(`${base}/engines/codex/login`, send("POST", {}));
  assert.equal(jobs.signIn.pending(), true);
  assert.deepEqual(await (await fetch(`${base}/engines/codex/login/cancel`, send("POST", {}))).json(), { ok: true });
  assert.equal(win.closed, 1);
  assert.equal(jobs.signIn.pending(), false);
});

test("login/cancel for another provider leaves the open window alone", async () => {
  const { win, jobs } = await signInHarness();
  const registry = reg.createRegistry([fakes.fakeEngine(), fakes.fakeEngine({ id: "copilot", label: "Fake Copilot" })]);
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry, jobs }));
  await fetch(`${base}/engines/codex/login`, send("POST", {}));
  assert.deepEqual(await (await fetch(`${base}/engines/copilot/login/cancel`, send("POST", {}))).json(), { ok: true });
  assert.equal(win.closed, 0);
  assert.equal(jobs.signIn.current(), "codex");
  assert.equal((await fetch(`${base}/engines/bard/login/cancel`, send("POST", {}))).status, 404);
});

test("login: a request whose Host isn't this PC gets 403 and no window", async () => {
  const { win, jobs } = await signInHarness();
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs }));
  // fetch can't set Host; a raw request can.
  const http = (await import("node:http")).default;
  const u = new URL(`${base}/engines/codex/login`);
  const res = await new Promise<{ status: number; body: { error?: string } }>((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { Host: "evil.example", "content-type": "application/json" } },
      (r) => {
        let data = "";
        r.on("data", (d) => (data += d));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(data || "{}") }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(res.status, 403);
  assert.match(res.body.error ?? "", /only be started from this PC/);
  assert.equal(win.opened, 0);
});

test("login: a window that fails to open answers 500 with the reason", async () => {
  const { jobs } = await signInHarness({ openWindow: () => ({ error: "Couldn't open the sign-in window: powershell.exe didn't start." }) });
  const base = await serve(mod.assistantRouter({ mode: "development", appRoot: APP_ROOT, registry: reg.createRegistry([fakes.fakeEngine()]), jobs }));
  const res = await fetch(`${base}/engines/codex/login`, send("POST", {}));
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /powershell\.exe didn't start/);
  assert.equal(jobs.signIn.pending(), false);
});
