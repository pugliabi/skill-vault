import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listVersions, recordVersion } from "../history.ts";
import { hashSkillDirNormalized } from "../skillHash.ts";

let vault: string;
let notionDir: string;
let state: { version: number };
let calls: Array<[string, ...unknown[]]>;
let uploads: Array<{ pageId: string; dir: string; name: string; files: Record<string, string> }>;

const NOW = "2026-09-25T12:00:00.000Z";

function writeTree(root: string, files: Record<string, string>) {
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
    else out[r] = fs.readFileSync(path.join(root, r), "utf8");
  }
  return out;
}

const skillPath = (name = "alpha") => path.join(vault, "skills", name);
const manifest = () => JSON.parse(fs.readFileSync(path.join(vault, "skills.json"), "utf8"));
const link = (name = "alpha") => manifest().skills[name].notion;

const VAULT_MD = "---\nname: alpha\ndescription: d\nlicense: MIT\n---\nl1\nl2\nl3\nl4\nl5\n";
const NOTION_MD = (lines: string[]) =>
  `---\nname: |-\n  alpha\ndescription: |-\n  d\nnotion_page_id: p-alpha\n---\n${lines.join("\n")}`;

/** Vault skill + Notion copy linked in sync, base_notion_version recorded. */
function seedLinked(linkExtra: Record<string, unknown> = {}) {
  writeTree(skillPath(), { "SKILL.md": VAULT_MD, "references/r.md": "vault ref\n" });
  writeTree(notionDir, { "SKILL.md": NOTION_MD(["l1", "l2", "l3", "l4", "l5"]), "references/r.md": "vault ref\n" });
  const nv = recordVersion(vault, "alpha", { side: "notion", source: "notion-edit", dir: notionDir })!;
  const vv = recordVersion(vault, "alpha", { side: "vault", source: "external-edit" })!;
  const m = manifest();
  m.skills.alpha.notion = {
    page_id: "p-alpha",
    state: "linked",
    linked_at: "2026-01-01T00:00:00.000Z",
    synced_at: "2026-01-01T00:00:00.000Z",
    vault_hash: hashSkillDirNormalized(skillPath()),
    notion_version_id: "v1",
    notion_edited_at: "2026-01-01T00:00:00.000Z",
    base_notion_version: nv.id,
    base_vault_version: vv.id,
    notion_title: "alpha",
    custom_field: "keep me",
    ...linkExtra,
  };
  fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(m));
}

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-shome-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-svault-"));
  notionDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-snotion-")), "alpha");
  fs.writeFileSync(
    path.join(vault, "skills.json"),
    JSON.stringify({ version: "1", skills: { alpha: { targets: ["claude"], tags: ["x"] } } }),
  );
  fs.writeFileSync(path.join(vault, "notion.json"), JSON.stringify({ data_source_id: "ds" }));
  state = { version: 1 };
  calls = [];
  uploads = [];
});

function deps() {
  const api = {
    downloadSkill: async (id: string) => {
      calls.push(["downloadSkill", id]);
      return { versionId: `v${state.version}`, url: `archive:${id}` };
    },
    setTitle: async (id: string, title: string) => {
      calls.push(["setTitle", id, title]);
    },
    createSkillPage: async (ds: string, name: string, description: string) => {
      calls.push(["createSkillPage", ds, name, description]);
      return "p-new";
    },
  } as any;
  return {
    api,
    extract: async (url: string) => {
      calls.push(["extract", url]);
      return { skillRoot: notionDir, cleanup() {} };
    },
    now: () => NOW,
    upload: async (_api: unknown, pageId: string, dir: string, name: string) => {
      const files = readTree(dir);
      uploads.push({ pageId, dir, name, files });
      // Notion stores the upload (and injects its page id into the frontmatter).
      const tree: Record<string, string> = { ...files };
      tree["SKILL.md"] = files["SKILL.md"].replace(/\n---\n/, `\nnotion_page_id: ${pageId}\n---\n`);
      writeTree(notionDir, tree);
      state.version++;
    },
  };
}

// ── pushSkill ───────────────────────────────────────────────────

