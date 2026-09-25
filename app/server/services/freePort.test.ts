import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { findFreePort } from "./freePort.ts";

function occupyPort(port: number, host?: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    if (host) {
      server.listen(port, host, () => resolve(server));
    } else {
      server.listen(port, () => resolve(server));
    }
  });
}

test("findFreePort returns the start port when it is free", async () => {
  const port = await findFreePort(24999, 5);
  assert.equal(port, 24999);
});

test("findFreePort skips a port that is already in use", async () => {
  const occupied = await occupyPort(25010);
  try {
    const port = await findFreePort(25010, 5);
    assert.notEqual(port, 25010);
    assert.ok(port > 25010);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("findFreePort skips a port bound on all interfaces (matches how Vite's HMR server binds)", async () => {
  const occupied = await occupyPort(25020);
  try {
    const port = await findFreePort(25020, 5);
    assert.notEqual(port, 25020);
    assert.ok(port > 25020);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});
