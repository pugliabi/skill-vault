import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

// Conflicts API with a fake Notion API / archive / upload and a fake Claude
// runner — nothing here touches the network or the real CLI. USERPROFILE /
// HOME point at a temp home BEFORE any app module is imported.

let vault: string;
let fakeHome: string;
let notionDir: string;
let server: Server;
let base: string;
let state: { version: number; claude: boolean; connected: boolean };
let calls: Array<[string, ...unknown[]]>;
let uploads: Array<{ pageId: string; files: Record<string, string> }>;
let claudeStdin: string[];
let claudeOutput: unknown;

function writeTree(root: string, files: Record<string, string | Buffer>) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readTree(root: string, rel = "", out: Record<string, string> = {}): Record<string, string> {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) readTree(root, r, out);
    else out[r] = fs.readFileSync(path.join(root, r), "latin1");
  }
  return out;
}

const skillPath = (name = "alpha") => path.join(vault, "skills", name);
const manifest = () => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
const link = (name = "alpha") => manifest().skills[name].notion;

const BIN_VAULT = Buffer.from([0, 1, 2, 3]);
const BIN_NOTION = Buffer.from([0, 9, 9, 9]);
const VAULT_MD = "---\nname: alpha\ndescription: d\n---\nl1\nvault l2\nl3\n";
const NOTION_MD = "---\nname: alpha\ndescription: d\nnotion_page_id: p-alpha\n---\nl1\nnotion l2\nl3\n";

/** A linked skill in conflict: SKILL.md + a binary differ, refs/same.md is identical. */
async function seedConflict(linkExtra: Record<string, unknown> = {}) {
  const { recordVersion } = await import("../services/history.ts");
  writeTree(skillPath(), { "SKILL.md": VAULT_MD, "refs/same.md": "same\n", "img.bin": BIN_VAULT, "vault-only.md": "v\n" });
  // Base = the Notion copy at the last sync.
  writeTree(notionDir, { "SKILL.md": NOTION_MD.replace("notion l2", "l2"), "refs/same.md": "same\n", "img.bin": BIN_VAULT });
  const nv = recordVersion(vault, "alpha", { side: "notion", source: "notion-edit", dir: notionDir })!;
  writeTree(notionDir, { "SKILL.md": NOTION_MD, "refs/same.md": "same\n", "img.bin": BIN_NOTION });
  const m = manifest();
  m.skills.alpha.notion = {
    page_id: "p-alpha",
    state: "linked",
    linked_at: "2026-01-01T00:00:00.000Z",
    notion_version_id: "v1",
    notion_title: "alpha",
    base_notion_version: nv.id,
    ...linkExtra,
  };
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m));
}

before(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-chome-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-cvault-"));
  notionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-cnotion-")), "alpha");
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".skill-vault", "config.json"), JSON.stringify({ vault_path: vault }) + "\n");
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { notionRouter, claudeRouter } = await import("./notion.ts");
  const { diffRouter } = await import("./diff.ts");
  const { NotionNotConnectedError } = await import("../services/notion/connection.ts");

  const api = {
    downloadSkill: async (id: string) => {
      calls.push(["downloadSkill", id]);
      return { versionId: `v${state.version}`, url: `archive:${id}` };
    },
    setTitle: async (id: string, title: string) => {
      calls.push(["setTitle", id, title]);
    },
  } as any;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/notion",
    notionRouter({
      openApi: async () => {
        if (!state.connected) throw new NotionNotConnectedError();
        return { api, close: async () => {} };
      },
      extract: async (url) => {
        calls.push(["extract", url]);
        return { skillRoot: notionDir, cleanup() {} };
      },
      upload: async (_api, pageId, dir) => {
        const files = readTree(dir);
        uploads.push({ pageId, files });
        const tree: Record<string, string | Buffer> = {};
        for (const [rel, c] of Object.entries(files)) tree[rel] = Buffer.from(c, "latin1");
        tree["SKILL.md"] = files["SKILL.md"].replace(/\n---\n/, `\nnotion_page_id: ${pageId}\n---\n`);
        writeTree(notionDir, tree);
        state.version++;
      },
      claudeStatus: async () => (state.claude ? { available: true, version: "9.9.9" } : { available: false, reason: "not installed" }),
      claudeRunner: async (_args, stdin) => {
        claudeStdin.push(stdin);
        return {
          stdout: JSON.stringify({ is_error: false, structured_output: claudeOutput, total_cost_usd: 0.01 }),
          stderr: "",
          code: 0,
        };
      },
    }),
  );
  app.use("/api/claude", claudeRouter({ claudeStatus: async () => ({ available: true, version: "9.9.9" }) }));
  app.use("/api/diff", diffRouter());
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(path.dirname(notionDir), { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(vault, ".history"), { recursive: true, force: true });
  fs.writeFileSync(
    path.join(vault, "skills.json"),
    JSON.stringify({
      skills: {
        alpha: { targets: [] },
        old: { targets: [], notion: { page_id: "p-old", state: "legacy", linked_at: "t" } },
        fine: { targets: [], notion: { page_id: "p-fine", state: "linked", linked_at: "t", synced_at: "t" } },
      },
    }),
  );
  fs.writeFileSync(path.join(vault, "notion.json"), JSON.stringify({ data_source_id: "ds" }));
  fs.writeFileSync(path.join(fakeHome, ".skill-vault", "notion-auth.json"), JSON.stringify({ tokens: { access_token: "x" } }));
  state = { version: 1, claude: true, connected: true };
  calls = [];
  uploads = [];
  claudeStdin = [];
  claudeOutput = undefined;
});

