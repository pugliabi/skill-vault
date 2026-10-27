import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLock,
  buildVersion,
  isProcessAlive,
  lockPath,
  readLock,
  releaseLock,
  type InstanceLock,
} from "./instanceLock.ts";

const lock = (pid: number, port = 9994): InstanceLock => ({
  pid,
  port,
  started_at: "2026-10-27T00:00:00.000Z",
  version: "abc1234",
  mode: "production",
});

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-lock-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
});

test("acquire writes the lock when none exists; release removes only our own", () => {
  assert.equal(acquireLock(lock(111)), true);
  assert.equal(readLock()?.pid, 111);
  releaseLock(222);
  assert.equal(readLock()?.pid, 111, "another pid can't clear it");
  releaseLock(111);
  assert.equal(readLock(), null);
  assert.equal(fs.existsSync(lockPath()), false);
});

test("a lock held by a live process is not taken over", () => {
  acquireLock(lock(111));
  assert.equal(acquireLock(lock(222), () => true), false);
  assert.equal(readLock()?.pid, 111);
});

test("a stale lock (its process is gone) is replaced", () => {
  acquireLock(lock(111));
  assert.equal(acquireLock(lock(222, 9995), () => false), true);
  assert.deepEqual(readLock(), lock(222, 9995));
});

test("an unreadable lock file counts as no lock", () => {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), "{not json");
  assert.equal(readLock(), null);
  assert.equal(acquireLock(lock(111)), true);
});

test("a lock-file write failure is logged and means 'not owned', never a throw", () => {
  // A regular file where the .skill-vault directory should be makes mkdirSync fail.
  fs.writeFileSync(path.join(os.homedir(), ".skill-vault"), "not a directory");
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    assert.equal(acquireLock(lock(111)), false);
    assert.doesNotThrow(() => releaseLock(111));
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[lock\] could not write /);
});

test("isProcessAlive is true for this process", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("buildVersion reads the stamp's SHA in production and says dev otherwise", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sv-ver-"));
  fs.mkdirSync(path.join(app, "dist"));
  fs.writeFileSync(path.join(app, "dist", ".build-stamp"), JSON.stringify({ built_at: "x", git_sha: "abc1234" }));
  assert.equal(buildVersion(app, "production"), "abc1234");
  assert.equal(buildVersion(app, "development"), "dev");
  assert.equal(buildVersion(path.join(app, "missing"), "production"), "unknown");
});
