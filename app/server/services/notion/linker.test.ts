import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let vault: string;
let notionDirs: Record<string, string>;
/** Pages notion-fetch reports as blank. */
let blankPages: Set<string>;

function mkSkill(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-lhome-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-lvault-"));
  blankPages = new Set();
  fs.writeFileSync(
    path.join(vault, "skills.json"),
    JSON.stringify({ skills: { same: { targets: [] }, diff: { targets: [] }, axelrod: { targets: [] }, mine: { targets: [] } } }),
  );
  fs.writeFileSync(path.join(vault, "notion.json"), JSON.stringify({ data_source_id: "ds", last_edited_property: "Last edited" }));
  mkSkill(path.join(vault, "skills", "same"), { "SKILL.md": "---\nname: same\ndescription: d\n---\nbody\n" });
  mkSkill(path.join(vault, "skills", "diff"), { "SKILL.md": "---\nname: diff\ndescription: d\n---\nvault body\n" });
  mkSkill(path.join(vault, "skills", "axelrod"), { "SKILL.md": "---\nname: axelrod\ndescription: d\n---\nfull\n", "references/a.md": "a" });
  mkSkill(path.join(vault, "skills", "mine"), { "SKILL.md": "---\nname: mine\ndescription: d\n---\nx\n" });
  const n = fs.mkdtempSync(path.join(os.tmpdir(), "sv-lnotion-"));
  notionDirs = {
    "p-same": path.join(n, "same"),
    "p-diff": path.join(n, "diff"),
    "p-axel": path.join(n, "axelrod"),
  };
  mkSkill(notionDirs["p-same"], { "SKILL.md": "---\nname: |-\n  same\ndescription: |-\n  d\nnotion_page_id: p-same\n---\nbody" });
  mkSkill(notionDirs["p-diff"], { "SKILL.md": "---\nname: diff\ndescription: d\n---\nnotion body\n" });
  mkSkill(notionDirs["p-axel"], { "SKILL.md": "---\nname: axelrod\ndescription: d\n---\n## What Claude automates\n" });
});

function fakeApi() {
  const rows = [
    { page_id: "p-same", title: "same", description: "", tags: [], has_files: false, edited_at: "2026-01-01T00:00:00.000Z" },
    { page_id: "p-diff", title: "diff", description: "", tags: [], has_files: false, edited_at: "2026-01-01T00:00:00.000Z" },
    { page_id: "p-axel", title: "Axelrod", description: "", tags: [], has_files: false, edited_at: "2026-01-01T00:00:00.000Z" },
    { page_id: "p-native", title: "Reformat with headers", description: "", tags: [], has_files: false },
    { page_id: "p-new", title: "fabric-deploy", description: "", tags: [], has_files: false },
  ];
  return {
    listRows: async () => rows,
    downloadSkill: async (id: string) => ({ versionId: `v-${id}`, url: id }),
    isBlankPage: async (id: string) => blankPages.has(id),
  } as any;
}

const extract = async (url: string) => ({ skillRoot: notionDirs[url], cleanup() {} });

test("first link classifies pairs and writes link records", async () => {
  const { runFirstLink } = await import("./linker.ts");
  const s = await runFirstLink({ api: fakeApi(), extract }, vault);
  assert.deepEqual(s.linked_in_sync, ["same"]);
  assert.deepEqual(s.conflicts, ["diff"]);
  assert.deepEqual(s.legacy, ["axelrod"]);
  assert.deepEqual(s.notion_only_compatible.map((x) => x.title), ["fabric-deploy"]);
  assert.deepEqual(s.notion_only_native.map((x) => x.title), ["Reformat with headers"]);
  assert.deepEqual(s.vault_only, ["mine"]);
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;
  assert.equal(m.same.notion.state, "linked");
  assert.ok(m.same.notion.synced_at);
  assert.equal(m.same.notion.notion_version_id, "v-p-same");
  assert.ok(m.same.notion.base_notion_version && m.same.notion.base_vault_version);
  assert.equal(m.same.notion.vault_name, "same");
  assert.equal(m.diff.notion.synced_at, undefined);
  assert.equal(m.diff.notion.vault_name, "diff");
  assert.equal(m.axelrod.notion.state, "legacy");
  assert.equal(m.axelrod.notion.vault_name, "axelrod");
  assert.equal(m.mine.notion, undefined);
});

