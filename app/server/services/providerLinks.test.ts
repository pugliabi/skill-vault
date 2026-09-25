import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Renames and deletes through the shared lifecycle service keep provider
// links correct. Temp vault + temp provider dirs only.

let vault: string;
let provA: string;
let provB: string;
let provC: string;
const providers = () => [
  { id: "agent-a", path: provA },
  { id: "agent-b", path: provB },
  { id: "agent-c", path: provC },
];
const skill = (name: string) => path.join(vault, "skills", name);

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plhome-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plvault-"));
  fs.mkdirSync(skill("old-tool"), { recursive: true });
  fs.writeFileSync(path.join(skill("old-tool"), "SKILL.md"), "---\nname: old-tool\ndescription: d\n---\nbody\n");
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify({ skills: { "old-tool": { targets: ["agent-a", "agent-b"] } } }));
  [provA, provB, provC] = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), "sv-plprov-")));
  // agent-a: a live link to the vault folder; agent-b: a real copied folder; agent-c: nothing.
  fs.symlinkSync(skill("old-tool"), path.join(provA, "old-tool"), "junction");
  fs.mkdirSync(path.join(provB, "old-tool"));
  fs.writeFileSync(path.join(provB, "old-tool", "SKILL.md"), "copy\n");
});

test("rename moves provider links, leaves copies in place, skips providers without the skill", async () => {
  const { renameVaultSkill } = await import("./skillLifecycle.ts");
  const { rawLinkTarget } = await import("./providerLinks.ts");
  const outcomes = await renameVaultSkill(vault, "old-tool", "new-tool", providers());

  assert.deepEqual(outcomes.map((o) => [o.provider_id, o.outcome]), [["agent-a", "relinked"], ["agent-b", "copy-left"]]);
  assert.match(outcomes[1].message, /old copy left at .*old-tool/);
  // agent-a: old link gone, new link resolves to the renamed folder.
  assert.equal(fs.existsSync(path.join(provA, "old-tool")), false);
  assert.equal(path.resolve(rawLinkTarget(path.join(provA, "new-tool"))!).toLowerCase(), path.resolve(skill("new-tool")).toLowerCase());
  assert.equal(fs.readFileSync(path.join(provA, "new-tool", "SKILL.md"), "utf8").includes("name: old-tool"), true);
  // agent-b: the real folder is untouched; the new name is linked.
  assert.equal(fs.readFileSync(path.join(provB, "old-tool", "SKILL.md"), "utf8"), "copy\n");
  assert.ok(rawLinkTarget(path.join(provB, "new-tool")));
  // agent-c: nothing created.
  assert.deepEqual(fs.readdirSync(provC), []);
});

test("rename never replaces a real folder already named like the new skill", async () => {
  const { renameVaultSkill } = await import("./skillLifecycle.ts");
  fs.mkdirSync(path.join(provA, "new-tool"));
  fs.writeFileSync(path.join(provA, "new-tool", "keep.md"), "mine\n");
  const outcomes = await renameVaultSkill(vault, "old-tool", "new-tool", providers());
  const a = outcomes.find((o) => o.provider_id === "agent-a")!;
  assert.equal(a.outcome, "error");
  assert.equal(fs.readFileSync(path.join(provA, "new-tool", "keep.md"), "utf8"), "mine\n");
});

test("delete removes only provider links to the deleted folder, never real folders", async () => {
  const { deleteVaultSkill } = await import("./skillLifecycle.ts");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "sv-plother-"));
  fs.symlinkSync(other, path.join(provC, "old-tool"), "junction"); // a link, but not to our folder
  const outcomes = deleteVaultSkill(vault, "old-tool", providers());
  assert.deepEqual(outcomes.map((o) => [o.provider_id, o.outcome]), [["agent-a", "removed"]]);
  assert.equal(fs.existsSync(path.join(provA, "old-tool")), false);
  assert.ok(fs.lstatSync(path.join(provA)).isDirectory());
  assert.equal(fs.readFileSync(path.join(provB, "old-tool", "SKILL.md"), "utf8"), "copy\n");
  assert.ok(fs.existsSync(path.join(provC, "old-tool")), "a foreign link is left alone");
  assert.ok(fs.existsSync(other));
});

