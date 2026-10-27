import { test, type TestContext } from "node:test";
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
  summarizeOutput,
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
  appInRoot: true,
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
    [{ appInRoot: false }, {}, /the app folder isn't directly inside its git checkout/],
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

type Responses = Record<string, Partial<RunResult>>;

/**
 * A temp repo root with app/dist/old.txt; the fake build writes app/dist-next/new.txt.
 * `overrides` may be a function of the temp root, for answers that name it.
 */
function applyHarness(overrides: Responses | ((root: string) => Responses) = {}, restartImpl?: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-upd-"));
  const over = typeof overrides === "function" ? overrides(root) : overrides;
  const appDir = path.join(root, "app");
  fs.mkdirSync(path.join(appDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "dist", "old.txt"), "old");
  const responses: Record<string, Partial<RunResult>> = {
    ...BEHIND,
    "git rev-parse --show-toplevel": { stdout: `${root}\n` },
    "git pull --ff-only origin main": {},
    [LOCK_DIFF]: { stdout: "" },
    [`git reset --keep ${A}`]: {},
    [NPM_CI]: {},
    ...over,
  };
  const calls: string[] = [];
  const nodeEnvs: Array<string | undefined> = [];
  const run: Run = async (cmd, args, opts) => {
    const key = [cmd === process.execPath ? "node" : cmd, ...args].join(" ");
    calls.push(key);
    if (cmd === "npm" || cmd === process.execPath) nodeEnvs.push(opts.env?.NODE_ENV);
    if (key === BUILD) {
      // The build stages dist-next/ whether or not it then fails.
      fs.mkdirSync(path.join(opts.cwd, "dist-next"), { recursive: true });
      fs.writeFileSync(path.join(opts.cwd, "dist-next", "new.txt"), "new");
      if (!(BUILD in over)) return { code: 0, stdout: "", stderr: "" };
    }
    const r = responses[key];
    return r ? { code: 0, stdout: "", stderr: "", ...r } : { code: 1, stdout: "", stderr: `unexpected: ${key}` };
  };
  let restarts = 0;
  const u = createAppUpdater({
    appDir,
    mode: "production",
    isBusy: () => false,
    restart: () => {
      restarts++;
      restartImpl?.();
    },
    run,
  });
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
  assert.ok(h.calls.includes(`git reset --keep ${A}`));
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["old.txt"]);
  assert.equal(h.restarts(), 0);
  assert.equal(h.updater.isApplying(), false);
  assert.match(h.updater.status().last_error ?? "", /^build failed: vite: boom/);
});

