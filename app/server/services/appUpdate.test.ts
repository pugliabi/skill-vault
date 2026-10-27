import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAppUpdater,
  decideCanApply,
  defaultRun,
  parseCommits,
  parseLeftRight,
  swapDist,
  type ApplyEvent,
  type GitFacts,
  type Run,
  type RunResult,
} from "./appUpdate.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

/** git answers for a clean main checkout two commits behind origin/main. */
const BEHIND: Record<string, Partial<RunResult>> = {
  "git rev-parse --show-toplevel": { stdout: "/repo\n" },
  "git remote get-url origin": { stdout: "https://github.com/owner/skill-vault.git\n" },
  "git fetch origin --quiet": {},
  "git rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
  "git rev-parse HEAD": { stdout: `${A}\n` },
  "git rev-parse origin/main": { stdout: `${B}\n` },
  "git rev-list --left-right --count HEAD...origin/main": { stdout: "0\t2\n" },
  "git status --porcelain": { stdout: "" },
  "git log --format=%h%x09%s HEAD..origin/main": { stdout: "bbbbbbb\tSecond change\nccccccc\tFirst change\n" },
};

/** Listed commands exit 0 with the given output; anything else exits 1. */
function fakeRun(responses: Record<string, Partial<RunResult>>): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const r = responses[key];
    return r ? { code: 0, stdout: "", stderr: "", ...r } : { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  return { run, calls };
}

type Ctx = Parameters<typeof decideCanApply>[1];
const CTX: Ctx = { mode: "production", busy: false, applying: false };
const facts = (over: Partial<GitFacts> = {}): GitFacts => ({
  isRepo: true,
  hasOrigin: true,
  repoRoot: "/repo",
  branch: "main",
  current: A,
  latest: B,
  ahead: 0,
  behind: 2,
  dirty: false,
  commits: [],
  ...over,
});
const updater = (run: Run, extra: Partial<Parameters<typeof createAppUpdater>[0]> = {}) =>
  createAppUpdater({ appDir: "/repo/app", mode: "production", isBusy: () => false, restart() {}, run, ...extra });

test("parseLeftRight and parseCommits read git's output", () => {
  assert.deepEqual(parseLeftRight("1\t3\n"), { ahead: 1, behind: 3 });
  assert.deepEqual(parseLeftRight(""), { ahead: 0, behind: 0 });
  assert.deepEqual(parseCommits("abc1234\tFix the thing\ndef5678\tKeep\ttabs\n"), [
    { sha: "abc1234", subject: "Fix the thing" },
    { sha: "def5678", subject: "Keep\ttabs" },
  ]);
});

test("decideCanApply allows a clean main checkout that is behind", () => {
  assert.deepEqual(decideCanApply(facts(), CTX), { can_apply: true });
});