test("re-running is idempotent for in-sync links", async () => {
  const { runFirstLink } = await import("./linker.ts");
  let downloads = 0;
  const api = fakeApi();
  const orig = api.downloadSkill;
  api.downloadSkill = async (id: string) => { downloads++; return orig(id); };
  await runFirstLink({ api, extract }, vault);
  const first = downloads;
  await runFirstLink({ api, extract }, vault);
  assert.ok(downloads - first < first, "second run downloads fewer archives");
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;
  assert.equal(m.same.notion.state, "linked");
});

test("re-running re-evaluates an in-sync link whose vault copy changed", async () => {
  const { runFirstLink } = await import("./linker.ts");
  const api = fakeApi();
  const first = await runFirstLink({ api, extract }, vault);
  assert.deepEqual(first.linked_in_sync, ["same"]);
  fs.writeFileSync(path.join(vault, "skills", "same", "SKILL.md"), "---\nname: same\ndescription: d\n---\nedited in vault\n");
  const fetched: string[] = [];
  const orig = api.downloadSkill;
  api.downloadSkill = async (id: string) => { fetched.push(id); return orig(id); };
  const second = await runFirstLink({ api, extract }, vault);
  assert.ok(fetched.includes("p-same"), "the changed skill is downloaded again");
  assert.deepEqual(second.linked_in_sync, []);
  assert.ok(second.conflicts.includes("same"));
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;
  assert.equal(m.same.notion.synced_at, undefined);
});

test("refreshNotionCache fetches version ids only for linked rows edited since link", async () => {
  const { runFirstLink, refreshNotionCache } = await import("./linker.ts");
  const api = fakeApi();
  await runFirstLink({ api, extract }, vault);
  const rows = await api.listRows();
  rows[0].edited_at = "2026-02-01T00:00:00.000Z"; // p-same edited in Notion
  const fetched: string[] = [];
  const orig = api.downloadSkill;
  api.downloadSkill = async (id: string) => { fetched.push(id); return orig(id); };
  const cache = await refreshNotionCache(api, vault);
  assert.deepEqual(fetched, ["p-same"]);
  assert.equal(cache.data_source_id, "ds");
  assert.ok(cache.checked_at);
  assert.equal(cache.rows.find((r) => r.page_id === "p-diff")?.version_id, "v-p-diff");
  assert.equal(cache.rows.find((r) => r.page_id === "p-new")?.version_id, undefined);
});

test("per-skill failures are collected and the rest still link", async () => {
  const { runFirstLink } = await import("./linker.ts");
  const failing = async (url: string) => {
    if (url === "p-diff") throw new Error("boom");
    return extract(url);
  };
  const s = await runFirstLink({ api: fakeApi(), extract: failing }, vault);
  assert.deepEqual(s.errors, [{ skill: "diff", error: "boom" }]);
  assert.deepEqual(s.linked_in_sync, ["same"]);
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;
  assert.equal(m.diff.notion, undefined);
  assert.ok(JSON.parse(fs.readFileSync(path.join(vault, "notion.json"), "utf8")).linked_at);
});

/** Adds a vault skill named `name` and a matching Notion row `page` (no files). */
function addPair(name: string, page: string, notionMd?: string) {
  mkSkill(path.join(vault, "skills", name), { "SKILL.md": `---\nname: ${name}\ndescription: d\n---\nx\n` });
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
  m.skills[name] = { targets: [] };
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m));
  notionDirs[page] = fs.mkdtempSync(path.join(os.tmpdir(), "sv-lpage-"));
  mkSkill(notionDirs[page], { "SKILL.md": notionMd ?? `---\nname: ${name}\ndescription: d\n---\nsummary only\n` });
  return { page_id: page, title: name, description: "", tags: [], has_files: false, edited_at: "2026-02-01T00:00:00.000Z" };
}