test("pushSkill uploads the vault folder and updates the link bookkeeping", async () => {
  const { pushSkill } = await import("./sync.ts");
  seedLinked();
  fs.writeFileSync(path.join(skillPath(), "SKILL.md"), VAULT_MD.replace("l3", "l3 edited"));
  const r = await pushSkill(deps(), vault, "alpha");
  assert.equal(r.versionId, "v2");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].pageId, "p-alpha");
  assert.equal(uploads[0].name, "alpha");
  assert.equal(path.resolve(uploads[0].dir), path.resolve(skillPath()));
  assert.equal(calls.filter((c) => c[0] === "setTitle").length, 0, "title already matches");

  const l = link();
  assert.equal(l.notion_version_id, "v2");
  assert.equal(l.synced_at, NOW);
  assert.equal(l.vault_hash, hashSkillDirNormalized(skillPath()));
  assert.equal(l.custom_field, "keep me");
  assert.equal(l.notion_edited_at, "2026-01-01T00:00:00.000Z");
  assert.equal(l.vault_name, "alpha");
  const versions = listVersions(vault, "alpha");
  const newestNotion = versions.find((v) => v.side === "notion")!;
  assert.equal(newestNotion.source, "push-notion-copy");
  assert.equal(l.base_notion_version, newestNotion.id);
  assert.equal(l.base_vault_version, versions.find((v) => v.side === "vault")!.id);
  assert.equal(manifest().skills.alpha.targets[0], "claude");
});

test("pushSkill restores the Notion title when it differs from the skill name", async () => {
  const { pushSkill } = await import("./sync.ts");
  seedLinked({ notion_title: "Alpha Skill" });
  await pushSkill(deps(), vault, "alpha", { force: true });
  assert.deepEqual(calls.find((c) => c[0] === "setTitle"), ["setTitle", "p-alpha", "Alpha Skill"]);
  assert.equal(link().notion_title, "Alpha Skill");
});

test("pushSkill restores the title against the uploaded frontmatter name, not the folder name", async () => {
  const { pushSkill } = await import("./sync.ts");
  seedLinked(); // notion_title "alpha" == folder name
  fs.writeFileSync(path.join(skillPath(), "SKILL.md"), VAULT_MD.replace("name: alpha", "name: alpha-renamed"));
  await pushSkill(deps(), vault, "alpha", { force: true });
  assert.deepEqual(calls.find((c) => c[0] === "setTitle"), ["setTitle", "p-alpha", "alpha"]);

  calls = [];
  seedLinked({ notion_title: "alpha-renamed" });
  fs.writeFileSync(path.join(skillPath(), "SKILL.md"), VAULT_MD.replace("name: alpha", "name: alpha-renamed"));
  await pushSkill(deps(), vault, "alpha", { force: true });
  assert.equal(calls.filter((c) => c[0] === "setTitle").length, 0, "title already matches the uploaded name");
});

test("pushSkill without force refuses when Notion changed since the last sync", async () => {
  const { pushSkill, NotionChangedError } = await import("./sync.ts");
  seedLinked();
  state.version = 5;
  await assert.rejects(pushSkill(deps(), vault, "alpha"), NotionChangedError);
  assert.equal(uploads.length, 0);
});

test("force push snapshots Notion's current copy before overwriting it", async () => {
  const { pushSkill } = await import("./sync.ts");
  seedLinked();
  writeTree(notionDir, { "SKILL.md": NOTION_MD(["edited in notion"]) });
  state.version = 5;
  await pushSkill(deps(), vault, "alpha", { force: true });
  const notionSide = listVersions(vault, "alpha").filter((v) => v.side === "notion");
  assert.deepEqual(notionSide.map((v) => v.source), ["push-notion-copy", "notion-edit", "notion-edit"]);
  assert.equal(notionSide[1].note, "before force-push");
});

test("pushSkill with create makes the Notion page for an unlinked skill", async () => {
  const { pushSkill } = await import("./sync.ts");
  writeTree(skillPath(), { "SKILL.md": "---\nname: alpha\ndescription: does things\n---\nbody\n" });
  await pushSkill(deps(), vault, "alpha", { create: true });
  assert.deepEqual(calls[0], ["createSkillPage", "ds", "alpha", "does things"]);
  assert.equal(uploads[0].pageId, "p-new");
  const l = link();
  assert.equal(l.page_id, "p-new");
  assert.equal(l.state, "linked");
  assert.equal(l.linked_at, NOW);
  assert.equal(l.synced_at, NOW);
  assert.equal(l.notion_title, "alpha");
  assert.ok(l.base_notion_version && l.base_vault_version);
});