test("decideCanApply refuses, with a reason, for each blocking state", () => {
  const cases: Array<[Partial<GitFacts>, Partial<Ctx>, RegExp]> = [
    [{ isRepo: false }, {}, /isn't a git checkout/],
    [{ hasOrigin: false }, {}, /no origin remote/],
    [{ latest: null }, {}, /GitHub's main branch \(origin\/main\) wasn't found/],
    [{}, { mode: "development" }, /running from source/],
    [{ branch: "feature" }, {}, /on branch "feature"/],
    [{ dirty: true }, {}, /uncommitted changes/],
    [{ ahead: 1 }, {}, /1 local commit isn't on GitHub/],
    [{ ahead: 2 }, {}, /2 local commits aren't on GitHub/],
    [{ behind: 0 }, {}, /already up to date/],
    [{}, { applying: true }, /already running/],
    [{}, { busy: true }, /a job is running/],
  ];
  for (const [f, c, re] of cases) {
    const d = decideCanApply(facts(f), { ...CTX, ...c });
    assert.equal(d.can_apply, false, String(re));
    assert.match(d.reason ?? "", re);
  }
});

test("before the first check, status says so", () => {
  const s = updater(fakeRun({}).run).status();
  assert.equal(s.supported, false);
  assert.equal(s.checked_at, null);
  assert.equal(s.reason, "not checked yet");
});

test("check() fetches, then reports what's new on main", async () => {
  const { run, calls } = fakeRun(BEHIND);
  const s = await updater(run, { now: () => "2026-10-27T12:00:00.000Z" }).check();
  assert.ok(calls.includes("git fetch origin --quiet"));
  assert.equal(s.supported, true);
  assert.equal(s.behind, 2);
  assert.equal(s.current, "aaaaaaa");
  assert.equal(s.latest, "bbbbbbb");
  assert.deepEqual(s.commits.map((c) => c.subject), ["Second change", "First change"]);
  assert.equal(s.checked_at, "2026-10-27T12:00:00.000Z");
  assert.equal(s.can_apply, true);
});

test("a folder that isn't a git checkout is unsupported", async () => {
  const s = await updater(fakeRun({}).run).check();
  assert.equal(s.supported, false);
  assert.match(s.reason ?? "", /isn't a git checkout/);
});

test("a failed fetch is reported, and the last known origin/main still counts", async () => {
  const { run } = fakeRun({ ...BEHIND, "git fetch origin --quiet": { code: 128, stderr: "fatal: unable to access" } });
  const s = await updater(run).check();
  assert.equal(s.behind, 2);
  assert.match(s.last_error ?? "", /unable to access/);
});

test("a missing origin/main is refused, not reported as up to date", async () => {
  const responses = { ...BEHIND };
  delete (responses as Record<string, unknown>)["git rev-parse origin/main"];
  const s = await updater(fakeRun(responses).run).check();
  assert.equal(s.can_apply, false);
  assert.match(s.reason ?? "", /origin\/main\) wasn't found/);
  assert.match(s.last_error ?? "", /origin\/main not found/);
  assert.equal(s.behind, 0);
});

test("a failed git status counts as dirty, so an update is refused", async () => {
  const { run } = fakeRun({ ...BEHIND, "git status --porcelain": { code: 1, stderr: "index locked" } });
  const s = await updater(run).check();
  assert.equal(s.dirty, true);
  assert.equal(s.can_apply, false);
});

test("a failed rev-parse HEAD leaves the current commit unknown", async () => {
  const { run } = fakeRun({ ...BEHIND, "git rev-parse HEAD": { code: 1, stdout: "", stderr: "bad" } });
  const s = await updater(run).check();
  assert.equal(s.current, null);
});

test("the scheduled check waits while a job is running", async () => {
  let busy = true;
  const { run, calls } = fakeRun(BEHIND);
  const u = updater(run, { isBusy: () => busy, firstRunDelayMs: 5, intervalMs: 20 });
  u.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0);
  busy = false;
  await new Promise((r) => setTimeout(r, 50));
  u.stop();
  assert.ok(calls.includes("git fetch origin --quiet"));
});

// ── The real runner. These use node itself, so no git or npm is needed. ──

test("defaultRun returns the exit code, stdout and stderr", async () => {
  const r = await defaultRun(
    process.execPath,
    ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
    { cwd: os.tmpdir() },
  );
  assert.deepEqual(r, { code: 3, stdout: "out", stderr: "err" });
});

test("defaultRun gives up on a hung command and resolves promptly", async () => {
  const started = Date.now();
  const r = await defaultRun(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: os.tmpdir(),
    timeoutMs: 300,
  });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  assert.equal(r.code, -1);
  assert.match(r.stderr, /timed out/);
});

test("defaultRun resolves, not throws, when the command doesn't exist", async () => {
  const r = await defaultRun("sv-no-such-command-xyz", [], { cwd: os.tmpdir() });
  assert.equal(r.code, -1);
  assert.ok(r.stderr.length > 0);
});

const LOCK_DIFF = `git diff --name-only ${A} HEAD -- app/package-lock.json`;
const BUILD = "node scripts/build.mjs --out dist-next";
const NPM_CI = "npm ci --include=dev --no-audit --no-fund";

/** A temp repo root with app/dist/old.txt; the fake build writes app/dist-next/new.txt. */
function applyHarness(over: Record<string, Partial<RunResult>> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upd-"));
  const appDir = path.join(root, "app");
  fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "dist", "old.txt"), "old");
  const responses: Record<string, Partial<RunResult>> = {
    ...BEHIND,
    "git rev-parse --show-toplevel": { stdout: `${root}\n` },
    "git pull --ff-only origin main": {},
    [LOCK_DIFF]: { stdout: "" },
    [`git reset --hard ${A}`]: {},
    [NPM_CI]: {},
    ...over,
  };
  const calls: string[] = [];
  const nodeEnvs: Array<string | undefined> = [];
  const run: Run = async (cmd, args, opts) => {
    const key = [cmd === process.execPath ? "node" : cmd, ...args].join(" ");
    calls.push(key);
    if (cmd === "npm" || cmd === process.execPath) nodeEnvs.push(opts.env?.NODE_ENV);
    if (key === BUILD && !(BUILD in over)) {
      fs.mkdirSync(path.join(opts.cwd, "dist-next"), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, "dist-next", "new.txt"), "new");
      return { code: 0, stdout: "", stderr: "" };
    }
    const r = responses[key];
    return r ? { code: 0, stdout: "", stderr: "", ...r } : { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  let restarts = 0;
  const u = createAppUpdater({ appDir, mode: "production", isBusy: () => false, restart: () => void restarts++, run });
  return { appDir, calls, nodeEnvs, updater: u, restarts: () => restarts };
}

const steps = (events: ApplyEvent[]) => events.map((e) => `${e.step}:${e.state}`);

test("apply: pull → skip install → staged build → swap → restart", async () => {
  const h = applyHarness();
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), true);
  assert.deepEqual(steps(events), ["pull:start", "pull:done", "install:skip", "build:start", "build:done", "restart:start"]);
  assert.ok(!h.calls.includes(NPM_CI));
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["new.txt"]);
  assert.equal(fs.existsSync(path.join(h.appDir, "dist-next")), false);
  assert.equal(h.restarts(), 1);
  assert.equal(h.updater.isApplying(), true, "stays applying until the process hands over");
});