const vaultHash = async () => (await import("../services/skillHash.ts")).hashSkillDirNormalized(skillPath());

const post = (url: string, body: unknown) =>
  fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("conflict routes return 401 when Notion is not connected", async () => {
  await seedConflict();
  fs.rmSync(path.join(fakeHome, ".skill-vault", "notion-auth.json"));
  state.connected = false;
  let res = await fetch(`${base}/notion/conflicts`);
  assert.equal(res.status, 401);
  res = await fetch(`${base}/notion/conflicts/alpha`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "notion_not_connected" });
  res = await post("/notion/conflicts/alpha/resolve", { mode: "keep-vault", expected_notion_version: "v1" });
  assert.equal(res.status, 401);
});

test("GET /conflicts lists linked never-synced skills, not legacy or synced ones", async () => {
  await seedConflict();
  const res = await fetch(`${base}/notion/conflicts`);
  assert.equal(res.status, 200);
  const { skills } = (await res.json()) as { skills: Array<Record<string, unknown>> };
  assert.deepEqual(skills.map((s) => s.name), ["alpha"]);
  assert.equal(skills[0].notion_title, "alpha");
  assert.equal(typeof skills[0].vault_edited_at, "string");
});

test("GET /conflicts/:name returns both sides, base, flags and Notion's version id", async () => {
  await seedConflict();
  const res = await fetch(`${base}/notion/conflicts/alpha`);
  assert.equal(res.status, 200);
  const snap = (await res.json()) as any;
  assert.equal(snap.name, "alpha");
  assert.equal(snap.notion_version_id, "v1");
  assert.equal(snap.base_available, true);
  assert.equal(snap.vault_hash, await vaultHash());
  const md = snap.files.find((f: any) => f.path === "SKILL.md");
  assert.equal(md.vault, VAULT_MD);
  assert.equal(md.notion, NOTION_MD.replace("notion_page_id: p-alpha\n", ""), "notion_page_id is stripped");
  assert.equal(md.base, VAULT_MD.replace("vault l2", "l2"));
  assert.equal(md.same, false);
  const img = snap.files.find((f: any) => f.path === "img.bin");
  assert.deepEqual([img.binary, img.vault, img.notion], [true, null, null]);
  assert.equal(snap.files.find((f: any) => f.path === "refs/same.md").same, true);
  assert.equal(snap.files.find((f: any) => f.path === "vault-only.md").notion, null);
  const diffPaths = snap.diff_vault_vs_notion.files.filter((f: any) => f.change !== "same").map((f: any) => f.path);
  assert.deepEqual(diffPaths, ["SKILL.md", "img.bin", "vault-only.md"]);
});

test("legacy links are refused", async () => {
  await seedConflict();
  let res = await fetch(`${base}/notion/conflicts/old`);
  assert.equal(res.status, 409);
  res = await post("/notion/conflicts/old/resolve", { mode: "keep-vault", expected_notion_version: "v1" });
  assert.equal(res.status, 409);
  assert.equal(uploads.length, 0);
});

test("merge returns 409 when Claude is unavailable, without calling Notion", async () => {
  await seedConflict();
  state.claude = false;
  const res = await post("/notion/conflicts/alpha/merge", {});
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "claude_unavailable", reason: "not installed" });
  assert.equal(calls.length, 0);
  assert.equal(claudeStdin.length, 0);
});

