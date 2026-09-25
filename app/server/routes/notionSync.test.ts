import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";

// Push/pull plan, run and force routes with a fake Notion API / archive /
// upload — nothing here touches the network. USERPROFILE / HOME point at a
// temp home BEFORE any app module is imported.

let vault: string;
let fakeHome: string;
let notionRoot: string;
let server: Server;
let base: string;
let versions: Map<string, number>;
let notionRows: Array<Record<string, any>>;
let calls: Array<[string, ...unknown[]]>;
let uploads: Array<{ pageId: string; name: string; md: string }>;
let failDownload: Set<string>;
let created: number;
/** When set, uploads wait for it — keeps a job running. */
let uploadGate: Promise<void> | null = null;
/** Fake multi-device guard status for /plan, /run and /force — see notionRouter({ gitGuard }) below. */
let guardStatus: { is_repo: boolean; behind: number; ahead: number; error?: string };

function writeTree(root: string, files: Record<string, string>) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

const skillPath = (name: string) => path.join(vault, "skills", name);
const notionPath = (page: string) => path.join(notionRoot, page);
const readManifest = () => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
const writeManifest = (m: unknown) => fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m));
const link = (name: string) => readManifest().skills[name]?.notion;
const md = (name: string, body = "body") => `---\nname: ${name}\ndescription: d\n---\n${body}\n`;
const cacheFile = () => path.join(fakeHome, ".skill-vault", "notion-cache.json");

function writeCache(checkedAt = new Date().toISOString()) {
  const rows = notionRows.map((r) => ({ ...r, version_id: versions.has(r.page_id) ? `${r.page_id}@${versions.get(r.page_id)}` : undefined }));
  fs.writeFileSync(cacheFile(), JSON.stringify({ checked_at: checkedAt, data_source_id: "ds", rows }));
}

/**
 * A linked, synced skill whose Notion page `page` holds the same content.
 * `vaultEdit` changes the vault copy after the sync; `notionEdit` bumps
 * Notion's version.
 */
async function seedLinked(
  name: string,
  page: string,
  opts: { vaultEdit?: boolean; notionEdit?: boolean; linkExtra?: Record<string, unknown>; title?: string } = {},
) {
  const { hashSkillDirNormalized } = await import("../services/skillHash.ts");
  const { recordVersion } = await import("../services/history.ts");
  writeTree(skillPath(name), { "SKILL.md": md(name) });
  writeTree(notionPath(page), { "SKILL.md": md(name) });
  const nv = recordVersion(vault, name, { side: "notion", source: "notion-edit", dir: notionPath(page) });
  versions.set(page, 1);
  const m = readManifest();
  m.skills[name] = {
    targets: [],
    notion: {
      page_id: page,
      state: "linked",
      linked_at: "2026-01-01T00:00:00.000Z",
      synced_at: "2026-01-01T00:00:00.000Z",
      vault_hash: hashSkillDirNormalized(skillPath(name)),
      notion_version_id: `${page}@1`,
      notion_title: opts.title ?? name,
      vault_name: name,
      ...(nv ? { base_notion_version: nv.id } : {}),
      ...opts.linkExtra,
    },
  };
  writeManifest(m);
  notionRows.push({ page_id: page, title: opts.title ?? name, description: "d", tags: [], has_files: false });
  if (opts.vaultEdit) fs.writeFileSync(path.join(skillPath(name), "SKILL.md"), md(name, "vault edit"));
  if (opts.notionEdit) {
    writeTree(notionPath(page), { "SKILL.md": md(name, "notion edit") });
    versions.set(page, 2);
  }
}

function seedUnlinked(name: string) {
  writeTree(skillPath(name), { "SKILL.md": md(name) });
  const m = readManifest();
  m.skills[name] = { targets: [] };
  writeManifest(m);
}