test("a folder locked by another program → SkillOpError 409 in_use", { skip: os.platform() !== "win32" }, async () => {
  const { renameVaultSkill, SkillOpError, IN_USE_MESSAGE, defaultRenameHooks } = await import("./skillLifecycle.ts");
  // An open handle on a file inside the folder blocks a directory rename on Windows.
  const fd = fs.openSync(path.join(skill("old-tool"), "SKILL.md"), "r");
  try {
    await assert.rejects(
      renameVaultSkill(vault, "old-tool", "new-tool", providers(), { ...defaultRenameHooks, sleep: async () => {} }),
      (err: unknown) => err instanceof SkillOpError && err.status === 409 && err.code === "in_use" && err.message === IN_USE_MESSAGE,
    );
  } finally {
    fs.closeSync(fd);
  }
  assert.ok(fs.existsSync(skill("old-tool")));
  assert.ok(fs.existsSync(path.join(provA, "old-tool")), "provider links untouched when the rename failed");
});

// ── watcher pause + retry ───────────────────────────────────────

function lockError(code = "EPERM") {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

test("the vault watcher is paused around the folder rename and rebuilt afterwards", async () => {
  const { renameVaultSkill, defaultRenameHooks } = await import("./skillLifecycle.ts");
  const order: string[] = [];
  const hooks = {
    ...defaultRenameHooks,
    pauseWatcher: async () => {
      order.push("close");
      return true;
    },
    resumeWatcher: () => order.push("rebuild"),
    renameDir: (vp: string, a: string, b: string) => {
      order.push("rename");
      defaultRenameHooks.renameDir(vp, a, b);
    },
  };
  await renameVaultSkill(vault, "old-tool", "new-tool", [], hooks);
  assert.deepEqual(order, ["close", "rename", "rebuild"]);
  assert.ok(fs.existsSync(skill("new-tool")));
});

test("the watcher is rebuilt even when the rename fails; locks are retried, then in_use", async () => {
  const { renameVaultSkill, defaultRenameHooks, SkillOpError, RENAME_ATTEMPTS } = await import("./skillLifecycle.ts");
  const order: string[] = [];
  const sleeps: number[] = [];
  const hooks = {
    ...defaultRenameHooks,
    pauseWatcher: async () => {
      order.push("close");
      return true;
    },
    resumeWatcher: () => order.push("rebuild"),
    renameDir: () => {
      order.push("rename");
      throw lockError("EBUSY");
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  await assert.rejects(renameVaultSkill(vault, "old-tool", "new-tool", [], hooks), (err: unknown) => {
    return err instanceof SkillOpError && err.code === "in_use" && /another Skill Vault window/.test(err.message);
  });
  assert.deepEqual(order, ["close", ...Array(RENAME_ATTEMPTS).fill("rename"), "rebuild"]);
  assert.equal(sleeps.length, RENAME_ATTEMPTS - 1);
  assert.ok(sleeps.every((ms) => ms >= 100 && ms <= 400));
  assert.ok(fs.existsSync(skill("old-tool")));

  // A non-lock error is not retried, and the watcher is still rebuilt.
  order.length = 0;
  await assert.rejects(
    renameVaultSkill(vault, "old-tool", "new-tool", [], {
      ...hooks,
      renameDir: () => {
        order.push("rename");
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      },
    }),
    /ENOSPC/,
  );
  assert.deepEqual(order, ["close", "rename", "rebuild"]);
});

test("a transient lock is retried and the rename succeeds on the 3rd attempt", async () => {
  const { renameVaultSkill, defaultRenameHooks } = await import("./skillLifecycle.ts");
  let attempts = 0;
  const outcomes = await renameVaultSkill(vault, "old-tool", "new-tool", providers(), {
    ...defaultRenameHooks,
    pauseWatcher: async () => false,
    sleep: async () => {},
    renameDir: (vp: string, a: string, b: string) => {
      attempts++;
      if (attempts < 3) throw lockError();
      defaultRenameHooks.renameDir(vp, a, b);
    },
  });
  assert.equal(attempts, 3);
  assert.ok(fs.existsSync(skill("new-tool")));
  assert.deepEqual(outcomes.map((o) => o.outcome), ["relinked", "copy-left"]);
});

test("default hooks close the active watcher and schedule a rebuild", async () => {
  const { renameVaultSkill } = await import("./skillLifecycle.ts");
  const watcher = await import("./watcher.ts");
  let closed = 0;
  watcher.setActiveWatcher({ close: async () => void closed++ } as any);
  try {
    await renameVaultSkill(vault, "old-tool", "new-tool", []);
    assert.equal(closed, 1);
    assert.ok(fs.existsSync(skill("new-tool")));
  } finally {
    watcher.__resetWatcherForTests(); // cancels the pending (debounced) rebuild
  }
});
