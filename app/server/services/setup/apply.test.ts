import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import type { SetupConfigPatch } from "../appConfig.ts";
import { SetupBusyError, configPatch, createSetupApplier, type SetupApplyDeps, type SetupEvent } from "./apply.ts";
import { startDraft } from "./draft.ts";
import type { SetupDraft } from "./types.ts";

const emptyBase = { vault_path: null, agent_locations: {}, default_targets: [], machine_id: "PC", repo_url: null };

function harness(over: Partial<SetupApplyDeps> = {}) {
  const calls = { init: [] as string[], config: [] as SetupConfigPatch[], adopt: [] as string[], push: [] as string[], notion: 0, draftDeleted: 0, watcher: 0 };
  const deps: SetupApplyDeps = {
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    readConfig: () => ({ vault_path: null, providers: [], default_targets: [] }),
    initVault: (p) => {
      calls.init.push(p);
      fs.mkdirSync(path.join(p, "skills"), { recursive: true });
    },
    writeConfig: (p) => {
      calls.config.push(p);
    },
    rebuildWatcher: () => {
      calls.watcher++;
    },
    adopt: (_v, item) => {
      calls.adopt.push(item.name);
      return "imported";
    },
    push: (_v, skill, provider) => {
      calls.push.push(`${skill}->${provider.id}`);
    },
    saveNotion: async () => {
      calls.notion++;
      return {};
    },
    deleteDraft: () => {
      calls.draftDeleted++;
    },
    ...over,
  };
  return { deps, calls, applier: createSetupApplier(deps) };
}

