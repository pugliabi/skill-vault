import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, CacheStaleError, type BuildPlanInput, type PlanSkillInput } from "./plan.ts";
import type { NotionLink } from "../../types/vault.ts";
import type { NotionCacheRow } from "./store.ts";

const row = (title: string, opts: Partial<NotionCacheRow> = {}): NotionCacheRow => ({
  page_id: opts.page_id ?? title,
  title,
  description: "",
  tags: [],
  has_files: false,
  ...opts,
});

const link = (over: Partial<NotionLink> = {}): NotionLink => ({
  page_id: "p1",
  state: "linked",
  linked_at: "2024-01-01T00:00:00.000Z",
  synced_at: "2024-01-01T00:00:00.000Z",
  vault_hash: "h1",
  notion_version_id: "v1",
  notion_edited_at: "2024-01-01T00:00:00.000Z",
  notion_title: "demo",
  ...over,
});

const skill = (name: string, over: Partial<PlanSkillInput> = {}): PlanSkillInput => ({
  name,
  vaultHash: "h1",
  exists: true,
  has_history: true,
  ...over,
});

function plan(direction: "push" | "pull", skills: PlanSkillInput[], rows: NotionCacheRow[] = [], cacheValid = true): ReturnType<typeof buildPlan> {
  const input: BuildPlanInput = { direction, skills, rows, cacheValid };
  return buildPlan(input);
}

// ── Invalid cache ────────────────────────────────────────────────

test("invalid cache throws CacheStaleError instead of returning a warning row", () => {
  assert.throws(() => plan("push", [skill("demo", { link: link() })], [row("demo", { page_id: "p1" })], false), CacheStaleError);
  assert.throws(() => plan("pull", [], [], false), CacheStaleError);
});

// ── Push ─────────────────────────────────────────────────────────

