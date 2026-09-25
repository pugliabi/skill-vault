import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let vault: string;
let fakeHome: string;

function writeJson(abs: string, data: unknown): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data));
}

function writeManifest(m: unknown): void {
  writeJson(path.join(vault, "skills.json"), m);
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-checker-vault-"));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-checker-home-"));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  writeManifest({ skills: {} });
});

// ── startNotionChecker ───────────────────────────────────────────

test("skips a tick when there is no active vault, no connection, or no data source", async () => {
  const { startNotionChecker } = await import("./checker.ts");
  let refreshCalls = 0;
  const refresh = async () => {
    refreshCalls++;
    return { rows: [] };
  };

  // No vault path at all.
  let checker = startNotionChecker({ getVaultPath: () => null, firstRunDelayMs: 5, intervalMs: 100_000, refresh });
  await sleep(30);
  checker.stop();
  assert.equal(refreshCalls, 0);

  // Vault configured, but Notion never connected (no auth tokens on disk).
  checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 100_000, refresh });
  await sleep(30);
  checker.stop();
  assert.equal(refreshCalls, 0);

  // Connected, but no data source chosen for this vault.
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 100_000, refresh });
  await sleep(30);
  checker.stop();
  assert.equal(refreshCalls, 0);
});

test("first tick fires after firstRunDelayMs, then again after intervalMs; stop() cancels both timers", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  const { startNotionChecker } = await import("./checker.ts");

  let refreshCalls = 0;
  const refresh = async () => {
    refreshCalls++;
    return { rows: [] };
  };
  const openApi = async () => ({ api: {} as any, close: async () => {} });

  const checker = startNotionChecker({
    getVaultPath: () => vault,
    firstRunDelayMs: 20,
    intervalMs: 40,
    refresh,
    openApi,
  });

  await sleep(10);
  assert.equal(refreshCalls, 0, "too early for the first run");
  await sleep(25);
  assert.equal(refreshCalls, 1, "first run fired ~20ms in");
  await sleep(50);
  assert.ok(refreshCalls >= 2, "the interval fired at least one more tick");

  checker.stop();
  const afterStop = refreshCalls;
  await sleep(80);
  assert.equal(refreshCalls, afterStop, "stop() cleared both timers");
});

test("ticks never overlap: a slow tick makes the next scheduled one a no-op", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  const { startNotionChecker } = await import("./checker.ts");

  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const refresh = async () => {
    calls++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(60);
    concurrent--;
    return { rows: [] };
  };
  const openApi = async () => ({ api: {} as any, close: async () => {} });

  const checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 20, refresh, openApi });
  await sleep(150);
  checker.stop();

  assert.equal(maxConcurrent, 1, "no two ticks ran refresh at the same time");
  assert.ok(calls >= 1, "at least the first tick ran");
});

test("records a notion-side history version only for linked skills whose version_id changed", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  writeJson(path.join(fakeHome, ".skill-vault", "notion-cache.json"), {
    checked_at: "2026-01-01T00:00:00.000Z",
    data_source_id: "ds",
    rows: [
      { page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v1" },
      { page_id: "p-beta", title: "beta", description: "", tags: [], has_files: false, version_id: "v1" },
    ],
  });

  const skill = (name: string, md: string) => {
    fs.mkdirSync(path.join(vault, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(vault, "skills", name, "SKILL.md"), md);
  };
  skill("alpha", "---\nname: alpha\ndescription: d\n---\nbody\n");
  skill("beta", "---\nname: beta\ndescription: d\n---\nbody\n");
  writeManifest({
    skills: {
      alpha: { targets: [], notion: { page_id: "p-alpha", state: "linked", linked_at: "2026-01-01T00:00:00.000Z" } },
      beta: { targets: [], notion: { page_id: "p-beta", state: "linked", linked_at: "2026-01-01T00:00:00.000Z" } },
      // Notion-only row below has no vault link at all — must never be touched.
    },
  });

  const notionSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-checker-notion-"));
  fs.mkdirSync(path.join(notionSkillRoot, "alpha-new"));
  fs.writeFileSync(path.join(notionSkillRoot, "alpha-new", "SKILL.md"), "---\nname: alpha\ndescription: d\n---\nedited on Notion\n");

  const downloadCalls: string[] = [];
  const extractCalls: string[] = [];
  const { startNotionChecker } = await import("./checker.ts");
  const { listVersions } = await import("../history.ts");

  const refresh = async () => ({
    rows: [
      // alpha's version moved — should be downloaded and recorded.
      { page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v2" },
      // beta's version is unchanged — must be left alone.
      { page_id: "p-beta", title: "beta", description: "", tags: [], has_files: false, version_id: "v1" },
      // Notion-only row (no vault link) — must be skipped even though "changed".
      { page_id: "p-gamma", title: "gamma", description: "", tags: [], has_files: false, version_id: "v9" },
    ],
  });
  const openApi = async () => ({
    api: {
      downloadSkill: async (id: string) => {
        downloadCalls.push(id);
        return { versionId: "v2", url: `archive:${id}` };
      },
    } as any,
    close: async () => {},
  });
  const extract = async (url: string) => {
    extractCalls.push(url);
    return { skillRoot: path.join(notionSkillRoot, "alpha-new"), cleanup() {} };
  };

  const checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 100_000, refresh, openApi, extract });
  await sleep(60);
  checker.stop();

  assert.deepEqual(downloadCalls, ["p-alpha"], "only the changed, linked row was downloaded");
  assert.deepEqual(extractCalls, ["archive:p-alpha"]);

  const alphaVersions = listVersions(vault, "alpha");
  assert.equal(alphaVersions.length, 1);
  assert.equal(alphaVersions[0].side, "notion");
  assert.equal(alphaVersions[0].source, "notion-edit");
  assert.equal(alphaVersions[0].note, "Notion edit");

  assert.equal(listVersions(vault, "beta").length, 0, "unchanged version_id recorded nothing");
});