test("pushSkill create: a failed upload unlinks again and names the orphan page", async () => {
  const { pushSkill } = await import("./sync.ts");
  writeTree(skillPath(), { "SKILL.md": VAULT_MD });
  const d = deps();
  d.upload = async () => {
    throw new Error("PUT 500");
  };
  await assert.rejects(pushSkill(d, vault, "alpha", { create: true }), (err: Error) => {
    assert.match(err.message, /p-new/);
    assert.match(err.message, /PUT 500/);
    assert.match(err.message, /delete that empty page in Notion/);
    return true;
  });
  assert.equal(manifest().skills.alpha.notion, undefined, "no link to the empty page is left behind");
});

test("pushSkill retries the upload for a created-but-never-uploaded page (no archive yet)", async () => {
  const { pushSkill } = await import("./sync.ts");
  writeTree(skillPath(), { "SKILL.md": VAULT_MD });
  for (const opts of [{}, { force: true }]) {
    const d = deps();
    let first = true;
    const real = d.api.downloadSkill;
    d.api.downloadSkill = async (id: string) => {
      if (first) {
        first = false;
        throw new Error(`download-skill returned no archive for ${id}`);
      }
      return real(id);
    };
    uploads = [];
    const before = manifest();
    before.skills.alpha.notion = { page_id: "p-new", state: "linked", linked_at: NOW, notion_title: "alpha" };
    fs.writeFileSync(path.join(vault, "skills.json"), JSON.stringify(before));
    await pushSkill(d, vault, "alpha", opts);
    assert.deepEqual(uploads.map((u) => u.pageId), ["p-new"], JSON.stringify(opts));
    assert.equal(link().synced_at, NOW);
  }
});

test("pushSkill does not retry blind when a synced/versioned link's download fails", async () => {
  const { pushSkill } = await import("./sync.ts");
  seedLinked({ synced_at: undefined });
  const d = deps();
  d.api.downloadSkill = async () => {
    throw new Error("network down");
  };
  for (const opts of [{}, { force: true }]) {
    await assert.rejects(pushSkill(d, vault, "alpha", opts), /network down/);
  }
  assert.equal(uploads.length, 0);
});

test("pushSkill without a link and without create throws", async () => {
  const { pushSkill } = await import("./sync.ts");
  writeTree(skillPath(), { "SKILL.md": "---\nname: alpha\n---\n" });
  await assert.rejects(pushSkill(deps(), vault, "alpha"), /not linked/);
});

// ── pullSkill ───────────────────────────────────────────────────

test("pullSkill merges a Notion edit onto a vault edit and records history", async () => {
  const { pullSkill } = await import("./sync.ts");
  seedLinked();
  fs.writeFileSync(path.join(skillPath(), "SKILL.md"), VAULT_MD.replace("l4", "l4 vault"));
  fs.writeFileSync(path.join(skillPath(), "vault-only.md"), "gone after pull\n");
  writeTree(notionDir, {
    "SKILL.md": NOTION_MD(["l1", "l2 notion", "l3", "l4", "l5"]),
    "references/r.md": "notion ref\n",
  });
  state.version = 2;
  const r = await pullSkill(deps(), vault, "alpha");
  assert.deepEqual(r, { result: "pulled" });
  assert.deepEqual(readTree(skillPath()), {
    "SKILL.md": "---\nname: alpha\ndescription: d\nlicense: MIT\n---\nl1\nl2 notion\nl3\nl4 vault\nl5\n",
    "references/r.md": "notion ref\n",
  });
  const versions = listVersions(vault, "alpha");
  const vaultSide = versions.filter((v) => v.side === "vault");
  assert.equal(vaultSide[0].source, "pull");
  assert.ok(vaultSide[1].files["vault-only.md"], "pre-pull state is in history");
  const notionSide = versions.find((v) => v.side === "notion")!;
  assert.equal(notionSide.source, "notion-edit");
  assert.equal(notionSide.note, "pulled");
  const l = link();
  assert.equal(l.notion_version_id, "v2");
  assert.equal(l.synced_at, NOW);
  assert.equal(l.vault_hash, hashSkillDirNormalized(skillPath()));
  assert.equal(l.base_notion_version, notionSide.id);
  assert.equal(l.base_vault_version, vaultSide[0].id);
  assert.equal(l.custom_field, "keep me");
});

