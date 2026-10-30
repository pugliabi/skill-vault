import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.ts";
import { createEngineStates } from "./state.ts";
import { fakeEngine } from "./testFakes.ts";
import type { AssistantEngine } from "./types.ts";

test("view: installed, signed in, never the key itself", async () => {
  const states = createEngineStates({
    registry: createRegistry([fakeEngine()]),
    readBlock: () => ({ engine: "codex", engines: { codex: { auth: "api_key", api_key: "sk-secret" } } }),
    env: { FAKE_KEY: "x" },
  });
  const v = await states.view("codex");
  assert.ok(v);
  assert.equal(v.selected, true);
  assert.equal(v.version, "codex-cli 1.0.0");
  assert.deepEqual(v.auth, { mode: "api_key", signed_in: true, account: "me", has_saved_key: true, env_key_present: true });
  assert.deepEqual(v.install, [{ label: "Install Fake", display: "npm install -g fake", source: "npmjs.com" }]);
  assert.ok(!JSON.stringify(v).includes("sk-secret"));
});

test("view is cached for 30 s unless refreshed; invalidate drops it", async () => {
  let calls = 0;
  let t = 0;
  const states = createEngineStates({
    registry: createRegistry([fakeEngine({ detect: async () => (calls++, { installed: true, version: "v" }) })]),
    readBlock: () => ({}),
    now: () => t,
  });
  await states.view("codex");
  await states.view("codex");
  assert.equal(calls, 1);
  t = 31_000;
  await states.view("codex");
  assert.equal(calls, 2);
  await states.view("codex", { refresh: true });
  assert.equal(calls, 3);
  states.invalidate("codex");
  await states.view("codex");
  assert.equal(calls, 4);
});

test("view with a mode reports sign-in for that mode, not the saved one", async () => {
  const asked: Array<string | undefined> = [];
  const states = createEngineStates({
    registry: createRegistry([
      fakeEngine({
        authStatus: async (cfg) => (asked.push(cfg.auth), { signed_in: cfg.auth === "login", method: cfg.auth === "api_key" ? "api_key" : "login" }),
      }),
    ]),
    readBlock: () => ({ engines: { codex: { auth: "api_key", api_key: "k" } } }),
    env: {},
  });
  assert.equal((await states.view("codex"))?.auth.mode, "api_key");
  const asLogin = await states.view("codex", { mode: "login" });
  assert.equal(asLogin?.auth.mode, "login");
  assert.equal(asLogin?.auth.signed_in, true);
  assert.deepEqual(asked, ["api_key", "login"]);
});

test("ready: not installed / signed out / no key / unknown signed-in state", async () => {
  const make = (over: Partial<AssistantEngine>, block = {}) =>
    createEngineStates({ registry: createRegistry([fakeEngine(over)]), readBlock: () => block, env: {} });
  assert.match(((await make({ detect: async () => ({ installed: false }) }).ready("codex")) as { reason: string }).reason, /isn't installed/);
  assert.match(((await make({ authStatus: async () => ({ signed_in: false, method: "login" }) }).ready("codex")) as { reason: string }).reason, /isn't signed in/);
  assert.match(((await make({}, { engines: { codex: { auth: "api_key" } } }).ready("codex")) as { reason: string }).reason, /no API key/);
  assert.deepEqual(await make({ authStatus: async () => ({ signed_in: null, method: "login" }) }).ready("codex"), { ok: true });
  // "grok" is a real EngineId, but this registry doesn't hold it.
  assert.match(((await make({}).ready("grok")) as { reason: string }).reason, /isn't available/);
});