test("a failed pull resets without building", async () => {
  const h = applyHarness({ "git pull --ff-only origin main": { code: 1, stderr: "fatal: Not possible to fast-forward" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.ok(!h.calls.includes(BUILD));
  assert.ok(h.calls.includes(`git reset --keep ${A}`));
});

test("a failed reinstall resets and reinstalls the old packages", async () => {
  const h = applyHarness({ [LOCK_DIFF]: { stdout: "app/package-lock.json\n" }, [NPM_CI]: { code: 1, stderr: "EPERM" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.ok(h.calls.includes(`git reset --keep ${A}`));
  assert.equal(h.calls.filter((c) => c === NPM_CI).length, 2, "tried once, then restored the old lockfile's packages");
});

test("apply refuses, with the reason, when the checkout can't be updated", async () => {
  const h = applyHarness({ "git status --porcelain": { stdout: " M app/server/index.ts\n" } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events, [{ step: "check", state: "error", message: "the checkout has uncommitted changes" }]);
  assert.ok(!h.calls.includes("git pull --ff-only origin main"));
});

test("a failed build removes dist-next and keeps dist/ as it was", async () => {
  const h = applyHarness({ [BUILD]: { code: 1, stderr: "vite: boom" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.equal(fs.existsSync(path.join(h.appDir, "dist-next")), false);
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["old.txt"]);
});

test("a rollback cleanup that throws doesn't leave 'applying' stuck", async (t) => {
  const h = applyHarness({ [BUILD]: { code: 1, stderr: "vite: boom" } });
  const realRm = fs.rmSync;
  t.mock.method(fs, "rmSync", (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).endsWith("dist-next")) throw new Error("EBUSY: resource busy");
    return realRm(p, o);
  });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.equal(h.updater.isApplying(), false);
});

test("a failed git reset during rollback is reported", async () => {
  const h = applyHarness({ [BUILD]: { code: 1, stderr: "vite: boom" }, [`git reset --keep ${A}`]: { code: 1, stderr: "fatal: index.lock exists" } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  const last = events.at(-1);
  assert.equal(last?.state, "error");
  assert.match(last?.message ?? "", /rollback also failed/);
  assert.match(h.updater.status().last_error ?? "", /rollback also failed/);
  assert.equal(h.updater.isApplying(), false);
});

test("a restart hook that throws is reported and releases 'applying'", async () => {
  const h = applyHarness({}, () => {
    throw new Error("spawn EACCES");
  });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events.at(-1), { step: "restart", state: "error", message: "spawn EACCES" });
  assert.equal(h.updater.isApplying(), false);
  assert.match(h.updater.status().last_error ?? "", /^restart failed/);
  assert.ok(!h.calls.some((c) => c.startsWith("git reset")), "code and build already match the new commit");
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

// ── Final-review fixes ──

const silence = (t: TestContext) => t.mock.method(console, "error", () => {});

function stagedApp(): string {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-swap-"));
  fs.mkdirSync(path.join(appDir, "dist"));
  fs.writeFileSync(path.join(appDir, "dist", "old.txt"), "old");
  fs.mkdirSync(path.join(appDir, "dist-next"));
  fs.writeFileSync(path.join(appDir, "dist-next", "new.txt"), "new");
  return appDir;
}

test("swapDist: a dist-old cleanup that throws is logged, not thrown, and dist/ holds the new build", (t) => {
  const appDir = stagedApp();
  const logged = silence(t);
  const realRm = fs.rmSync;
  t.mock.method(fs, "rmSync", (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).endsWith("dist-old")) throw new Error("EBUSY: resource busy or locked");
    return realRm(p, o);
  });
  assert.doesNotThrow(() => swapDist(appDir));
  assert.deepEqual(fs.readdirSync(path.join(appDir, "dist")), ["new.txt"]);
  assert.ok(logged.mock.calls.length > 0, "the failed cleanup is logged");
});

test("swapDist: after the copy fallback, a dist-next cleanup that throws is not thrown", (t) => {
  const appDir = stagedApp();
  silence(t);
  const realRename = fs.renameSync;
  const realRm = fs.rmSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).endsWith(`${path.sep}dist`)) throw new Error("EPERM: operation not permitted");
    return realRename(from, to);
  });
  t.mock.method(fs, "rmSync", (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).endsWith("dist-next")) throw new Error("EBUSY: resource busy or locked");
    return realRm(p, o);
  });
  assert.doesNotThrow(() => swapDist(appDir));
  assert.ok(fs.readdirSync(path.join(appDir, "dist")).includes("new.txt"));
});

test("swapDist still throws, and keeps the old build, when the swap itself fails", (t) => {
  const appDir = stagedApp();
  const realRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from).endsWith("dist-next")) throw new Error("EPERM: operation not permitted");
    return realRename(from, to);
  });
  assert.throws(() => swapDist(appDir), /EPERM/);
  assert.deepEqual(fs.readdirSync(path.join(appDir, "dist")), ["old.txt"]);
});

test("apply: a cleanup failure after a successful swap doesn't trigger a rollback", async (t) => {
  const h = applyHarness();
  silence(t);
  const realRm = fs.rmSync;
  t.mock.method(fs, "rmSync", (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).endsWith("dist-old")) throw new Error("EBUSY: resource busy or locked");
    return realRm(p, o);
  });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), true);
  assert.ok(!h.calls.some((c) => c.startsWith("git reset")), "no rollback");
  assert.deepEqual(fs.readdirSync(path.join(h.appDir, "dist")), ["new.txt"]);
  assert.equal(h.restarts(), 1);
  assert.deepEqual(events.at(-1), { step: "restart", state: "start" });
});

const NODE_CRASH = [
  "file:///C:/src/skill-vault/app/scripts/build.mjs:22",
  "await viteBuild({",
  "^",
  "",
  'Error: [vite]: Rollup failed to resolve import "x" from "client/src/main.tsx".',
  "    at viteLog (file:///C:/src/skill-vault/app/node_modules/vite/dist/node/chunks/dep.js:1:1)",
  "{",
  "  code: 'PLUGIN_ERROR'",
  "}",
  "",
  "Node.js v24.16.0",
  "",
].join("\r\n");