test("pullSkill with overlapping edits reports a conflict and leaves the vault alone", async () => {
  const { pullSkill } = await import("./sync.ts");
  seedLinked();
  const edited = VAULT_MD.replace("l2", "l2 vault");
  fs.writeFileSync(path.join(skillPath(), "SKILL.md"), edited);
  writeTree(notionDir, { "SKILL.md": NOTION_MD(["l1", "l2 notion", "l3", "l4", "l5"]) });
  state.version = 2;
  const before = link();
  const r = await pullSkill(deps(), vault, "alpha");
  assert.equal(r.result, "conflict");
  assert.ok(r.reason);
  assert.equal(fs.readFileSync(path.join(skillPath(), "SKILL.md"), "utf8"), edited);
  assert.ok(fs.existsSync(path.join(skillPath(), "references", "r.md")));
  const l = link();
  assert.equal(l.synced_at, undefined);
  assert.equal(l.base_notion_version, before.base_notion_version, "base kept for a later merge");
  assert.equal(l.notion_version_id, before.notion_version_id);
  assert.equal(l.custom_field, "keep me");
});

test("pullSkill without a recorded base is a conflict", async () => {
  const { pullSkill } = await import("./sync.ts");
  seedLinked({ base_notion_version: undefined });
  const r = await pullSkill(deps(), vault, "alpha");
  assert.equal(r.result, "conflict");
  assert.match(r.reason!, /base/);
  assert.equal(link().synced_at, undefined);
});

test("force pull replaces the vault folder with Notion's copy", async () => {
  const { pullSkill, keepNotion } = await import("./sync.ts");
  assert.equal(typeof keepNotion, "function");
  seedLinked();
  fs.writeFileSync(path.join(skillPath(), "SKILL.md"), VAULT_MD.replace("l2", "l2 vault"));
  fs.mkdirSync(path.join(skillPath(), "node_modules"));
  fs.writeFileSync(path.join(skillPath(), "node_modules", "dep.js"), "kept");
  writeTree(notionDir, { "SKILL.md": NOTION_MD(["only notion"]), "scripts/s.py": "print()\n" });
  state.version = 3;
  const r = await keepNotion(deps(), vault, "alpha");
  assert.deepEqual(r, { result: "pulled" });
  assert.deepEqual(readTree(skillPath()), {
    "SKILL.md": "---\nname: alpha\ndescription: d\nlicense: MIT\n---\nonly notion",
    "scripts/s.py": "print()\n",
    "node_modules/dep.js": "kept",
  });
  assert.equal(listVersions(vault, "alpha").find((v) => v.side === "vault")!.source, "force-pull");
  assert.equal(link().notion_version_id, "v3");
  assert.equal(link().synced_at, NOW);
  assert.deepEqual(
    fs.readdirSync(path.join(vault, "skills")),
    ["alpha"],
    "no temp folders left behind",
  );
  void pullSkill;
});

// ── applyResolution / keepVault ─────────────────────────────────

test("applyResolution writes the resolved folder, then pushes it", async () => {
  const { applyResolution } = await import("./sync.ts");
  seedLinked({ synced_at: undefined });
  state.version = 4; // Notion moved on: the conflict being resolved
  const files = new Map([
    ["SKILL.md", Buffer.from("---\nname: alpha\ndescription: d\n---\nmerged\n")],
    ["references/new.md", Buffer.from("n\n")],
  ]);
  await applyResolution(deps(), vault, "alpha", files, "claude-merge");
  assert.deepEqual(readTree(skillPath()), {
    "SKILL.md": "---\nname: alpha\ndescription: d\n---\nmerged\n",
    "references/new.md": "n\n",
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].files["SKILL.md"], "---\nname: alpha\ndescription: d\n---\nmerged\n");
  const vaultSide = listVersions(vault, "alpha").filter((v) => v.side === "vault");
  assert.equal(vaultSide[0].source, "claude-merge");
  const l = link();
  assert.equal(l.synced_at, NOW);
  assert.equal(l.notion_version_id, "v5");
});

test("applyResolution rejects unsafe paths before touching the vault", async () => {
  const { applyResolution } = await import("./sync.ts");
  seedLinked();
  const files = new Map([["SKILL.md", Buffer.from("x")], ["../escape.md", Buffer.from("x")]]);
  await assert.rejects(applyResolution(deps(), vault, "alpha", files, "vault-edit"), /invalid file path/);
  assert.equal(fs.readFileSync(path.join(skillPath(), "SKILL.md"), "utf8"), VAULT_MD);
});

