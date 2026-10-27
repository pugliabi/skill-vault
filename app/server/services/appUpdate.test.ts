import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAppUpdater,
  decideCanApply,
  parseCommits,
  parseLeftRight,
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