test("a failed step is logged in full and summarized by its error line, not its last line", async (t) => {
  const h = applyHarness({ [BUILD]: { code: 1, stdout: "vite v5 building for production...\n", stderr: NODE_CRASH } });
  const logged = silence(t);
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  const failure = events.find((e) => e.step === "build" && e.state === "error");
  assert.match(failure?.message ?? "", /Rollup failed to resolve import/);
  assert.doesNotMatch(failure?.message ?? "", /Node\.js/);
  assert.match(h.updater.status().last_error ?? "", /^build failed: Error: \[vite\]: Rollup failed/);
  const log = logged.mock.calls.map((c) => c.arguments.map(String).join(" ")).join("\n");
  assert.match(log, /build/);
  assert.ok(log.includes("Node.js v24.16.0"), "the full stderr reaches the log");
  assert.ok(log.includes("vite v5 building for production"), "and so does stdout");
});

test("summarizeOutput picks the first error-looking line, else the first non-empty one, capped", () => {
  assert.match(summarizeOutput({ code: 1, stdout: "", stderr: NODE_CRASH }), /^Error: \[vite\]/);
  assert.equal(summarizeOutput({ code: 1, stdout: "", stderr: "\n  vite: boom  \nlast line\n" }), "vite: boom");
  assert.equal(summarizeOutput({ code: 1, stdout: "npm ERR_SOMETHING bad\n", stderr: "" }), "npm ERR_SOMETHING bad");
  assert.equal(summarizeOutput({ code: 1, stdout: "ok\n", stderr: "warn: x\r\nBuild failed in 2s\r\n" }), "Build failed in 2s");
  assert.equal(summarizeOutput({ code: 7, stdout: "", stderr: "" }), "exited with code 7");
  const long = summarizeOutput({ code: 1, stdout: "", stderr: `error: ${"x".repeat(500)}` });
  assert.ok(long.length <= 200, `length ${long.length}`);
});

test("apply refuses when the app folder isn't directly inside the git checkout", async () => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "sv-other-"));
  const h = applyHarness({ "git rev-parse --show-toplevel": { stdout: `${elsewhere}\n` } });
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events, [
    { step: "check", state: "error", message: "the app folder isn't directly inside its git checkout" },
  ]);
  assert.ok(!h.calls.includes("git pull --ff-only origin main"));
  assert.ok(!h.calls.some((c) => c.startsWith("git reset")));
  assert.equal(h.updater.isApplying(), false);
});

test("check() reports a checkout whose root isn't the app's parent as not updatable", async () => {
  const s = await updater(fakeRun(BEHIND).run, { appDir: "/elsewhere/app" }).check();
  assert.equal(s.can_apply, false);
  assert.match(s.reason ?? "", /isn't directly inside its git checkout/);
});

test(
  "the checkout-root comparison ignores case and slash style on Windows",
  { skip: process.platform !== "win32" && "Windows only" },
  async () => {
    const h = applyHarness((root) => ({
      "git rev-parse --show-toplevel": { stdout: `${root.toUpperCase().split(path.sep).join("/")}\n` },
    }));
    const s = await h.updater.check();
    assert.equal(s.can_apply, true, s.reason);
  },
);

test("a second apply while one is running is refused at once, and only one pull runs", async () => {
  const h = applyHarness();
  const first: ApplyEvent[] = [];
  const second: ApplyEvent[] = [];
  const p1 = h.updater.apply((e) => first.push(e));
  const r2 = await h.updater.apply((e) => second.push(e));
  assert.equal(r2, false);
  assert.deepEqual(second, [{ step: "check", state: "error", message: "an update is already running" }]);
  assert.equal(await p1, true);
  assert.equal(h.calls.filter((c) => c === "git pull --ff-only origin main").length, 1);
  assert.equal(h.calls.filter((c) => c === "git fetch origin --quiet").length, 1, "the refused call doesn't even fetch");
});

test("a refused apply releases 'applying', so a later apply is judged afresh", async () => {
  const h = applyHarness({ "git status --porcelain": { stdout: " M app/server/index.ts\n" } });
  assert.equal(await h.updater.apply(() => {}), false);
  assert.equal(h.updater.isApplying(), false);
  const events: ApplyEvent[] = [];
  assert.equal(await h.updater.apply((e) => events.push(e)), false);
  assert.deepEqual(events, [{ step: "check", state: "error", message: "the checkout has uncommitted changes" }]);
});
