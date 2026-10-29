import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { isLoopbackRequest, isOwnOrigin, refuseCrossSiteWrites } from "./sameOrigin.ts";

let server: Server;
let port: number;

before(async () => {
  const app = express();
  app.use(refuseCrossSiteWrites);
  app.all("/x", (req, res) => res.json({ ok: true, loopback: isLoopbackRequest(req) }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function call(method: string, headers: Record<string, string>): Promise<{ status: number; body: { loopback?: boolean } }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/x", method, headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || "{}") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("isOwnOrigin matches only this host", () => {
  assert.equal(isOwnOrigin("http://127.0.0.1:9994", "127.0.0.1:9994"), true);
  assert.equal(isOwnOrigin("http://evil.example", "127.0.0.1:9994"), false);
  assert.equal(isOwnOrigin("null", "127.0.0.1:9994"), false);
});

test("writes from another site are refused; reads and header-less writes pass", async () => {
  assert.equal((await call("POST", { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await call("PUT", { Origin: "http://evil.example" })).status, 403);
  assert.equal((await call("DELETE", { Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await call("POST", {})).status, 200);
  assert.equal((await call("GET", { "Sec-Fetch-Site": "cross-site" })).status, 200);
});

test("isLoopbackRequest needs a loopback socket and a loopback Host", async () => {
  assert.equal((await call("GET", {})).body.loopback, true);
  assert.equal((await call("GET", { Host: "evil.example" })).body.loopback, false);
  assert.equal((await call("GET", { Host: `localhost:${port}` })).body.loopback, true);
});
