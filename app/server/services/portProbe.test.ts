import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { isPortFree } from "./portProbe.ts";

/** Listen on host:0 and return the server and the port it got. */
async function occupy(host: string): Promise<{ server: net.Server; port: number } | null> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => resolve());
    });
  } catch {
    return null; // e.g. no IPv6 on this machine
  }
  return { server, port: (server.address() as net.AddressInfo).port };
}

const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));

test("a free port is free", async () => {
  const held = await occupy("127.0.0.1");
  assert.ok(held);
  const { port } = held;
  await close(held.server);
  assert.equal(await isPortFree(port, "127.0.0.1"), true);
});

test("a port another program holds on the same loopback address is busy", async () => {
  const held = await occupy("127.0.0.1");
  assert.ok(held);
  try {
    assert.equal(await isPortFree(held.port, "127.0.0.1"), false);
  } finally {
    await close(held.server);
  }
});

test("a loopback port is busy when another program listens on 0.0.0.0 (Windows lets both bind)", async () => {
  const held = await occupy("0.0.0.0");
  assert.ok(held);
  try {
    assert.equal(await isPortFree(held.port, "127.0.0.1"), false);
    assert.equal(await isPortFree(held.port, "localhost"), false);
  } finally {
    await close(held.server);
  }
});

test("a loopback port is busy when another program listens on [::]", async (t) => {
  const held = await occupy("::");
  if (!held) return t.skip("no IPv6 on this machine");
  try {
    assert.equal(await isPortFree(held.port, "127.0.0.1"), false);
  } finally {
    await close(held.server);
  }
});

test("port 0 (let the OS pick) always counts as free", async () => {
  assert.equal(await isPortFree(0, "127.0.0.1"), true);
});