test("a tick with no previous cache is a baseline: it refreshes but records nothing", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  // No notion-cache.json at all — a fresh install / first-ever check.

  const skill = (name: string) => {
    fs.mkdirSync(path.join(vault, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(vault, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  };
  skill("alpha");
  writeManifest({
    skills: { alpha: { targets: [], notion: { page_id: "p-alpha", state: "linked", linked_at: "2026-01-01T00:00:00.000Z" } } },
  });

  const { startNotionChecker } = await import("./checker.ts");
  const { listVersions } = await import("../history.ts");
  let refreshCalls = 0;
  const downloadCalls: string[] = [];
  const refresh = async () => {
    refreshCalls++;
    // Every row looks "new" against an absent previous cache — must not be
    // treated as "changed".
    return { rows: [{ page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v1" }] };
  };
  const openApi = async () => ({
    api: { downloadSkill: async (id: string) => { downloadCalls.push(id); return { versionId: "v1", url: `archive:${id}` }; } } as any,
    close: async () => {},
  });

  const checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 100_000, refresh, openApi });
  await sleep(40);
  checker.stop();

  assert.equal(refreshCalls, 1, "the baseline tick still refreshes the cache");
  assert.deepEqual(downloadCalls, [], "nothing was downloaded on the baseline tick");
  assert.equal(listVersions(vault, "alpha").length, 0, "nothing was recorded on the baseline tick");
});

test("a previous cache from a different data source is also treated as a baseline", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds-new" });
  writeJson(path.join(fakeHome, ".skill-vault", "notion-cache.json"), {
    checked_at: "2026-01-01T00:00:00.000Z",
    data_source_id: "ds-old",
    rows: [{ page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v1" }],
  });

  const skill = (name: string) => {
    fs.mkdirSync(path.join(vault, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(vault, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  };
  skill("alpha");
  writeManifest({
    skills: { alpha: { targets: [], notion: { page_id: "p-alpha", state: "linked", linked_at: "2026-01-01T00:00:00.000Z" } } },
  });

  const { startNotionChecker } = await import("./checker.ts");
  const { listVersions } = await import("../history.ts");
  const downloadCalls: string[] = [];
  // Coincidentally the same page_id/version_id under the new data source —
  // still must not be diffed against the old data source's cache.
  const refresh = async () => ({ rows: [{ page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v1" }] });
  const openApi = async () => ({
    api: { downloadSkill: async (id: string) => { downloadCalls.push(id); return { versionId: "v1", url: `archive:${id}` }; } } as any,
    close: async () => {},
  });

  const checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 100_000, refresh, openApi });
  await sleep(40);
  checker.stop();

  assert.deepEqual(downloadCalls, []);
  assert.equal(listVersions(vault, "alpha").length, 0);
});

test("a tick skips entirely while a foreground Notion job (isBusy) is running", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  const { startNotionChecker } = await import("./checker.ts");
  let refreshCalls = 0;
  const refresh = async () => {
    refreshCalls++;
    return { rows: [] };
  };
  const openApi = async () => ({ api: {} as any, close: async () => {} });

  const checker = startNotionChecker({
    getVaultPath: () => vault,
    firstRunDelayMs: 5,
    intervalMs: 20,
    isBusy: () => true,
    refresh,
    openApi,
  });
  await sleep(60);
  checker.stop();
  assert.equal(refreshCalls, 0, "every tick was skipped while isBusy() was true");
});

test("a tick started while free abandons the rest of its work once isBusy flips true mid-tick", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  writeJson(path.join(fakeHome, ".skill-vault", "notion-cache.json"), {
    checked_at: "2026-01-01T00:00:00.000Z",
    data_source_id: "ds",
    rows: [
      { page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v1" },
      { page_id: "p-beta", title: "beta", description: "", tags: [], has_files: false, version_id: "v1" },
    ],
  });
  const skill = (name: string) => {
    fs.mkdirSync(path.join(vault, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(vault, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  };
  skill("alpha");
  skill("beta");
  writeManifest({
    skills: {
      alpha: { targets: [], notion: { page_id: "p-alpha", state: "linked", linked_at: "2026-01-01T00:00:00.000Z" } },
      beta: { targets: [], notion: { page_id: "p-beta", state: "linked", linked_at: "2026-01-01T00:00:00.000Z" } },
    },
  });

  const { startNotionChecker } = await import("./checker.ts");
  const { listVersions } = await import("../history.ts");
  const notionSkillRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-checker-busy-"));
  fs.mkdirSync(path.join(notionSkillRoot, "s"));
  fs.writeFileSync(path.join(notionSkillRoot, "s", "SKILL.md"), "---\nname: alpha\ndescription: d\n---\nedited\n");

  let busy = false;
  const recorded: string[] = [];
  const refresh = async () => ({
    rows: [
      { page_id: "p-alpha", title: "alpha", description: "", tags: [], has_files: false, version_id: "v2" },
      { page_id: "p-beta", title: "beta", description: "", tags: [], has_files: false, version_id: "v2" },
    ],
  });
  const openApi = async () => ({
    api: {
      downloadSkill: async (id: string) => {
        // A foreground job "starts" right after the tick began downloading.
        busy = true;
        return { versionId: "v2", url: `archive:${id}` };
      },
    } as any,
    close: async () => {},
  });
  const extract = async () => ({ skillRoot: path.join(notionSkillRoot, "s"), cleanup() {} });

  const checker = startNotionChecker({
    getVaultPath: () => vault,
    firstRunDelayMs: 5,
    intervalMs: 100_000,
    isBusy: () => busy,
    refresh,
    openApi,
    extract,
  });
  await sleep(60);
  checker.stop();

  for (const v of [...listVersions(vault, "alpha"), ...listVersions(vault, "beta")]) recorded.push(v.source);
  assert.deepEqual(recorded, [], "the isBusy check right before the write aborted the rest of the tick");
});

test("an error during a tick is swallowed, logged, and does not stop future ticks", async () => {
  writeJson(path.join(fakeHome, ".skill-vault", "notion-auth.json"), { tokens: { access_token: "x" } });
  writeJson(path.join(vault, "notion.json"), { data_source_id: "ds" });
  const { startNotionChecker } = await import("./checker.ts");

  let calls = 0;
  const refresh = async () => {
    calls++;
    throw new Error("boom");
  };
  const openApi = async () => ({ api: {} as any, close: async () => {} });

  const origError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const checker = startNotionChecker({ getVaultPath: () => vault, firstRunDelayMs: 5, intervalMs: 30, refresh, openApi });
    await sleep(80);
    checker.stop();
  } finally {
    console.error = origError;
  }

  assert.ok(calls >= 2, "the tick after the failing one still ran");
  assert.ok(logged.some((l) => String(l[0]).includes("Error: boom")), "the error was logged");
});

// ── gitGuard ───────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initClone(remote: string, dir: string): void {
  git(path.dirname(dir), "clone", "--quiet", remote, dir);
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "t");
}

function commit(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "msg");
}

test("gitGuard: not a repo", async () => {
  const { gitGuard } = await import("./checker.ts");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "sv-guard-plain-"));
  const status = await gitGuard(plain);
  assert.deepEqual(status, { is_repo: false, behind: 0, ahead: 0 });
});

test("gitGuard: a missing vault directory reports is_repo:false with an error instead of rejecting", async () => {
  const { gitGuard } = await import("./checker.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-guard-missing-"));
  const missing = path.join(root, "does-not-exist");
  const status = await gitGuard(missing);
  assert.equal(status.is_repo, false);
  assert.equal(status.behind, 0);
  assert.equal(status.ahead, 0);
  assert.ok(status.error, "a construction failure surfaces as an error, not a rejected promise");
});

test("gitGuard configures a non-interactive git environment (checked via an injected factory)", async () => {
  const { gitGuard } = await import("./checker.ts");
  const simpleGitModule = (await import("simple-git")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-guard-env-"));

  const seen: Array<Record<string, string | undefined>> = [];
  const factory = (vaultPath: string) => {
    const real = simpleGitModule({ baseDir: vaultPath });
    const originalEnv = real.env.bind(real);
    real.env = ((env: unknown) => {
      seen.push(env as Record<string, string | undefined>);
      return originalEnv(env as NodeJS.ProcessEnv);
    }) as typeof real.env;
    return real;
  };

  await gitGuard(dir, factory);

  assert.equal(seen.length, 1, "gitGuard called .env() exactly once on the git instance from the factory");
  const [seenEnv] = seen;
  assert.equal(seenEnv.GIT_TERMINAL_PROMPT, "0");
  assert.equal(seenEnv.GCM_INTERACTIVE, "never");
  assert.equal(seenEnv.GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
  // PATH is carried through; the env is otherwise minimal and explicit.
  assert.equal(seenEnv.PATH ?? seenEnv.Path, process.env.PATH ?? process.env.Path);
});

test("nonInteractiveEnv keeps only the pass-through vars (matched case-insensitively) plus the 3 overrides", async () => {
  const { nonInteractiveEnv } = await import("./checker.ts");
  const env = nonInteractiveEnv({
    Path: "/bin",
    HOME: "/h",
    UserProfile: "/u",
    SystemRoot: "C:/Windows",
    TEMP: "/t",
    GIT_EDITOR: "vi",
    GIT_PAGER: "less",
    GIT_ASKPASS: "x",
    GIT_CONFIG_GLOBAL: "/evil",
    GIT_SSH_COMMAND: "evil-ssh",
    SOMETHING_ELSE: "1",
  });
  assert.deepEqual(env, {
    Path: "/bin",
    HOME: "/h",
    UserProfile: "/u",
    SystemRoot: "C:/Windows",
    TEMP: "/t",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  });
});

test("gitGuard works with only allowUnsafeSshCommand even when the parent env sets unsafe git vars", { timeout: 20_000 }, async () => {
  const { gitGuard } = await import("./checker.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-guard-unsafe-"));
  const remote = path.join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", remote);
  const cloneA = path.join(root, "a");
  initClone(remote, cloneA);
  commit(cloneA, "SKILL.md", "one\n");
  git(cloneA, "push", "-q", "-u", "origin", "HEAD");

  const saved = { GIT_EDITOR: process.env.GIT_EDITOR, GIT_PAGER: process.env.GIT_PAGER, GIT_ASKPASS: process.env.GIT_ASKPASS };
  process.env.GIT_EDITOR = "vi";
  process.env.GIT_PAGER = "less";
  process.env.GIT_ASKPASS = "never-called";
  try {
    const status = await gitGuard(cloneA);
    assert.deepEqual(status, { is_repo: true, ahead: 0, behind: 0 });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("gitGuard: reports behind after a push from another clone", { timeout: 20_000 }, async () => {
  const { gitGuard } = await import("./checker.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-guard-root-"));
  const remote = path.join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", remote);

  const cloneA = path.join(root, "a");
  const cloneB = path.join(root, "b");
  initClone(remote, cloneA);
  commit(cloneA, "SKILL.md", "one\n");
  git(cloneA, "push", "-q", "-u", "origin", "HEAD");

  initClone(remote, cloneB);

  // B is in sync right after cloning.
  let status = await gitGuard(cloneB);
  assert.equal(status.is_repo, true);
  assert.equal(status.behind, 0);
  assert.equal(status.ahead, 0);
  assert.equal(status.error, undefined);

  // A pushes a new commit; B hasn't fetched it yet.
  commit(cloneA, "SKILL.md", "two\n");
  git(cloneA, "push", "-q");

  status = await gitGuard(cloneB);
  assert.equal(status.is_repo, true);
  assert.equal(status.behind, 1);
  assert.equal(status.ahead, 0);
  assert.equal(status.error, undefined);
});

test("gitGuard: a repo with a remote but no upstream branch reports behind 0 with an error", async () => {
  const { gitGuard } = await import("./checker.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sv-guard-noup-"));
  const remote = path.join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", remote);

  const dir = path.join(root, "work");
  git(root, "init", "--quiet", dir);
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "t");
  git(dir, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  // A remote exists (so `git fetch` succeeds) but the branch was never
  // pushed with `-u`, so it has no upstream to compare against.

  const status = await gitGuard(dir);
  assert.equal(status.is_repo, true);
  assert.equal(status.behind, 0);
  assert.equal(status.error, "no upstream");
});