test("a new pair whose page Notion reports blank (no files) is linked awaiting its first upload", async () => {
  const { runFirstLink } = await import("./linker.ts");
  const { computeNotionStatus } = await import("./matching.ts");
  const api = fakeApi();
  const rows = await api.listRows();
  // download-skill succeeds on a blank page (as Notion does); only the fetch marker says it's blank.
  rows.push(addPair("helper-kit", "p-blank"));
  blankPages.add("p-blank");
  api.listRows = async () => rows;

  const s = await runFirstLink({ api, extract }, vault);
  assert.deepEqual(s.empty_pages, ["helper-kit"]);
  assert.ok(!s.conflicts.includes("helper-kit"));
  const l = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills["helper-kit"].notion;
  assert.equal(l.page_id, "p-blank");
  assert.equal(l.state, "linked");
  assert.equal(l.synced_at, undefined);
  assert.equal(l.notion_version_id, undefined);
  assert.equal(l.notion_edited_at, "2026-02-01T00:00:00.000Z");
  const cacheRow = rows.find((r: any) => r.page_id === "p-blank");
  assert.equal(computeNotionStatus({ link: l, connected: true, vaultHash: "h", cacheRow, cacheValid: true }), "changed-vault");
});

test("a page with content but no files is NOT empty; download errors are ordinary per-skill errors", async () => {
  const { runFirstLink } = await import("./linker.ts");
  const api = fakeApi();
  const rows = await api.listRows();
  rows.push(addPair("notes-kit", "p-notes"));
  rows.push(addPair("broken-kit", "p-broken"));
  api.listRows = async () => rows;
  const real = api.downloadSkill;
  api.downloadSkill = async (id: string) => {
    if (id === "p-broken") throw new Error(`download-skill returned no archive for ${id}`);
    return real(id);
  };
  const s = await runFirstLink({ api, extract }, vault);
  assert.deepEqual(s.empty_pages, []);
  assert.ok(s.conflicts.includes("notes-kit"), "linked through the normal flow");
  assert.deepEqual(s.errors.map((e) => e.skill), ["broken-kit"]);
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;
  assert.equal(m["notes-kit"].notion.notion_version_id, "v-p-notes");
  assert.equal(m["broken-kit"].notion, undefined);
});

test("existing links (legacy, conflict, unlinked, synced) are never re-classified as empty pages", async () => {
  const { runFirstLink } = await import("./linker.ts");
  const m0 = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
  m0.skills.axelrod.notion = { page_id: "p-axel", state: "legacy", linked_at: "t", notion_version_id: "old", notion_title: "Axelrod" };
  m0.skills.diff.notion = { page_id: "p-diff", state: "linked", linked_at: "t", notion_version_id: "old", notion_title: "diff" };
  m0.skills.same.notion = { page_id: "p-same", state: "linked", linked_at: "t", synced_at: "t", notion_version_id: "old", vault_hash: "x" };
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m0));
  for (const p of ["p-axel", "p-diff", "p-same"]) blankPages.add(p);
  const api = fakeApi();
  let fetched = 0;
  api.isBlankPage = async () => {
    fetched++;
    return true;
  };
  const s = await runFirstLink({ api, extract }, vault);
  assert.equal(fetched, 0, "blank checks are only made for new pairs");
  assert.deepEqual(s.empty_pages, []);
  const m = JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8")).skills;
  assert.equal(m.axelrod.notion.state, "legacy");
  assert.ok(m.diff.notion.notion_version_id);
  assert.ok(m.same.notion.notion_version_id);
});