test("keepVault force-pushes", async () => {
  const { keepVault } = await import("./sync.ts");
  seedLinked({ synced_at: undefined });
  state.version = 9;
  const r = await keepVault(deps(), vault, "alpha");
  assert.equal(r.versionId, "v10");
  assert.equal(uploads.length, 1);
});

// ── adoptFromNotion ─────────────────────────────────────────────

test("adoptFromNotion creates a linked vault skill from a Notion-only row", async () => {
  const { adoptFromNotion } = await import("./sync.ts");
  writeTree(notionDir, { "SKILL.md": "---\nname: |-\n  fresh-skill\ndescription: |-\n  d\nnotion_page_id: p-fresh\n---\nbody", "a.txt": "a" });
  const name = await adoptFromNotion(deps(), vault, {
    page_id: "p-fresh", title: "fresh", description: "d", tags: [], has_files: true, edited_at: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(name, "fresh-skill");
  assert.deepEqual(readTree(skillPath("fresh-skill")), {
    "SKILL.md": "---\nname: |-\n  fresh-skill\ndescription: |-\n  d\n---\nbody",
    "a.txt": "a",
  });
  const entry = manifest().skills["fresh-skill"];
  assert.deepEqual(entry.targets, []);
  assert.equal(entry.source, "pulled from Notion");
  assert.equal(entry.notion.page_id, "p-fresh");
  assert.equal(entry.notion.state, "linked");
  assert.equal(entry.notion.synced_at, NOW);
  assert.equal(entry.notion.notion_edited_at, "2026-09-01T00:00:00.000Z");
  assert.equal(entry.notion.notion_title, "fresh");
  assert.equal(entry.notion.vault_name, "fresh-skill");
  const versions = listVersions(vault, "fresh-skill");
  assert.equal(versions.find((v) => v.side === "vault")!.source, "adopt");
  assert.equal(entry.notion.base_vault_version, versions.find((v) => v.side === "vault")!.id);
  assert.equal(entry.notion.base_notion_version, versions.find((v) => v.side === "notion")!.id);
});

test("adoptFromNotion falls back to the normalized title and never overwrites", async () => {
  const { adoptFromNotion } = await import("./sync.ts");
  writeTree(notionDir, { "SKILL.md": "---\nname: Not Valid\n---\nbody" });
  const row = { page_id: "p-x", title: "alpha", description: "", tags: [], has_files: false };
  await assert.rejects(adoptFromNotion(deps(), vault, row), /already exists/);
  const name = await adoptFromNotion(deps(), vault, { ...row, title: "brand-new" });
  assert.equal(name, "brand-new");
});

// ── legacy ──────────────────────────────────────────────────────

test("every primitive refuses a legacy link", async () => {
  const sync = await import("./sync.ts");
  seedLinked({ state: "legacy" });
  const d = deps();
  const files = new Map([["SKILL.md", Buffer.from("x")]]);
  await assert.rejects(sync.pushSkill(d, vault, "alpha"), sync.LegacyLinkError);
  await assert.rejects(sync.pushSkill(d, vault, "alpha", { force: true, create: true }), sync.LegacyLinkError);
  await assert.rejects(sync.pullSkill(d, vault, "alpha"), sync.LegacyLinkError);
  await assert.rejects(sync.pullSkill(d, vault, "alpha", { force: true }), sync.LegacyLinkError);
  await assert.rejects(sync.keepVault(d, vault, "alpha"), sync.LegacyLinkError);
  await assert.rejects(sync.keepNotion(d, vault, "alpha"), sync.LegacyLinkError);
  await assert.rejects(sync.applyResolution(d, vault, "alpha", files, "claude-merge"), sync.LegacyLinkError);
  await assert.rejects(
    sync.adoptFromNotion(d, vault, { page_id: "p-alpha", title: "x", description: "", tags: [], has_files: false }),
    sync.LegacyLinkError,
  );
  assert.equal(fs.readFileSync(path.join(skillPath(), "SKILL.md"), "utf8"), VAULT_MD);
  assert.equal(uploads.length, 0);
  assert.deepEqual(calls, []);
});

test("adoptFromNotion refuses Notion-native rows", async () => {
  const { adoptFromNotion } = await import("./sync.ts");
  const row = { page_id: "p-n", title: "Reformat with headers", description: "", tags: [], has_files: false };
  await assert.rejects(adoptFromNotion(deps(), vault, row), /Notion-native/);
  assert.deepEqual(calls, []);
});