test("merge sends only the differing regions to Claude and returns the rebuilt files", async () => {
  await seedConflict();
  claudeOutput = {
    explanation: "e",
    vault_changes: ["v"],
    notion_changes: ["n"],
    hunks: [
      { id: "h1", choice: "notion", summary: "l2 changed on both sides", overlapping: true },
      { id: "h2", choice: "vault", summary: "vault-only file", overlapping: false },
      { id: "h9", choice: "notion", summary: "ghost", overlapping: false },
    ],
  };
  const res = await post("/notion/conflicts/alpha/merge", { expected_notion_version: "v1" });
  assert.equal(res.status, 200);
  const r = (await res.json()) as any;
  assert.equal(r.notion_version_id, "v1");
  assert.equal(r.cost_usd, 0.01);
  assert.deepEqual(r.decisions.map((d: any) => [d.id, d.file, d.chosen]), [["h1", "SKILL.md", "notion"], ["h2", "vault-only.md", "vault"]]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.files, [
    { path: "SKILL.md", content: VAULT_MD.replace("vault l2", "notion l2") },
    { path: "vault-only.md", content: "v\n" },
  ]);
  assert.equal(claudeStdin.length, 1);
  assert.match(claudeStdin[0], /=== File: SKILL\.md/);
  assert.match(claudeStdin[0], /=== File: vault-only\.md/);
  assert.match(claudeStdin[0], /Vault:\n"""\nvault l2\n"""/);
  assert.doesNotMatch(claudeStdin[0], /"""\nl1\nvault l2\nl3\n"""/, "whole files are never sent");
  assert.doesNotMatch(claudeStdin[0], /img\.bin|refs\/same\.md|notion_page_id/);
});

test("merge refuses a stale Notion version", async () => {
  await seedConflict();
  const res = await post("/notion/conflicts/alpha/merge", { expected_notion_version: "v0" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as any).error, "notion_changed");
  assert.equal(claudeStdin.length, 0);
});

test("resolve requires expected_notion_version and a valid mode", async () => {
  await seedConflict();
  assert.equal((await post("/notion/conflicts/alpha/resolve", { mode: "keep-vault" })).status, 400);
  assert.equal((await post("/notion/conflicts/alpha/resolve", { mode: "nope", expected_notion_version: "v1" })).status, 400);
  assert.equal(uploads.length, 0);
});

test("resolve returns 409 notion_changed when Notion moved since the conflict was opened", async () => {
  await seedConflict();
  state.version = 2;
  const res = await post("/notion/conflicts/alpha/resolve", { mode: "keep-vault", expected_notion_version: "v1" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as any).error, "notion_changed");
  assert.equal(uploads.length, 0);
  assert.equal(link().synced_at, undefined);
});

test("resolve keep-vault force-pushes the vault copy", async () => {
  await seedConflict();
  const res = await post("/notion/conflicts/alpha/resolve", { mode: "keep-vault", expected_notion_version: "v1" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, status: "unchecked" });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].files["SKILL.md"], VAULT_MD);
  assert.equal(link().notion_version_id, "v2");
  assert.ok(link().synced_at);
});