before(async () => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sv-shome-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-svault-"));
  notionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-snotion-"));
  fs.mkdirSync(path.join(fakeHome, ".skill-vault"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".skill-vault", "config.json"), JSON.stringify({ vault_path: vault }) + "\n");
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;

  const express = (await import("express")).default;
  const { notionRouter } = await import("./notion.ts");
  const { skillsRouter } = await import("./skills.ts");

  const api = {
    downloadSkill: async (id: string) => {
      calls.push(["downloadSkill", id]);
      if (failDownload.has(id) || !versions.has(id)) throw new Error(`page ${id} not found`);
      return { versionId: `${id}@${versions.get(id)}`, url: `archive:${id}` };
    },
    setTitle: async (id: string, title: string) => {
      calls.push(["setTitle", id, title]);
      const row = notionRows.find((r) => r.page_id === id);
      if (row) row.title = title;
    },
    listRows: async () => {
      calls.push(["listRows"]);
      return notionRows.map((r) => ({ ...r }));
    },
    createSkillPage: async (_ds: string, name: string) => {
      const page = `new-${++created}`;
      calls.push(["createSkillPage", name, page]);
      versions.set(page, 0);
      fs.mkdirSync(notionPath(page), { recursive: true });
      notionRows.push({ page_id: page, title: name, description: "d", tags: [], has_files: false });
      return page;
    },
  } as any;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/notion",
    notionRouter({
      openApi: async () => ({ api, close: async () => {} }),
      gitGuard: async () => guardStatus,
      extract: async (url) => {
        const page = url.replace(/^archive:/, "");
        calls.push(["extract", page]);
        return { skillRoot: notionPath(page), cleanup() {} };
      },
      upload: async (_api, pageId, dir, name) => {
        if (uploadGate) await uploadGate;
        uploads.push({ pageId, name, md: fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") });
        writeTree(notionPath(pageId), { "SKILL.md": fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") });
        versions.set(pageId, (versions.get(pageId) ?? 0) + 1);
      },
    }),
  );
  app.use("/api/skills", skillsRouter());
  app.use((err: Error, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of [vault, fakeHome, notionRoot]) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  for (const d of ["skills", ".history"]) fs.rmSync(path.join(vault, d), { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, "skills"));
  fs.rmSync(notionRoot, { recursive: true, force: true });
  fs.mkdirSync(notionRoot);
  writeManifest({ skills: {} });
  fs.writeFileSync(path.join(vault, "notion.json"), JSON.stringify({ data_source_id: "ds" }));
  fs.writeFileSync(path.join(fakeHome, ".skill-vault", "notion-auth.json"), JSON.stringify({ tokens: { access_token: "x" } }));
  versions = new Map();
  notionRows = [];
  calls = [];
  uploads = [];
  failDownload = new Set();
  created = 0;
  guardStatus = { is_repo: false, behind: 0, ahead: 0 };
});

const post = (url: string, body: unknown) =>
  fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function plan(direction: "push" | "pull") {
  const res = await fetch(`${base}/notion/plan?direction=${direction}`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as { rows: Array<Record<string, any>>; guard: unknown; stats: any };
}

async function waitJob(id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await (await fetch(`${base}/notion/run/${id}`)).json()) as any;
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not finish");
}

async function run(direction: "push" | "pull", rows: Array<{ id: string; action?: string }>) {
  const res = await post("/notion/run", { direction, rows });
  assert.equal(res.status, 200, await res.clone().text());
  return waitJob(((await res.json()) as any).job_id);
}

async function force(direction: "push" | "pull", skills?: string[]) {
  const res = await post("/notion/force", { direction, ...(skills ? { skills } : {}) });
  assert.equal(res.status, 200, await res.clone().text());
  return waitJob(((await res.json()) as any).job_id);
}

test("plan refreshes a stale cache and returns rows + guard status", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  seedUnlinked("fresh");
  writeCache("2020-01-01T00:00:00.000Z");
  const p = await plan("push");
  assert.ok(calls.some((c) => c[0] === "listRows"), "stale cache was refreshed");
  assert.deepEqual(p.guard, { is_repo: false, behind: 0, ahead: 0 });
  assert.deepEqual(p.rows.map((r) => r.id).sort(), ["push:new:fresh", "push:update:alpha"]);
  assert.equal(p.stats.by_kind.update, 1);

  calls = [];
  await plan("push");
  assert.ok(!calls.some((c) => c[0] === "listRows"), "fresh cache is reused");
});

test("plan requires a direction and a connection", async () => {
  assert.equal((await fetch(`${base}/notion/plan?direction=sideways`)).status, 400);
  fs.rmSync(path.join(fakeHome, ".skill-vault", "notion-auth.json"));
  assert.equal((await fetch(`${base}/notion/plan?direction=push`)).status, 401);
});

test("run executes only the selected rows", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  await seedLinked("beta", "p-beta", { vaultEdit: true });
  writeCache();
  const job = await run("push", [{ id: "push:update:alpha" }]);
  assert.deepEqual(job.results, [{ id: "push:update:alpha", ok: true, message: "pushed" }]);
  assert.deepEqual(uploads.map((u) => u.pageId), ["p-alpha"]);
  assert.equal(link("alpha").notion_version_id, "p-alpha@2");
  assert.equal(link("beta").notion_version_id, "p-beta@1");
  // The pushed row is gone from the next plan; the other remains.
  assert.deepEqual((await plan("push")).rows.map((r) => r.id), ["push:update:beta"]);
});

test("a failing row does not stop the others", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  await seedLinked("beta", "p-beta", { vaultEdit: true });
  writeCache();
  failDownload.add("p-alpha");
  const job = await run("push", [{ id: "push:update:alpha" }, { id: "push:update:beta" }, { id: "push:update:ghost" }]);
  assert.equal(job.total, 3);
  assert.equal(job.done, 3);
  assert.deepEqual(job.results.map((r: any) => [r.id, r.ok]), [
    ["push:update:alpha", false],
    ["push:update:beta", true],
    ["push:update:ghost", false],
  ]);
  assert.match(job.results[0].error, /not found/);
  assert.match(job.results[2].error, /no longer in the plan/);
  assert.deepEqual(uploads.map((u) => u.pageId), ["p-beta"]);
});