function draftWith(patch: Partial<SetupDraft>): SetupDraft {
  return { ...startDraft(emptyBase), ...patch };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-apply-"));

test("new vault: folder, config, items, then the draft is deleted", async () => {
  const root = tmp();
  try {
    const t1 = path.join(root, "t1");
    fs.mkdirSync(path.join(t1, "found"), { recursive: true });
    const { applier, calls } = harness();
    const events: SetupEvent[] = [];
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [{ id: "t1", path: t1, enabled: true, is_default: true, known: false }],
      skills: { adopt: [{ name: "found", from: "t1" }], push: ["mine"] },
      notion: { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills", add_last_edited: true },
      assistant: { engine: "claude", auth: "api_key", workspace_id: "wrk" },
    });
    const state = await applier.apply({ draft, api_key: "sk-secret" }, (e) => events.push(e));
    assert.equal(state.ok, true);
    assert.ok(fs.existsSync(path.join(root, "vault")));
    assert.deepEqual(calls.init, [path.join(root, "vault")]);
    assert.deepEqual(calls.config[0], {
      vault_path: path.join(root, "vault"),
      providers: [{ id: "t1", path: t1 }],
      default_targets: ["t1"],
      repo_url: "",
      machine_id: "PC",
      assistant: { engine: "claude", auth: "api_key", workspace_id: "wrk", api_key: "sk-secret" },
    });
    assert.equal(calls.watcher, 1);
    assert.deepEqual(calls.adopt, ["found"]);
    assert.deepEqual(calls.push, ["mine->t1"]);
    assert.equal(calls.notion, 1);
    assert.equal(calls.draftDeleted, 1);
    assert.deepEqual(events.map((e) => `${e.step}:${e.state}`), [
      "vault:start", "vault:done", "config:start", "config:done",
      "adopt:start", "adopt:done", "push:start", "push:done", "notion:start", "notion:done", "done:done",
    ]);
    assert.ok(!JSON.stringify(events).includes("sk-secret"), "API key never in events");
    assert.ok(!JSON.stringify(applier.status()).includes("sk-secret"), "API key never in status");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new vault folder that isn't empty stops before config", async () => {
  const root = tmp();
  try {
    fs.writeFileSync(path.join(root, "x.txt"), "x");
    const { applier, calls } = harness();
    const state = await applier.apply({ draft: draftWith({ vault: { mode: "new", path: root } }) }, () => {});
    assert.equal(state.ok, false);
    assert.equal(state.vault_path, null);
    assert.match(state.events.at(-1)?.message ?? "", /isn't empty/);
    assert.equal(calls.config.length, 0);
    assert.equal(calls.draftDeleted, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clone: failure is plain words; success clones into dest and saves the repo URL", async () => {
  const root = tmp();
  try {
    const clone = { url: "https://github.com/me/v.git", dest: path.join(root, "v"), subdir: "skills", skill_names: [], notion: null };
    const failing: Run = async () => ({ code: 128, stdout: "", stderr: "remote: Repository not found." });
    const bad = harness({ run: failing });
    const failed = await bad.applier.apply({ draft: draftWith({ vault: { mode: "clone", path: path.join(clone.dest, "skills"), clone } }) }, () => {});
    assert.equal(failed.ok, false);
    assert.match(failed.events.at(-1)?.message ?? "", /wasn't found/);
    assert.equal(bad.calls.config.length, 0);

    const seen: string[][] = [];
    const cloning: Run = async (_cmd, args) => {
      seen.push(args);
      fs.mkdirSync(path.join(clone.dest, "skills"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    };
    const good = harness({ run: cloning });
    const ok = await good.applier.apply({ draft: draftWith({ vault: { mode: "clone", path: path.join(clone.dest, "skills"), clone } }) }, () => {});
    assert.equal(ok.ok, true);
    assert.deepEqual(seen[0], ["clone", "--quiet", "--", clone.url, clone.dest]);
    assert.equal(good.calls.config[0].vault_path, path.join(clone.dest, "skills"));
    assert.equal(good.calls.config[0].repo_url, clone.url);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a config write failure after a clone names the cloned folder", async () => {
  const root = tmp();
  try {
    const clone = { url: "https://github.com/me/v.git", dest: path.join(root, "v"), subdir: "", skill_names: [], notion: null };
    const { applier } = harness({
      run: async () => {
        fs.mkdirSync(clone.dest, { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      },
      writeConfig: () => {
        throw new Error("disk full");
      },
    });
    const state = await applier.apply({ draft: draftWith({ vault: { mode: "clone", path: clone.dest, clone } }) }, () => {});
    assert.equal(state.ok, false);
    assert.match(state.events.at(-1)?.message ?? "", /disk full/);
    assert.ok((state.events.at(-1)?.message ?? "").includes(clone.dest));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("item failures don't stop the job; retry re-runs only the failed ones", async () => {
  const root = tmp();
  try {
    const t1 = path.join(root, "t1");
    fs.mkdirSync(t1);
    let adoptFails = true;
    const { applier, calls } = harness({
      adopt: (_v, item) => {
        calls.adopt.push(item.name);
        if (adoptFails && item.name === "bad") throw new Error("locked");
        return "imported";
      },
      saveNotion: async () => ({ warning: "Could not add \"Last edited\"" }),
    });
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      targets: [{ id: "t1", path: t1, enabled: true, is_default: true, known: false }],
      skills: { adopt: [{ name: "bad", from: "t1" }, { name: "good", from: "t1" }, { name: "gone", from: "nope" }], push: ["p"] },
      notion: { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills", add_last_edited: true },
    });
    const first = await applier.apply({ draft }, () => {});
    assert.equal(first.ok, false);
    assert.deepEqual(first.failed.map((f) => f.item).sort(), ["bad (from t1)", "gone"]);
    assert.deepEqual(calls.push, ["p->t1"]);
    assert.ok(first.events.some((e) => e.step === "notion" && e.message?.includes("Last edited")));

    adoptFails = false;
    calls.adopt.length = 0;
    const second = await applier.retry(() => {});
    assert.deepEqual(calls.adopt, ["bad"]);
    assert.deepEqual(second.failed.map((f) => f.item), ["gone"]);
    assert.equal(second.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one job at a time", async () => {
  const root = tmp();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { applier } = harness({
      saveNotion: async () => {
        await gate;
        return {};
      },
    });
    const draft = draftWith({
      vault: { mode: "new", path: path.join(root, "vault") },
      notion: { data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "", add_last_edited: false },
    });
    const first = applier.apply({ draft }, () => {});
    assert.equal(applier.isRunning(), true);
    await assert.rejects(applier.apply({ draft }, () => {}), SetupBusyError);
    release();
    await first;
    assert.equal(applier.isRunning(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skip on targets and assistant leaves them out of the config patch", async () => {
  const root = tmp();
  try {
    const { applier, calls } = harness();
    await applier.apply({ draft: draftWith({ vault: { mode: "new", path: path.join(root, "vault") } }) }, () => {});
    assert.deepEqual(Object.keys(calls.config[0]).sort(), ["machine_id", "repo_url", "vault_path"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a watcher failure after the config write is a note, not a failure", async () => {
  const root = tmp();
  try {
    const { applier, calls } = harness({
      rebuildWatcher: () => {
        throw new Error("watch limit");
      },
    });
    const state = await applier.apply({ draft: draftWith({ vault: { mode: "new", path: path.join(root, "vault") } }) }, () => {});
    assert.equal(state.ok, true);
    assert.equal(state.vault_path, path.join(root, "vault"));
    assert.equal(calls.draftDeleted, 1);
    const cfg = state.events.find((e) => e.step === "config" && e.state === "done");
    assert.equal(cfg?.message, "Settings saved. Restart Skill Vault to watch the new folders.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new vault folder holding only an empty skeleton can be re-run; anything else is refused", async () => {
  const root = tmp();
  try {
    const skeleton = path.join(root, "a");
    fs.mkdirSync(path.join(skeleton, "skills"), { recursive: true });
    fs.writeFileSync(path.join(skeleton, "skills.json"), '{"skills":{}}');
    const ok = await harness().applier.apply({ draft: draftWith({ vault: { mode: "new", path: skeleton } }) }, () => {});
    assert.equal(ok.ok, true);

    const extra = path.join(root, "b");
    fs.mkdirSync(path.join(extra, "skills"), { recursive: true });
    fs.writeFileSync(path.join(extra, "skills.json"), '{"skills":{}}');
    fs.writeFileSync(path.join(extra, "notes.txt"), "x");
    const bad = await harness().applier.apply({ draft: draftWith({ vault: { mode: "new", path: extra } }) }, () => {});
    assert.equal(bad.ok, false);
    assert.match(bad.events.at(-1)?.message ?? "", /isn't empty/);

    const broken = path.join(root, "c");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, "skills.json"), "{not json");
    const bad2 = await harness().applier.apply({ draft: draftWith({ vault: { mode: "new", path: broken } }) }, () => {});
    assert.equal(bad2.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configPatch: a non-Claude engine writes engine + engines.<id> auth, never Claude's fields", () => {
  const vault = { mode: "new" as const, path: "C:\\v" };
  const codex = configPatch(draftWith({ vault, assistant: { engine: "codex", auth: "api_key" } }), [], " sk-o ");
  assert.deepEqual(codex.assistant, { engine: "codex", engine_auth: { auth: "api_key", api_key: "sk-o" } });
  const claude = configPatch(draftWith({ vault, assistant: { engine: "claude", auth: "login" } }), []);
  assert.deepEqual(claude.assistant, { engine: "claude", auth: "login", workspace_id: "" });
});