test("push: linked + vault changed + notion unchanged -> update, selected", () => {
  const l = link({ vault_hash: "h1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("push", [skill("demo", { link: l, vaultHash: "h2" })], rows);
  assert.deepEqual(rs, [
    {
      id: "push:update:demo",
      kind: "update",
      skill: "demo",
      page_id: "p1",
      title: "demo",
      direction: "push",
      default_selected: true,
      detail: "Push vault changes to Notion",
      warnings: [],
    },
  ]);
});

test("push: no link and folder exists -> new, unselected", () => {
  const rs = plan("push", [skill("fresh")]);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "new");
  assert.equal(rs[0].default_selected, false);
  assert.equal(rs[0].skill, "fresh");
  assert.equal(rs[0].id, "push:new:fresh");
});

test("push: no link and folder missing -> no row", () => {
  const rs = plan("push", [skill("gone", { exists: false, vaultHash: null })]);
  assert.deepEqual(rs, []);
});

test("push: vault renamed (recorded vault_name differs from current folder name) -> rename, unselected", () => {
  const l = link({ notion_title: "old-name", vault_name: "old-name", vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("old-name", { page_id: "p1", version_id: "v1" })];
  const rs = plan("push", [skill("new-name", { link: l, vaultHash: "h1" })], rows);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "rename");
  assert.equal(rs[0].default_selected, false);
  assert.equal(rs[0].title, "new-name");
  assert.equal(rs[0].id, "push:rename:new-name");
});

test("push: rename skipped when the target title already exists elsewhere", () => {
  const l = link({ notion_title: "old-name", vault_name: "old-name", vault_hash: "h1", notion_version_id: "v1", page_id: "p1" });
  const rows = [row("old-name", { page_id: "p1", version_id: "v1" }), row("new-name", { page_id: "p2" })];
  const rs = plan("push", [skill("new-name", { link: l, vaultHash: "h1" })], rows);
  // Falls through to normal status evaluation instead: vault unchanged, notion unchanged -> no row.
  assert.deepEqual(rs, []);
});

test("push: display-title link (notion_title differs from name, no vault_name) + nothing changed -> no row", () => {
  // Persisted normal state: pushSkill restores a display title like "No AI Slop" over "no-ai-slop".
  // notion_title differing from the folder name must never, on its own, look like a rename.
  const l = link({ notion_title: "No AI Slop", vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("No AI Slop", { page_id: "p1", version_id: "v1" })];
  const rs = plan("push", [skill("no-ai-slop", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("push: display-title link + both sides changed -> conflict (never hidden behind rename)", () => {
  const l = link({ notion_title: "No AI Slop", vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("No AI Slop", { page_id: "p1", version_id: "v2" })];
  const rs = plan("push", [skill("no-ai-slop", { link: l, vaultHash: "h2" })], rows);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "conflict");
});

test("push: old link without a recorded vault_name never produces a rename row", () => {
  const l = link({ notion_title: "old-name", vault_hash: "h1", notion_version_id: "v1" }); // no vault_name
  const rows = [row("old-name", { page_id: "p1", version_id: "v1" })];
  const rs = plan("push", [skill("new-name", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("push: notion side changed too -> no rename (falls through, no push row since vault unchanged)", () => {
  const l = link({ notion_title: "old-name", vault_name: "old-name", vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("old-name", { page_id: "p1", version_id: "v2" })];
  const rs = plan("push", [skill("new-name", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("push: missing-in-notion -> deleted row, unselected", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rs = plan("push", [skill("demo", { link: l, vaultHash: "h1" })], []);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "deleted");
  assert.equal(rs[0].default_selected, false);
  assert.match(rs[0].detail, /Deleted in Notion/);
});

test("push: linked but vault folder missing with history -> deleted, unselected", () => {
  const l = link();
  const rs = plan("push", [skill("demo", { link: l, exists: false, has_history: true, vaultHash: null })]);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "deleted");
  assert.equal(rs[0].default_selected, false);
  assert.match(rs[0].detail, /Deleted in vault/);
});

test("push: vault folder missing but no history -> no row (nothing to show)", () => {
  const l = link();
  const rs = plan("push", [skill("demo", { link: l, exists: false, has_history: false, vaultHash: null })]);
  assert.deepEqual(rs, []);
});

test("push: both changed -> conflict, unselected", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v2" })];
  const rs = plan("push", [skill("demo", { link: l, vaultHash: "h2" })], rows);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "conflict");
  assert.equal(rs[0].default_selected, false);
});

test("push: never synced -> conflict", () => {
  const l = link({ synced_at: undefined });
  const rs = plan("push", [skill("demo", { link: l })], [row("demo", { page_id: "p1" })]);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "conflict");
});

test("push: linked, nothing changed -> no row", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("push", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("push: notion changed but vault unchanged -> no row (push only cares about vault)", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v2" })];
  const rs = plan("push", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

for (const state of ["legacy", "unlinked", "vault-only"] as const) {
  test(`push: ${state} link never produces a row`, () => {
    const l = link({ state, vault_hash: "h1" });
    const rows = [row("demo", { page_id: "p1", version_id: "v1" })];
    const rs = plan("push", [skill("demo", { link: l, vaultHash: "h2" })], rows);
    assert.deepEqual(rs, []);
  });
}

// ── Pull ─────────────────────────────────────────────────────────

test("pull: linked + notion changed + vault unchanged -> update, selected", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v2" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, [
    {
      id: "pull:update:demo",
      kind: "update",
      skill: "demo",
      page_id: "p1",
      title: "demo",
      direction: "pull",
      default_selected: true,
      detail: "Pull Notion changes into the vault",
      warnings: [],
    },
  ]);
});

test("pull: notion-only compatible row -> new, selected", () => {
  const rows = [row("brand-new", { page_id: "pX" })];
  const rs = plan("pull", [], rows);
  assert.deepEqual(rs, [
    {
      id: "pull:new:pX",
      kind: "new",
      page_id: "pX",
      title: "brand-new",
      direction: "pull",
      default_selected: true,
      detail: "Adopt into vault",
      warnings: [],
    },
  ]);
});

test("pull: notion-only native (invalid-name) row -> no row", () => {
  const rows = [row("Not A Valid Skill Name", { page_id: "pX" })];
  const rs = plan("pull", [], rows);
  assert.deepEqual(rs, []);
});

test("pull: notion-only row already referenced by some link -> no new row", () => {
  const l = link({ page_id: "pX", state: "vault-only" });
  const rows = [row("brand-new", { page_id: "pX" })];
  const rs = plan("pull", [skill("demo", { link: l })], rows);
  assert.deepEqual(rs, []);
});

test("pull: notion title changed, valid, differs from skill name -> rename, unselected", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("renamed-demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "rename");
  assert.equal(rs[0].default_selected, false);
  assert.equal(rs[0].title, "renamed-demo");
});

test("pull: notion title differs from skill name but matches link.notion_title (no actual Notion change) -> no rename row", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1", notion_title: "renamed-demo" });
  const rows = [row("renamed-demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("pull: rename skipped when link.notion_title is absent, even if title differs from name", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1", notion_title: undefined });
  const rows = [row("renamed-demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("pull: notion title changed but invalid as a skill name -> no rename row", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("Not Valid!", { page_id: "p1", version_id: "v1" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("pull: linked row missing from a valid cache -> deleted, unselected", () => {
  const l = link();
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], []);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "deleted");
  assert.equal(rs[0].default_selected, false);
  assert.match(rs[0].detail, /Deleted in Notion/);
});

test("pull: both changed -> conflict, unselected", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v2" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h2" })], rows);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "conflict");
  assert.equal(rs[0].default_selected, false);
});

test("pull: never synced -> conflict", () => {
  const l = link({ synced_at: undefined });
  const rs = plan("pull", [skill("demo", { link: l })], [row("demo", { page_id: "p1" })]);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].kind, "conflict");
});

test("pull: linked, nothing changed -> no row", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
  assert.deepEqual(rs, []);
});

test("pull: vault changed but notion unchanged -> no row (pull only cares about notion)", () => {
  const l = link({ vault_hash: "h1", notion_version_id: "v1" });
  const rows = [row("demo", { page_id: "p1", version_id: "v1" })];
  const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h2" })], rows);
  assert.deepEqual(rs, []);
});

for (const state of ["legacy", "unlinked", "vault-only"] as const) {
  test(`pull: ${state} link never produces a row`, () => {
    const l = link({ state, vault_hash: "h1", notion_version_id: "v1" });
    const rows = [row("demo", { page_id: "p1", version_id: "v2" })];
    const rs = plan("pull", [skill("demo", { link: l, vaultHash: "h1" })], rows);
    assert.deepEqual(rs, []);
  });
}

test("pull: mixed plan combines update, new, rename, deleted, conflict rows with stable ids", () => {
  const rows = [
    row("upd", { page_id: "p-upd", version_id: "v2" }),
    row("brand-new", { page_id: "p-new" }),
    row("renamed", { page_id: "p-ren", version_id: "v1" }),
    row("cfl", { page_id: "p-cfl", version_id: "v2" }),
  ];
  const skills = [
    skill("upd", { link: link({ page_id: "p-upd", notion_title: "upd", vault_hash: "h1", notion_version_id: "v1" }), vaultHash: "h1" }),
    skill("ren", { link: link({ page_id: "p-ren", notion_title: "ren", vault_hash: "h1", notion_version_id: "v1" }), vaultHash: "h1" }),
    skill("del", { link: link({ page_id: "p-del", notion_title: "del", vault_hash: "h1" }), vaultHash: "h1" }),
    skill("cfl", { link: link({ page_id: "p-cfl", notion_title: "cfl", vault_hash: "h1", notion_version_id: "v1" }), vaultHash: "h2" }),
  ];
  const rs = plan("pull", skills, rows);
  const byId = Object.fromEntries(rs.map((r) => [r.id, r]));
  assert.equal(Object.keys(byId).length, 5);
  assert.equal(byId["pull:update:upd"].kind, "update");
  assert.equal(byId["pull:new:p-new"].kind, "new");
  assert.equal(byId["pull:rename:ren"].kind, "rename");
  assert.equal(byId["pull:deleted:del"].kind, "deleted");
  assert.equal(byId["pull:conflict:cfl"].kind, "conflict");

  // Calling again with the same input produces identical ids (stability across calls).
  const rs2 = plan("pull", skills, rows);
  assert.deepEqual(rs2.map((r) => r.id).sort(), rs.map((r) => r.id).sort());
});
