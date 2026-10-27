import { test } from "node:test";
import assert from "node:assert/strict";
import { createIdleTracker, startIdleStop } from "./idleStop.ts";

test("before any window connects, it waits bootGraceMs", () => {
  let t = 0;
  const tr = createIdleTracker({ clients: () => 0, isBusy: () => false, graceMs: 60, bootGraceMs: 120, now: () => t });
  t = 119;
  assert.equal(tr.tick(), false);
  t = 120;
  assert.equal(tr.tick(), true);
});

test("after a window connected, it stops graceMs after the last one leaves", () => {
  let t = 0;
  let clients = 1;
  const tr = createIdleTracker({ clients: () => clients, isBusy: () => false, graceMs: 60, bootGraceMs: 120, now: () => t });
  assert.equal(tr.tick(), false);
  t = 40;
  assert.equal(tr.tick(), false);
  clients = 0;
  t = 99;
  assert.equal(tr.tick(), false);
  t = 100;
  assert.equal(tr.tick(), true);
});

test("a busy server is never idle, and the clock restarts when the work ends", () => {
  let t = 0;
  let busy = true;
  const tr = createIdleTracker({ clients: () => 0, isBusy: () => busy, graceMs: 60, bootGraceMs: 120, now: () => t });
  t = 500;
  assert.equal(tr.tick(), false);
  busy = false;
  t = 619;
  assert.equal(tr.tick(), false);
  t = 620;
  assert.equal(tr.tick(), true);
});

test("startIdleStop calls onIdle exactly once", async () => {
  let calls = 0;
  const s = startIdleStop({ clients: () => 0, isBusy: () => false, graceMs: 0, bootGraceMs: 0, tickMs: 5, onIdle: () => calls++ });
  await new Promise((r) => setTimeout(r, 40));
  s.stop();
  assert.equal(calls, 1);
});
