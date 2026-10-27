import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import { appRouter, type HealthInfo } from "./app.ts";

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

test("GET /api/health returns the server's identity", async () => {
  const base = await serve(appRouter({ health: () => HEALTH }));
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), HEALTH);
});
