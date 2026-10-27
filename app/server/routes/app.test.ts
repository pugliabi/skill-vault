import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { appRouter, type HealthInfo } from "./app.ts";
import type { AppUpdateStatus, AppUpdater } from "../services/appUpdate.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(router: express.Router): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const HEALTH: HealthInfo = { ok: true, pid: 42, port: 9994, version: "abc1234", mode: "production" };
const STATUS: AppUpdateStatus = {
  supported: true,
  branch: "main",
  current: "aaaaaaa",
  latest: "bbbbbbb",
  behind: 1,
  ahead: 0,
  dirty: false,
  commits: [{ sha: "bbbbbbb", subject: "New thing" }],
  checked_at: "2026-10-27T12:00:00.000Z",
  can_apply: true,
  applying: false,
};
const stubUpdater = (): AppUpdater => ({
  status: () => STATUS,
  check: async () => ({ ...STATUS, checked_at: "2026-10-27T13:00:00.000Z" }),
  isApplying: () => false,
  start() {},
  stop() {},
  apply: async (onEvent) => {
    onEvent({ step: "pull", state: "start" });
    onEvent({ step: "pull", state: "done" });
    onEvent({ step: "restart", state: "start" });
    return true;
  },
});

test("GET /api/health returns the server's identity", async () => {
  const base = await serve(appRouter({ health: () => HEALTH, updater: stubUpdater() }));
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), HEALTH);
});

test("GET /api/app/update returns the status; POST /check re-checks", async () => {
  const base = await serve(appRouter({ health: () => HEALTH, updater: stubUpdater() }));
  assert.deepEqual(await (await fetch(`${base}/api/app/update`)).json(), STATUS);
  const checked = await (await fetch(`${base}/api/app/update/check`, { method: "POST" })).json();
  assert.equal(checked.checked_at, "2026-10-27T13:00:00.000Z");
});

test("POST /api/app/update streams one JSON event per line", async () => {
  const base = await serve(appRouter({ health: () => HEALTH, updater: stubUpdater() }));
  const res = await fetch(`${base}/api/app/update`, { method: "POST" });
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => `${e.step}:${e.state}`), ["pull:start", "pull:done", "restart:start"]);
});
