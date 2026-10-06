import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  beginForegroundCheck,
  endForegroundCheck,
  foregroundCheckActive,
  startUpdateSweep,
  type SweepDeps,
} from "./updateSweep.ts";
import type { UpdateCheckResult } from "../../types/vault.ts";
import type { UpdateSweepCache } from "./suggestionStore.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function makeDeps(over: Partial<SweepDeps> = {}) {
  const persisted: UpdateSweepCache[] = [];
  const removed: string[] = [];
  let doneCount = 0;
  const deps: SweepDeps = {
    getVaultPath: () => "C:\\vault",
    firstRunDelayMs: 3_600_000, // never fires in tests — we drive runNow()
    intervalMs: 3_600_000,
    check: async () => [],
    guard: async () => ({ ahead: 0, behind: 0, is_repo: true }),
    persist: (c) => persisted.push(c),
    removeClone: (p) => removed.push(p),
    onDone: () => doneCount++,
    now: () => "2026-10-06T12:00:00.000Z",
    ...over,
  };
  return { deps, persisted, removed, doneCount: () => doneCount };
}

beforeEach(() => {
  // Clear any leaked foreground flags between tests.
  while (foregroundCheckActive()) endForegroundCheck();
});

test("a tick persists a lite cache (statuses only), removes its clones once each, and broadcasts", async () => {
  const results: UpdateCheckResult[] = [
    { name: "a", status: "update_available", tmp_path: "T1", upstream_path: "U1", vault_hash: "v" },
    { name: "b", status: "upstream_missing", tmp_path: "T1", message: "gone" },
    { name: "c", status: "up_to_date", tmp_path: "T2" },
  ];
  const { deps, persisted, removed, doneCount } = makeDeps({ check: async () => results, guard: async () => ({ ahead: 1, behind: 2, is_repo: true }) });
  const sweep = startUpdateSweep(deps);
  assert.ok(sweep.runNow());
  while (sweep.isRunning()) await new Promise((r) => setImmediate(r));
  sweep.stop();

  assert.equal(persisted.length, 1);
  const cache = persisted[0];
  assert.equal(cache.vault_path, "C:\\vault");
  assert.equal(cache.checked_at, "2026-10-06T12:00:00.000Z");
  assert.deepEqual(cache.results, [
    { name: "a", status: "update_available" },
    { name: "b", status: "upstream_missing", message: "gone" },
    { name: "c", status: "up_to_date" },
  ]);
  assert.ok(!JSON.stringify(cache).includes("tmp_path"));
  assert.deepEqual(cache.guard, { ahead: 1, behind: 2 });
  assert.deepEqual(removed.sort(), ["T1", "T2"], "each unique clone removed exactly once");
  assert.equal(doneCount(), 1);
});

test("single-flight: runNow during a running tick is refused; stop() prevents later launches", async () => {
  const gate = deferred<UpdateCheckResult[]>();
  const { deps, persisted } = makeDeps({ check: () => gate.promise });
  const sweep = startUpdateSweep(deps);
  assert.ok(sweep.runNow());
  assert.equal(sweep.runNow(), false, "second launch while running must refuse");
  gate.resolve([]);
  while (sweep.isRunning()) await new Promise((r) => setImmediate(r));
  assert.equal(persisted.length, 1);
  sweep.stop();
  assert.equal(sweep.runNow(), false, "stopped sweeper never launches");
});

test("busy / foreground / unconfigured ticks are silent no-ops", async () => {
  // isBusy
  let busy = true;
  const a = makeDeps({ isBusy: () => busy });
  const sweepA = startUpdateSweep(a.deps);
  sweepA.runNow();
  while (sweepA.isRunning()) await new Promise((r) => setImmediate(r));
  assert.equal(a.persisted.length, 0);
  busy = false;
  sweepA.runNow();
  while (sweepA.isRunning()) await new Promise((r) => setImmediate(r));
  assert.equal(a.persisted.length, 1);
  sweepA.stop();

  // foreground check flag
  const b = makeDeps({});
  const sweepB = startUpdateSweep(b.deps);
  beginForegroundCheck();
  sweepB.runNow();
  while (sweepB.isRunning()) await new Promise((r) => setImmediate(r));
  assert.equal(b.persisted.length, 0);
  endForegroundCheck();
  sweepB.stop();

  // no vault
  const c = makeDeps({ getVaultPath: () => null });
  const sweepC = startUpdateSweep(c.deps);
  sweepC.runNow();
  while (sweepC.isRunning()) await new Promise((r) => setImmediate(r));
  assert.equal(c.persisted.length, 0);
  sweepC.stop();
});

test("check failures never persist or broadcast, and never throw", async () => {
  const { deps, persisted, doneCount } = makeDeps({
    check: async () => {
      throw new Error("network died");
    },
  });
  const sweep = startUpdateSweep(deps);
  sweep.runNow();
  while (sweep.isRunning()) await new Promise((r) => setImmediate(r));
  sweep.stop();
  assert.equal(persisted.length, 0);
  assert.equal(doneCount(), 0);
});

test("guard failure degrades to a cache without guard; non-repo guard omitted", async () => {
  const bad = makeDeps({ guard: async () => { throw new Error("no git"); } });
  const sweepBad = startUpdateSweep(bad.deps);
  sweepBad.runNow();
  while (sweepBad.isRunning()) await new Promise((r) => setImmediate(r));
  sweepBad.stop();
  assert.equal(bad.persisted[0].guard, undefined);

  const notRepo = makeDeps({ guard: async () => ({ ahead: 0, behind: 0, is_repo: false }) });
  const sweepNr = startUpdateSweep(notRepo.deps);
  sweepNr.runNow();
  while (sweepNr.isRunning()) await new Promise((r) => setImmediate(r));
  sweepNr.stop();
  assert.equal(notRepo.persisted[0].guard, undefined);
});

test("foreground flag counts nest", () => {
  assert.equal(foregroundCheckActive(), false);
  beginForegroundCheck();
  beginForegroundCheck();
  endForegroundCheck();
  assert.equal(foregroundCheckActive(), true);
  endForegroundCheck();
  assert.equal(foregroundCheckActive(), false);
  endForegroundCheck(); // extra end never goes negative
  assert.equal(foregroundCheckActive(), false);
});