test("resolve keep-notion force-pulls Notion's copy", async () => {
  await seedConflict();
  const res = await post("/notion/conflicts/alpha/resolve", { mode: "keep-notion", expected_notion_version: "v1" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(uploads.length, 0);
  const tree = readTree(skillPath());
  assert.equal(tree["SKILL.md"], NOTION_MD.replace("notion_page_id: p-alpha\n", ""));
  assert.equal(tree["vault-only.md"], undefined);
  assert.ok(link().synced_at);
});

test("resolve files writes the resolved folder, records claude-merge history and pushes", async () => {
  await seedConflict();
  const res = await post("/notion/conflicts/alpha/resolve", {
    mode: "files",
    expected_notion_version: "v1",
    expected_vault_hash: await vaultHash(),
    files: [
      { path: "SKILL.md", content: "---\nname: alpha\ndescription: d\nnotion_page_id: p-alpha\n---\nl1\nmerged l2\nl3\n" },
      { path: "vault-only.md", content: null },
    ],
    binary_choices: { "img.bin": "notion" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const tree = readTree(skillPath());
  assert.equal(tree["SKILL.md"], "---\nname: alpha\ndescription: d\n---\nl1\nmerged l2\nl3\n", "notion_page_id stripped");
  assert.equal(tree["img.bin"], BIN_NOTION.toString("latin1"));
  assert.equal(tree["refs/same.md"], "same\n");
  assert.equal(tree["vault-only.md"], undefined);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].files["SKILL.md"], tree["SKILL.md"]);

  const { listVersions } = await import("../services/history.ts");
  const sources = listVersions(vault, "alpha").map((v) => `${v.side}:${v.source}`);
  assert.ok(sources.includes("vault:claude-merge"), sources.join(","));
  assert.ok(link().synced_at);
  assert.equal(link().notion_version_id, "v2");
});

test("resolve files with edited=true records the result as a vault edit", async () => {
  await seedConflict();
  const body = {
    mode: "files",
    expected_notion_version: "v1",
    expected_vault_hash: await vaultHash(),
    files: [
      { path: "SKILL.md", content: "---\nname: alpha\ndescription: d\n---\nhand edited\n" },
      { path: "vault-only.md", content: null },
    ],
    binary_choices: { "img.bin": "vault" },
  };
  const bad = await post("/notion/conflicts/alpha/resolve", { ...body, edited: "yes" });
  assert.equal(bad.status, 400);
  const res = await post("/notion/conflicts/alpha/resolve", { ...body, edited: true });
  assert.equal(res.status, 200, await res.clone().text());
  const { listVersions } = await import("../services/history.ts");
  const sources = listVersions(vault, "alpha").map((v) => `${v.side}:${v.source}`);
  assert.ok(sources.includes("vault:vault-edit"), sources.join(","));
  assert.ok(!sources.includes("vault:claude-merge"), sources.join(","));
});

test("resolve files rejects an incomplete resolution before touching anything", async () => {
  await seedConflict();
  const before = readTree(skillPath());
  let res = await post("/notion/conflicts/alpha/resolve", {
    mode: "files",
    expected_notion_version: "v1",
    expected_vault_hash: await vaultHash(),
    files: [{ path: "SKILL.md", content: "x" }, { path: "vault-only.md", content: null }],
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /img\.bin/);
  res = await post("/notion/conflicts/alpha/resolve", {
    mode: "files",
    expected_notion_version: "v1",
    expected_vault_hash: await vaultHash(),
    files: [{ path: "refs/same.md", content: "x" }],
    binary_choices: { "img.bin": "vault" },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(readTree(skillPath()), before);
  assert.equal(uploads.length, 0);
});

test("POST /api/diff/text returns line hunks", async () => {
  const res = await post("/diff/text", { a: "a\nb\n", b: "a\nc\n" });
  assert.equal(res.status, 200);
  const { hunks } = (await res.json()) as { hunks: Array<{ type: string; text: string }> };
  assert.deepEqual(hunks.filter((h) => h.type !== "ctx"), [
    { type: "del", text: "b" },
    { type: "add", text: "c" },
  ]);
  assert.equal((await post("/diff/text", { a: 1 })).status, 400);
});

test("GET /api/claude/status reports availability", async () => {
  const res = await fetch(`${base}/claude/status`);
  assert.deepEqual(await res.json(), { available: true, version: "9.9.9" });
});

test("resolve files needs expected_vault_hash and refuses when the vault changed since", async () => {
  await seedConflict();
  const body = {
    mode: "files",
    expected_notion_version: "v1",
    files: [{ path: "SKILL.md", content: VAULT_MD.replace("vault l2", "merged l2") }, { path: "vault-only.md", content: null }],
    binary_choices: { "img.bin": "vault" },
  };
  assert.equal((await post("/notion/conflicts/alpha/resolve", body)).status, 400);
  const hash = await vaultHash();
  fs.writeFileSync(path.join(skillPath(), "refs/same.md"), "edited meanwhile\n");
  const res = await post("/notion/conflicts/alpha/resolve", { ...body, expected_vault_hash: hash });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as any).error, "vault_changed");
  assert.equal(fs.readFileSync(path.join(skillPath(), "SKILL.md"), "utf8"), VAULT_MD);
  assert.equal(uploads.length, 0);
});

test("resolve files refuses a result without SKILL.md, and path traversal", async () => {
  await seedConflict();
  const before = readTree(skillPath());
  let res = await post("/notion/conflicts/alpha/resolve", {
    mode: "files",
    expected_notion_version: "v1",
    expected_vault_hash: await vaultHash(),
    files: [{ path: "SKILL.md", content: null }, { path: "vault-only.md", content: null }],
    binary_choices: { "img.bin": "vault" },
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /SKILL\.md/);
  res = await post("/notion/conflicts/alpha/resolve", {
    mode: "files",
    expected_notion_version: "v1",
    expected_vault_hash: await vaultHash(),
    files: [{ path: "../x", content: "x" }],
    binary_choices: { "img.bin": "vault" },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(readTree(skillPath()), before);
  assert.equal(fs.existsSync(path.join(vault, "skills", "x")), false);
  assert.equal(uploads.length, 0);
});