test("apply reinstalls packages only when package-lock.json changed, without NODE_ENV", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const h = applyHarness({ [LOCK_DIFF]: { stdout: "app/package-lock.json\n" } });
    assert.equal(await h.updater.apply(() => {}), true);
    assert.ok(h.calls.includes(NPM_CI));
    assert.deepEqual(h.nodeEnvs, [undefined, undefined], "npm ci and the build never see NODE_ENV");
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test("a failed build resets the checkout and keeps the current build", async () => {
  const h = applyHarness({ [BUILD]: { code: 1, stderr: "vite: boom" } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events.at(-1), { step: "build", state: "error", message: "vite: boom" });
  assert.ok(h.calls.includes(`git reset --hard ${A}`));
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["old.txt"]);
  assert.equal(h.restarts(), 0);
  assert.equal(h.updater.isApplying(), false);
  assert.match(h.updater.status().last_error ?? "", /^build failed: vite: boom/);
});

test("a failed pull resets without building", async () => {
  const h = applyHarness({ "git pull --ff-only origin main": { code: 1, stderr: "fatal: Not possible to fast-forward" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.ok(!h.calls.includes(BUILD));
  assert.ok(h.calls.includes(`git reset --hard ${A}`));
});

test("a failed reinstall resets and reinstalls the old packages", async () => {
  const h = applyHarness({ [LOCK_DIFF]: { stdout: "app/package-lock.json\n" }, [NPM_CI]: { code: 1, stderr: "EPERM" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.ok(h.calls.includes(`git reset --hard ${A}`));
  assert.equal(h.calls.filter((c) => c === NPM_CI).length, 2, "tried once, then restored the old lockfile's packages");
});

test("apply refuses, with the reason, when the checkout can't be updated", async () => {
  const h = applyHarness({ "git status --porcelain": { stdout: " M app/server/index.ts\n" } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events, [{ step: "check", state: "error", message: "the checkout has uncommitted changes" }]);
  assert.ok(!h.calls.includes("git pull --ff-only origin main"));
});

test("swapDist replaces dist/ with dist-next/", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-swap-"));
  fs.mkdirSync(path.join(appDir, "dist"));
  fs.writeFileSync(path.join(appDir, "dist", "old.txt"), "old");
  fs.mkdirSync(path.join(appDir, "dist-next"));
  fs.writeFileSync(path.join(appDir, "dist-next", "new.txt"), "new");
  swapDist(appDir);
  assert.deepEqual(fs.readdirSync(path.join(appDir, "dist")), ["new.txt"]);
  assert.equal(fs.existsSync(path.join(appDir, "dist-next")), false);
  assert.equal(fs.existsSync(path.join(appDir, "dist-old")), false);
});
