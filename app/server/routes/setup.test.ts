import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Router } from "express";

// setup.ts imports appConfig.ts (config path fixed at import time): point HOME at
// a temp folder BEFORE the first import so nothing here can touch ~/.skill-vault.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-home-"));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;

type SetupModule = typeof import("./setup.ts");
let setup: SetupModule;
const servers: Array<() => Promise<void>> = [];

before(async () => {
  setup = await import("./setup.ts");
});
after(async () => {
  for (const close of servers) await close();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

async function serve(router: Router): Promise<string> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/setup", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/setup`;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("capabilities: folder dialog only on Windows from this PC", async () => {
  const win = await serve(setup.setupRouter({ platform: "win32" }));
  assert.deepEqual(await (await fetch(`${win}/capabilities`)).json(), { folder_dialog: true });
  const linux = await serve(setup.setupRouter({ platform: "linux" }));
  assert.deepEqual(await (await fetch(`${linux}/capabilities`)).json(), { folder_dialog: false });
});

test("writes from another site are refused", async () => {
  const base = await serve(setup.setupRouter({ platform: "win32" }));
  const res = await fetch(`${base}/anything`, { method: "POST", headers: { Origin: "http://evil.example" } });
  assert.equal(res.status, 403);
});

const sampleBase = {
  vault_path: null as string | null,
  agent_locations: {} as Record<string, string>,
  default_targets: [] as string[],
  machine_id: "PC1",
  repo_url: null as string | null,
};

test("draft: start, save, read, stale, delete", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-d-"));
  let base = { ...sampleBase };
  const url = await serve(setup.setupRouter({ home: () => home, readBase: () => base }));

  assert.deepEqual(await (await fetch(`${url}/draft`)).json(), { draft: null, stale: false });

  const { draft } = await (await fetch(`${url}/draft/start`, { method: "POST" })).json();
  assert.equal(draft.machine_id, "PC1");
  assert.equal(draft.vault, null);

  const saved = await fetch(`${url}/draft`, { ...json({ ...draft, step: "targets", extra: 1 }), method: "PUT" });
  assert.equal(saved.status, 200);
  const read = await (await fetch(`${url}/draft`)).json();
  assert.equal(read.draft.step, "targets");
  assert.equal(read.stale, false);
  assert.ok(!("extra" in read.draft));

  base = { ...sampleBase, vault_path: "C:\\elsewhere" };
  assert.equal((await (await fetch(`${url}/draft`)).json()).stale, true);

  const bad = await fetch(`${url}/draft`, { ...json({ version: 9 }), method: "PUT" });
  assert.equal(bad.status, 400);

  assert.equal((await fetch(`${url}/draft`, { method: "DELETE" })).status, 204);
  assert.equal((await (await fetch(`${url}/draft`)).json()).draft, null);
  fs.rmSync(home, { recursive: true, force: true });
});