test("conflict rows are rejected for the whole request", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true, notionEdit: true });
  await seedLinked("beta", "p-beta", { vaultEdit: true });
  writeCache();
  const p = await plan("push");
  assert.ok(p.rows.some((r) => r.id === "push:conflict:alpha"));
  const res = await post("/notion/run", {
    direction: "push",
    rows: [{ id: "push:update:beta" }, { id: "push:conflict:alpha" }],
  });
  assert.equal(res.status, 400);
  assert.equal(uploads.length, 0);
  // A direction mismatch is also refused.
  assert.equal((await post("/notion/run", { direction: "pull", rows: [{ id: "push:update:beta" }] })).status, 400);
  assert.equal((await post("/notion/run", { direction: "push", rows: [] })).status, 400);
});

test("pull update merges Notion's change into the vault", async () => {
  await seedLinked("alpha", "p-alpha", { notionEdit: true });
  writeCache();
  const p = await plan("pull");
  assert.deepEqual(p.rows.map((r) => r.id), ["pull:update:alpha"]);
  const job = await run("pull", [{ id: "pull:update:alpha" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.match(fs.readFileSync(path.join(skillPath("alpha"), "SKILL.md"), "utf8"), /notion edit/);
});

test("pull new adopts the Notion skill into the vault", async () => {
  versions.set("p-gamma", 1);
  writeTree(notionPath("p-gamma"), { "SKILL.md": md("gamma") });
  notionRows.push({ page_id: "p-gamma", title: "gamma", description: "d", tags: [], has_files: false });
  writeCache();
  const job = await run("pull", [{ id: "pull:new:p-gamma" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.equal(link("gamma").page_id, "p-gamma");
  assert.ok(fs.existsSync(path.join(skillPath("gamma"), "SKILL.md")));
});

test("push rename sets the Notion title, pushes, and records the new names", async () => {
  await seedLinked("renamed", "p-alpha", { linkExtra: { vault_name: "alpha", notion_title: "alpha" }, title: "alpha" });
  // A folder rename leaves the frontmatter name behind (CRLF file here).
  const crlf = (name: string) => ["---", `name: ${name}`, "description: d", "---", "body", ""].join("\r\n");
  fs.writeFileSync(path.join(skillPath("renamed"), "SKILL.md"), crlf("alpha"));
  writeCache();
  const p = await plan("push");
  assert.deepEqual(p.rows.map((r) => r.id), ["push:rename:renamed"]);
  const job = await run("push", [{ id: "push:rename:renamed" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.deepEqual(calls.find((c) => c[0] === "setTitle"), ["setTitle", "p-alpha", "renamed"]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].md, crlf("renamed"), "upload carries the new name");
  assert.equal(fs.readFileSync(path.join(skillPath("renamed"), "SKILL.md"), "utf8"), crlf("renamed"));
  assert.equal(link("renamed").notion_title, "renamed");
  assert.equal(link("renamed").vault_name, "renamed");
  // No title restore back to the old name after the upload.
  assert.ok(!calls.some((c) => c[0] === "setTitle" && c[2] === "alpha"));
});

test("pull rename renames the vault folder via the shared rename helper; collisions are row errors", async () => {
  await seedLinked("alpha", "p-alpha");
  notionRows[0].title = "alpha-two";
  await seedLinked("beta", "p-beta");
  notionRows[1].title = "taken";
  seedUnlinked("taken");
  writeCache();
  const p = await plan("pull");
  assert.deepEqual(p.rows.map((r) => r.id).sort(), ["pull:rename:alpha", "pull:rename:beta"]);
  const job = await run("pull", [{ id: "pull:rename:alpha" }, { id: "pull:rename:beta" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.equal(job.results[1].ok, false);
  assert.match(job.results[1].error, /already exists/);
  assert.ok(fs.existsSync(skillPath("alpha-two")));
  assert.equal(fs.readFileSync(path.join(skillPath("alpha-two"), "SKILL.md"), "utf8"), md("alpha-two"), "frontmatter name follows the rename");
  assert.ok(!fs.existsSync(skillPath("alpha")));
  assert.equal(link("alpha-two").notion_title, "alpha-two");
  assert.equal(link("alpha-two").vault_name, "alpha-two");
  const { listVersions } = await import("../services/history.ts");
  assert.ok(listVersions(vault, "alpha-two").some((v) => v.source === "rename"));
  assert.ok(fs.existsSync(skillPath("beta")), "collision leaves the folder alone");
});

test("pull rename of an in-sync skill leaves it synced (hash + vault base follow the rename)", async () => {
  await seedLinked("alpha", "p-alpha");
  notionRows[0].title = "alpha-two";
  writeCache();
  const job = await run("pull", [{ id: "pull:rename:alpha" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  const { hashSkillDirNormalized } = await import("../services/skillHash.ts");
  const { listVersions } = await import("../services/history.ts");
  assert.equal(link("alpha-two").vault_hash, hashSkillDirNormalized(skillPath("alpha-two")));
  assert.equal(link("alpha-two").base_vault_version, listVersions(vault, "alpha-two").find((v) => v.side === "vault")!.id);
  const { listSkills } = await import("../services/vault.ts");
  assert.equal(listSkills(vault).find((s) => s.name === "alpha-two")!.notion_status, "synced");
  assert.deepEqual((await plan("push")).rows, []);
  assert.deepEqual((await plan("pull")).rows, []);
});

test("pull rename + Notion edit → next pull is an update row, not a conflict", async () => {
  await seedLinked("alpha", "p-alpha", { notionEdit: true });
  notionRows[0].title = "alpha-two";
  writeCache();
  assert.deepEqual((await plan("pull")).rows.map((r) => r.id), ["pull:rename:alpha"]);
  const job = await run("pull", [{ id: "pull:rename:alpha" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.deepEqual((await plan("pull")).rows.map((r) => r.id), ["pull:update:alpha-two"]);
});

test("pull rename of a vault-edited skill keeps the vault change visible (push update, not synced)", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  notionRows[0].title = "alpha-two";
  writeCache();
  const job = await run("pull", [{ id: "pull:rename:alpha" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.deepEqual((await plan("push")).rows.map((r) => r.id), ["push:update:alpha-two"]);
});

test("deleted rows: trash is refused with guidance, unlink and delete-from-vault work", async () => {
  // Deleted in the vault (folder gone, history present).
  await seedLinked("gone", "p-gone");
  fs.rmSync(skillPath("gone"), { recursive: true });
  // Deleted in Notion (page missing from the data source).
  await seedLinked("orphan", "p-orphan");
  notionRows = notionRows.filter((r) => r.page_id !== "p-orphan");
  writeCache();

  const push = await plan("push");
  const gone = push.rows.find((r) => r.id === "push:deleted:gone")!;
  assert.deepEqual(gone.actions, ["unlink", "trash"]);
  let job = await run("push", [{ id: "push:deleted:gone", action: "trash" }]);
  assert.equal(job.results[0].ok, false);
  assert.match(job.results[0].error, /Move it to trash in Notion, then Unlink/);
  assert.ok(!calls.some((c) => c[0] === "setTitle"), "no Notion write was attempted");
  job = await run("push", [{ id: "push:deleted:gone", action: "unlink" }]);
  assert.equal(job.results[0].ok, true);
  assert.equal(link("gone").state, "unlinked");

  const pull = await plan("pull");
  assert.deepEqual(pull.rows.find((r) => r.id === "pull:deleted:orphan")!.actions, ["unlink", "delete-vault", "recreate"]);
  job = await run("pull", [{ id: "pull:deleted:orphan", action: "bogus" }]);
  assert.equal(job.results[0].ok, false);
  job = await run("pull", [{ id: "pull:deleted:orphan", action: "delete-vault" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.ok(!fs.existsSync(skillPath("orphan")));
  assert.equal(readManifest().skills.orphan, undefined);
  const { listVersions } = await import("../services/history.ts");
  assert.ok(listVersions(vault, "orphan").some((v) => v.source === "delete"), "delete recorded in history");
});

test("deleted in Notion → recreate makes a new page and relinks", async () => {
  await seedLinked("orphan", "p-orphan");
  notionRows = [];
  versions.delete("p-orphan");
  writeCache();
  const job = await run("push", [{ id: "push:deleted:orphan", action: "recreate" }]);
  assert.equal(job.results[0].ok, true, job.results[0].error);
  assert.equal(link("orphan").page_id, "new-1");
  assert.ok(link("orphan").synced_at);
});

test("force push never deletes, skips legacy, and only creates pages for listed skills", async () => {
  await seedLinked("alpha", "p-alpha", { notionEdit: true });
  await seedLinked("gone", "p-gone");
  fs.rmSync(skillPath("gone"), { recursive: true });
  await seedLinked("old", "p-old", { linkExtra: { state: "legacy" } });
  seedUnlinked("fresh");
  writeCache();

  let job = await force("push");
  assert.deepEqual(job.results.map((r: any) => [r.id, r.ok]), [["force:push:alpha", true]]);
  assert.deepEqual(uploads.map((u) => u.pageId), ["p-alpha"]);
  assert.ok(!calls.some((c) => c[0] === "createSkillPage"), "all never creates pages");
  assert.ok(readManifest().skills.gone, "a folder-less skill is left alone");
  assert.ok(!fs.existsSync(skillPath("gone")));
  assert.equal(link("old").state, "legacy");
  assert.equal(link("old").synced_at, "2026-01-01T00:00:00.000Z");
  const { listVersions } = await import("../services/history.ts");
  assert.ok(listVersions(vault, "alpha").some((v) => v.source === "notion-edit" && v.note === "before force-push"));

  uploads = [];
  job = await force("push", ["fresh", "old"]);
  assert.deepEqual(job.results.map((r: any) => [r.id, r.ok]), [["force:push:fresh", true], ["force:push:old", false]]);
  assert.match(job.results[1].error, /legacy/);
  assert.deepEqual(uploads.map((u) => u.pageId), ["new-1"]);
  assert.equal(link("fresh").page_id, "new-1");
});

test("force pull replaces the vault copy (history first), skips legacy and already-synced skills", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true, notionEdit: true });
  await seedLinked("old", "p-old", { linkExtra: { state: "legacy" } });
  await seedLinked("same", "p-same");
  writeCache();
  const job = await force("pull");
  assert.deepEqual(job.results.map((r: any) => [r.id, r.ok]), [["force:pull:alpha", true], ["force:pull:same", true]]);
  assert.match(job.results[1].message, /already in sync/);
  assert.ok(!calls.some((c) => c[0] === "extract" && c[1] === "p-same"), "a synced skill is not pulled");
  assert.match(fs.readFileSync(path.join(skillPath("alpha"), "SKILL.md"), "utf8"), /notion edit/);
  const { listVersions } = await import("../services/history.ts");
  assert.ok(listVersions(vault, "alpha").some((v) => v.side === "vault" && v.source === "force-pull"), "vault copy recorded first");
  assert.equal(fs.readFileSync(path.join(skillPath("old"), "SKILL.md"), "utf8"), md("old"));
});

test("push-selected pushes normally: Notion edits and never-synced links are per-row errors, legacy skipped", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  await seedLinked("edited", "p-edited", { vaultEdit: true, notionEdit: true });
  await seedLinked("never", "p-never", { vaultEdit: true, linkExtra: { synced_at: undefined } });
  await seedLinked("old", "p-old", { linkExtra: { state: "legacy" } });
  await seedLinked("same", "p-same");
  seedUnlinked("fresh");
  writeCache();

  assert.equal((await post("/notion/push-selected", { skills: [] })).status, 400);
  const res = await post("/notion/push-selected", { skills: ["alpha", "edited", "never", "old", "same", "fresh", "ghost"] });
  assert.equal(res.status, 200, await res.clone().text());
  const job = await waitJob(((await res.json()) as any).job_id);
  const byId = Object.fromEntries(job.results.map((r: any) => [r.id, r]));
  assert.equal(byId["push-selected:alpha"].ok, true, byId["push-selected:alpha"].error);
  assert.equal(byId["push-selected:alpha"].message, "pushed");
  assert.equal(byId["push-selected:edited"].ok, false);
  assert.equal(byId["push-selected:edited"].error, "Changed in Notion — resolve in Conflicts");
  assert.equal(byId["push-selected:never"].error, "Changed in Notion — resolve in Conflicts");
  assert.match(byId["push-selected:old"].error, /legacy/);
  assert.equal(byId["push-selected:same"].ok, true);
  assert.match(byId["push-selected:same"].message, /no vault changes/);
  assert.equal(byId["push-selected:fresh"].ok, true, byId["push-selected:fresh"].error);
  assert.equal(byId["push-selected:fresh"].message, "created in Notion");
  assert.match(byId["push-selected:ghost"].error, /not found/);

  // Only alpha and the new page were uploaded — the Notion edit is untouched.
  assert.deepEqual(uploads.map((u) => u.pageId).sort(), ["new-1", "p-alpha"]);
  assert.match(fs.readFileSync(path.join(notionPath("p-edited"), "SKILL.md"), "utf8"), /notion edit/);
  assert.equal(link("edited").notion_version_id, "p-edited@1");
  assert.ok(!calls.some((c) => c[0] === "extract" && c[1] === "p-edited"), "no force snapshot of Notion's copy");
});

test("push-selected honours the multi-device guard", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  writeCache();
  guardStatus = { is_repo: true, behind: 1, ahead: 0 };
  const res = await post("/notion/push-selected", { skills: ["alpha"] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "vault_behind", behind: 1 });
  assert.equal(uploads.length, 0);
});

test("plan diff returns vault vs Notion with labels, notion_page_id stripped", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  writeTree(notionPath("p-alpha"), { "SKILL.md": md("alpha").replace("---\nbody", "notion_page_id: p-alpha\n---\nbody"), "extra.md": "x\n" });
  writeCache();
  const res = await fetch(`${base}/notion/plan/diff?direction=push&row=${encodeURIComponent("push:update:alpha")}`);
  assert.equal(res.status, 200, await res.clone().text());
  const d = (await res.json()) as any;
  assert.deepEqual(d.labels, { left: "vault", right: "notion" });
  assert.deepEqual(d.files.map((f: any) => [f.path, f.change]), [["SKILL.md", "modified"], ["extra.md", "added"]]);
  const hunks = d.files[0].hunks.filter((h: any) => h.type !== "ctx").map((h: any) => h.text);
  assert.deepEqual(hunks, ["vault edit", "body"]);
  assert.equal((await fetch(`${base}/notion/plan/diff?direction=push&row=push:update:nope`)).status, 404);
});

test("only one Notion job runs at a time", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  writeCache();
  let release!: () => void;
  uploadGate = new Promise<void>((r) => (release = r));
  try {
    const [a, b] = await Promise.all([
      post("/notion/force", { direction: "push" }),
      post("/notion/run", { direction: "push", rows: [{ id: "push:update:alpha" }] }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal((await post("/notion/link", {})).status, 409, "link waits too");
    release();
    const ok = a.status === 200 ? a : b;
    await waitJob(((await ok.json()) as any).job_id);
  } finally {
    release();
    uploadGate = null;
  }
});

test("while a job runs: resolve and check are 409 busy, plan reuses the current cache", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  await seedLinked("beta", "p-beta", { vaultEdit: true, notionEdit: true });
  writeCache();
  let release!: () => void;
  uploadGate = new Promise<void>((r) => (release = r));
  try {
    const res = await post("/notion/force", { direction: "push", skills: ["alpha"] });
    assert.equal(res.status, 200);
    const jobId = ((await res.json()) as any).job_id;

    const resolve = await post("/notion/conflicts/beta/resolve", { mode: "keep-vault", expected_notion_version: "p-beta@2" });
    assert.equal(resolve.status, 409);
    assert.equal(((await resolve.json()) as any).error, "busy");
    const check = await post("/notion/check", {});
    assert.equal(check.status, 409);
    assert.equal(((await check.json()) as any).error, "busy");

    // A stale (but valid) cache is not refreshed mid-job — the plan uses it as is.
    writeCache("2020-01-01T00:00:00.000Z");
    calls = [];
    const p = await plan("push");
    assert.ok(!calls.some((c) => c[0] === "listRows"), "no refresh while a job runs");
    assert.ok(p.rows.some((r) => r.id === "push:conflict:beta"));
    // An invalid cache can't be reviewed mid-job.
    fs.rmSync(cacheFile());
    assert.equal((await fetch(`${base}/notion/plan?direction=push`)).status, 409);

    release();
    await waitJob(jobId);
  } finally {
    release();
    uploadGate = null;
  }
});

test("a conflict resolution holds the job slot until it finishes", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true, notionEdit: true });
  writeCache();
  let release!: () => void;
  uploadGate = new Promise<void>((r) => (release = r));
  try {
    const pending = post("/notion/conflicts/alpha/resolve", { mode: "keep-vault", expected_notion_version: "p-alpha@2" });
    // Wait until the resolution is inside the upload (holding the slot).
    for (let i = 0; i < 200 && !calls.some((c) => c[0] === "extract"); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await post("/notion/force", { direction: "push" })).status, 409, "force waits for the resolution");
    assert.equal((await post("/notion/link", {})).status, 409, "link waits too");
    assert.equal((await post("/notion/conflicts/alpha/resolve", { mode: "keep-vault", expected_notion_version: "p-alpha@2" })).status, 409);
    release();
    const res = await pending;
    assert.equal(res.status, 200, await res.clone().text());
    // Slot released: a new job can start.
    const f = await post("/notion/force", { direction: "push" });
    assert.equal(f.status, 200, await f.clone().text());
    await waitJob(((await f.json()) as any).job_id);
  } finally {
    release();
    uploadGate = null;
  }
});

test("relink forgets an unlinked link so the next Link run re-links the skill", async () => {
  await seedLinked("alpha", "p-alpha");
  await seedLinked("beta", "p-beta");
  writeCache();
  assert.equal((await post("/notion/skills/alpha/relink", {})).status, 409, "only unlinked links can be relinked");
  assert.equal((await post("/notion/skills/ghost/relink", {})).status, 404);
  assert.equal((await post("/notion/skills/alpha/unlink", {})).status, 200);
  assert.equal(link("alpha").state, "unlinked");

  const res = await post("/notion/skills/alpha/relink", {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(link("alpha"), undefined);

  const start = await post("/notion/link", {});
  assert.equal(start.status, 200, await start.clone().text());
  const id = ((await start.json()) as any).job_id;
  let job: any;
  for (let i = 0; i < 200; i++) {
    job = await (await fetch(`${base}/notion/link/${id}`)).json();
    if (job.summary || job.error) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(job.summary, JSON.stringify(job));
  assert.equal(link("alpha").state, "linked");
  assert.equal(link("alpha").page_id, "p-alpha");
});

test("GET /notion/guard reflects the injected gitGuard", async () => {
  guardStatus = { is_repo: true, behind: 3, ahead: 1 };
  const res = await fetch(`${base}/notion/guard`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { is_repo: true, behind: 3, ahead: 1 });
});

test("run and force refuse with 409 vault_behind when the guard reports behind > 0, unless overridden", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  writeCache();
  guardStatus = { is_repo: true, behind: 2, ahead: 0 };

  // run: blocked, then allowed with override_guard.
  let res = await post("/notion/run", { direction: "push", rows: [{ id: "push:update:alpha" }] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "vault_behind", behind: 2 });
  assert.equal(uploads.length, 0, "the guard blocked before any Notion write");

  res = await post("/notion/run", { direction: "push", rows: [{ id: "push:update:alpha" }], override_guard: true });
  assert.equal(res.status, 200, await res.clone().text());
  await waitJob(((await res.json()) as any).job_id);
  assert.deepEqual(uploads.map((u) => u.pageId), ["p-alpha"]);

  // force: same guard, same override.
  uploads = [];
  await seedLinked("beta", "p-beta", { vaultEdit: true });
  writeCache();
  res = await post("/notion/force", { direction: "push", skills: ["beta"] });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "vault_behind", behind: 2 });

  res = await post("/notion/force", { direction: "push", skills: ["beta"], override_guard: true });
  assert.equal(res.status, 200, await res.clone().text());
  await waitJob(((await res.json()) as any).job_id);
  assert.deepEqual(uploads.map((u) => u.pageId), ["p-beta"]);
});

test("a guard behind 0 (or not a repo) never blocks run or force", async () => {
  await seedLinked("alpha", "p-alpha", { vaultEdit: true });
  writeCache();
  guardStatus = { is_repo: false, behind: 0, ahead: 0 };
  const res = await post("/notion/run", { direction: "push", rows: [{ id: "push:update:alpha" }] });
  assert.equal(res.status, 200, await res.clone().text());
  await waitJob(((await res.json()) as any).job_id);
  assert.deepEqual(uploads.map((u) => u.pageId), ["p-alpha"]);
});

test("skills rename and delete routes still work through the shared helpers", async () => {
  seedUnlinked("one");
  seedUnlinked("two");
  let res = await post("/skills/one/rename", { new_name: "two" });
  assert.equal(res.status, 409);
  res = await post("/skills/one/rename", { new_name: "uno" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(fs.existsSync(skillPath("uno")));
  assert.equal((await post("/skills/ghost/rename", { new_name: "x-y" })).status, 404);
  res = await fetch(`${base}/skills/uno`, { method: "DELETE" });
  assert.equal(res.status, 204);
  assert.ok(!fs.existsSync(skillPath("uno")));
  const { listVersions } = await import("../services/history.ts");
  assert.ok(listVersions(vault, "uno").some((v) => v.source === "delete"));
});
