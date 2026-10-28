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