test("inspect: needs a path, then describes the folder", async () => {
  const notGit = async () => ({ code: 128, stdout: "", stderr: "" });
  const url = await serve(setup.setupRouter({ run: notGit }));
  assert.equal((await fetch(`${url}/inspect`, json({}))).status, 400);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-i-"));
  const info = await (await fetch(`${url}/inspect`, json({ path: dir }))).json();
  assert.equal(info.kind, "empty");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("targets: lists the known tools for the injected home", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-setup-t-"));
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  const url = await serve(
    setup.setupRouter({ home: () => home, readConfig: () => ({ vault_path: null, providers: [], default_targets: [] }) }),
  );
  const { targets } = await (await fetch(`${url}/targets`)).json();
  assert.equal(targets[0].id, "claude");
  assert.equal(targets[0].status, "found");
  fs.rmSync(home, { recursive: true, force: true });
});

test("clone-preview: only git URLs are accepted", async () => {
  const url = await serve(setup.setupRouter({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }));
  const res = await fetch(`${url}/clone-preview`, json({ url: "C:\\repo" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /https:\/\/, ssh:\/\/ or git@/);
});

test("clone-preview: a git failure is a 400 with a plain message", async () => {
  const failing = async () => ({ code: 128, stdout: "", stderr: "remote: Repository not found." });
  const url = await serve(setup.setupRouter({ run: failing }));
  const res = await fetch(`${url}/clone-preview`, json({ url: "https://github.com/me/nope.git" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /wasn't found/);
});

test("plan: needs a vault in the draft", async () => {
  const { startDraft } = await import("../services/setup/draft.ts");
  const url = await serve(setup.setupRouter({ readConfig: () => ({ vault_path: null, providers: [], default_targets: [] }) }));
  const draft = startDraft({ vault_path: null, agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  assert.equal((await fetch(`${url}/plan`, json({ draft }))).status, 400);
  const withVault = { ...draft, vault: { mode: "new", path: path.join(os.tmpdir(), "sv-none-xyz") } };
  const plan = await (await fetch(`${url}/plan`, json({ draft: withVault }))).json();
  assert.deepEqual(plan, { adopt: [], adopt_conflicts: [], push: [], differs: [] });
});

type SetupApplier = import("../services/setup/apply.ts").SetupApplier;
type SetupJobState = import("../services/setup/apply.ts").SetupJobState;

function fakeApplier(over: Partial<SetupApplier> = {}): SetupApplier {
  const idle: SetupJobState = { running: false, ok: null, vault_path: null, events: [], failed: [] };
  return {
    isRunning: () => false,
    status: () => idle,
    apply: async (_req, onEvent) => {
      onEvent({ step: "vault", state: "start" });
      onEvent({ step: "done", state: "done", message: "Setup finished" });
      return { ...idle, ok: true };
    },
    retry: async () => idle,
    ...over,
  };
}

test("apply: streams NDJSON events; 400 for a bad draft; 409 while running", async () => {
  const { startDraft } = await import("../services/setup/draft.ts");
  const draft = startDraft({ vault_path: "C:\\v", agent_locations: {}, default_targets: [], machine_id: null, repo_url: null });
  const url = await serve(setup.setupRouter({ applier: fakeApplier() }));
  const res = await fetch(`${url}/apply`, json({ draft, api_key: "sk-x" }));
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.step), ["vault", "done"]);

  assert.equal((await fetch(`${url}/apply`, json({ draft: { version: 7 } }))).status, 400);

  const busy = await serve(setup.setupRouter({ applier: fakeApplier({ isRunning: () => true }) }));
  assert.equal((await fetch(`${busy}/apply`, json({ draft }))).status, 409);
  assert.deepEqual(await (await fetch(`${url}/apply/status`)).json(), { running: false, ok: null, vault_path: null, events: [], failed: [] });
});

test("pick-folder: only on Windows, only from this PC, one at a time", async () => {
  const picker = { isOpen: () => false, pick: async () => ({ path: "C:\\picked" }) };
  const win = await serve(setup.setupRouter({ platform: "win32", picker }));
  assert.deepEqual(await (await fetch(`${win}/pick-folder`, json({ title: "Vault" }))).json(), { path: "C:\\picked" });

  const linux = await serve(setup.setupRouter({ platform: "linux", picker }));
  assert.equal((await fetch(`${linux}/pick-folder`, json({}))).status, 403);

  const { PickerBusyError } = await import("../services/setup/folderDialog.ts");
  const busy = await serve(setup.setupRouter({ platform: "win32", picker: { isOpen: () => true, pick: async () => { throw new PickerBusyError("open"); } } }));
  assert.equal((await fetch(`${busy}/pick-folder`, json({}))).status, 409);

  const none = await serve(setup.setupRouter({ platform: "win32" }));
  assert.equal((await fetch(`${none}/pick-folder`, json({}))).status, 503);
});
