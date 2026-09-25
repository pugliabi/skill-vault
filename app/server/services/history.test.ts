import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  historyRoot,
  recordVersion,
  listVersions,
  getVersion,
  readObject,
  materializeVersion,
  DEFAULT_MAX_VERSIONS,
  readHistoryConfig,
  writeHistoryConfig,
  gcObjects,
  moveHistory,
  recordDeletionMarker,
  listDeletedSkills,
  skillHistoryDir,
  withHistory,
  diffVersion,
  restoreVersion,
} from "./history.ts";
import { readManifest, writeManifest } from "./vault.ts";

let vault: string;
const skill = (name: string) => path.join(vault, "skills", name);
function write(name: string, rel: string, content: string | Buffer) {
  const abs = path.join(skill(name), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-history-"));
});

test("records a version with every file and stores objects raw", () => {
  write("demo", "SKILL.md", "---\nname: demo\n---\nhello\n");
  write("demo", "references/a.md", "ref");
  const v = recordVersion(vault, "demo", { source: "vault-edit" });
  assert.ok(v);
  assert.equal(v.side, "vault");
  assert.deepEqual(Object.keys(v.files).sort(), ["SKILL.md", "references/a.md"]);
  assert.equal(readObject(vault, v.files["references/a.md"]).toString(), "ref");
  // No .gitattributes: objects follow the vault repo's EOL rules.
  assert.equal(fs.existsSync(path.join(historyRoot(vault), ".gitattributes")), false);
});

test("identical consecutive state is not re-recorded unless always", () => {
  write("demo", "SKILL.md", "x");
  assert.ok(recordVersion(vault, "demo", { source: "vault-edit" }));
  assert.equal(recordVersion(vault, "demo", { source: "external-edit" }), null);
  assert.ok(recordVersion(vault, "demo", { source: "delete", always: true }));
  assert.equal(listVersions(vault, "demo").length, 2);
});

test("identical file content is stored once", () => {
  write("a", "SKILL.md", "same");
  write("b", "SKILL.md", "same");
  recordVersion(vault, "a", { source: "vault-edit" });
  recordVersion(vault, "b", { source: "vault-edit" });
  const objects = fs.readdirSync(path.join(historyRoot(vault), "objects"), { recursive: true })
    .filter((p) => String(p).length > 2);
  assert.equal(objects.length, 1);
});

test("list is newest first; get and materialize round-trip", () => {
  write("demo", "SKILL.md", "v1");
  const v1 = recordVersion(vault, "demo", { source: "vault-edit" })!;
  write("demo", "SKILL.md", "v2");
  write("demo", "bin/logo.png", Buffer.from([0, 1, 2, 255]));
  const v2 = recordVersion(vault, "demo", { source: "vault-edit", note: "second" })!;
  assert.deepEqual(listVersions(vault, "demo").map((v) => v.id), [v2.id, v1.id]);
  assert.equal(getVersion(vault, "demo", v2.id)?.note, "second");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sv-mat-"));
  materializeVersion(vault, v2, out);
  assert.equal(fs.readFileSync(path.join(out, "SKILL.md"), "utf8"), "v2");
  assert.deepEqual([...fs.readFileSync(path.join(out, "bin/logo.png"))], [0, 1, 2, 255]);
});

test("missing skill dir records nothing; skip set is ignored", () => {
  assert.equal(recordVersion(vault, "ghost", { source: "vault-edit" }), null);
  write("demo", "SKILL.md", "x");
  write("demo", "node_modules/pkg/index.js", "junk");
  write("demo", "__pycache__/m.pyc", "junk");
  const v = recordVersion(vault, "demo", { source: "vault-edit" })!;
  assert.deepEqual(Object.keys(v.files), ["SKILL.md"]);
});

test("config defaults to 50 and round-trips", () => {
  assert.equal(readHistoryConfig(vault).max_versions, DEFAULT_MAX_VERSIONS);
  writeHistoryConfig(vault, { max_versions: 3 });
  assert.equal(readHistoryConfig(vault).max_versions, 3);
});

test("versions are capped, oldest dropped, and GC removes orphans", () => {
  writeHistoryConfig(vault, { max_versions: 3 });
  for (let i = 1; i <= 5; i++) {
    write("demo", "SKILL.md", `v${i}`);
    recordVersion(vault, "demo", { source: "vault-edit" });
  }
  const versions = listVersions(vault, "demo");
  assert.equal(versions.length, 3);
  assert.equal(readObject(vault, versions[2].files["SKILL.md"]).toString(), "v3");
  assert.equal(gcObjects(vault), 2); // v1 and v2 objects
});

test("moveHistory follows a rename", () => {
  write("old", "SKILL.md", "x");
  recordVersion(vault, "old", { source: "vault-edit" });
  moveHistory(vault, "old", "new");
  assert.equal(fs.existsSync(skillHistoryDir(vault, "old")), false);
  assert.equal(listVersions(vault, "new").length, 1);
});

test("moveHistory merges into existing target history", () => {
  write("target", "SKILL.md", "t1");
  recordVersion(vault, "target", { source: "vault-edit" });
  fs.rmSync(skill("target"), { recursive: true });
  write("old", "SKILL.md", "o1");
  recordVersion(vault, "old", { source: "vault-edit" });
  moveHistory(vault, "old", "target");
  assert.equal(fs.existsSync(skillHistoryDir(vault, "old")), false);
  const versions = listVersions(vault, "target");
  assert.equal(versions.length, 2);
  assert.equal(readObject(vault, versions[0].files["SKILL.md"]).toString(), "o1");
});

test("deleted skills are listed with their marker", () => {
  write("gone", "SKILL.md", "bye");
  recordVersion(vault, "gone", { source: "vault-edit" });
  fs.rmSync(skill("gone"), { recursive: true });
  const marker = recordDeletionMarker(vault, "gone", "deleted outside the app")!;
  assert.equal(marker.source, "delete");
  assert.equal(recordDeletionMarker(vault, "gone", "again"), null); // idempotent
  write("alive", "SKILL.md", "hi");
  recordVersion(vault, "alive", { source: "vault-edit" });
  const deleted = listDeletedSkills(vault);
  assert.deepEqual(deleted.map((d) => d.name), ["gone"]);
  assert.equal(deleted[0].versions, 2);
});

test("withHistory captures the unrecorded before-state and the result", () => {
  write("demo", "SKILL.md", "before");
  withHistory(vault, "demo", "vault-edit", () => {
    fs.writeFileSync(path.join(skill("demo"), "SKILL.md"), "after");
  });
  const [after, before] = listVersions(vault, "demo");
  assert.equal(before.source, "external-edit");
  assert.equal(after.source, "vault-edit");
  assert.equal(readObject(vault, after.files["SKILL.md"]).toString(), "after");
});

test("diffVersion compares a version with the current folder", () => {
  write("demo", "SKILL.md", "one\n");
  const v1 = recordVersion(vault, "demo", { source: "vault-edit" })!;
  write("demo", "SKILL.md", "two\n");
  write("demo", "new.md", "n");
  const d = diffVersion(vault, "demo", v1.id);
  assert.deepEqual(d.summary, { added: 1, removed: 0, modified: 1, same: 0 });
});

test("restoreVersion replaces the folder and records both states", () => {
  write("demo", "SKILL.md", "good");
  const good = recordVersion(vault, "demo", { source: "vault-edit" })!;
  write("demo", "SKILL.md", "bad");
  write("demo", "extra.md", "x");
  restoreVersion(vault, "demo", good.id);
  assert.equal(fs.readFileSync(path.join(skill("demo"), "SKILL.md"), "utf8"), "good");
  assert.equal(fs.existsSync(path.join(skill("demo"), "extra.md")), false);
  const sources = listVersions(vault, "demo").map((v) => v.source);
  assert.deepEqual(sources, ["restore", "external-edit", "vault-edit"]);
  assert.equal(listVersions(vault, "demo")[1].note, "unrecorded prior state");
  // Swap temp dirs are cleaned up.
  assert.deepEqual(fs.readdirSync(path.join(vault, "skills")), ["demo"]);
});

test("restoreVersion brings back a deleted skill", () => {
  write("gone", "SKILL.md", "hi");
  const v = recordVersion(vault, "gone", { source: "vault-edit" })!;
  fs.rmSync(skill("gone"), { recursive: true });
  restoreVersion(vault, "gone", v.id);
  assert.equal(fs.readFileSync(path.join(skill("gone"), "SKILL.md"), "utf8"), "hi");
});

test("restoreVersion brings back the manifest entry recorded on the delete version", () => {
  writeManifest(vault, {
    skills: { demo: { targets: ["claude"], tags: ["x"] } },
  });
  write("demo", "SKILL.md", "hi");
  recordVersion(vault, "demo", { source: "vault-edit" });
  const deleteVersion = recordVersion(vault, "demo", {
    source: "delete",
    always: true,
    manifest_entry: { targets: ["claude"], tags: ["x"] },
  })!;
  assert.deepEqual(deleteVersion.manifest_entry, { targets: ["claude"], tags: ["x"] });

  // Simulate DELETE /api/skills/:name: folder AND manifest entry removed.
  fs.rmSync(skill("demo"), { recursive: true });
  const manifest = readManifest(vault);
  delete manifest.skills.demo;
  writeManifest(vault, manifest);
  assert.equal(readManifest(vault).skills.demo, undefined);

  restoreVersion(vault, "demo", deleteVersion.id);
  assert.equal(fs.readFileSync(path.join(skill("demo"), "SKILL.md"), "utf8"), "hi");
  assert.deepEqual(readManifest(vault).skills.demo, { targets: ["claude"], tags: ["x"] });
});

test("restoreVersion seeds a bare manifest entry when none was ever recorded", () => {
  write("bare", "SKILL.md", "hi");
  const v = recordVersion(vault, "bare", { source: "vault-edit" })!;
  fs.rmSync(skill("bare"), { recursive: true });
  assert.equal(readManifest(vault).skills.bare, undefined);

  restoreVersion(vault, "bare", v.id);
  assert.deepEqual(readManifest(vault).skills.bare, { targets: [] });
});

test("restoreVersion never overwrites an existing manifest entry", () => {
  write("demo", "SKILL.md", "good");
  const good = recordVersion(vault, "demo", {
    source: "vault-edit",
    manifest_entry: { targets: ["claude"] },
  })!;
  write("demo", "SKILL.md", "bad");
  writeManifest(vault, { skills: { demo: { targets: ["cursor"], tags: ["kept"] } } });

  restoreVersion(vault, "demo", good.id);
  assert.equal(fs.readFileSync(path.join(skill("demo"), "SKILL.md"), "utf8"), "good");
  // Existing manifest entry (targets: cursor, tags: kept) must survive —
  // restore only seeds a manifest entry when one is missing entirely.
  assert.deepEqual(readManifest(vault).skills.demo, { targets: ["cursor"], tags: ["kept"] });
});

test("CRLF and LF copies of the same text are deduped", () => {
  write("demo", "SKILL.md", "---\nname: demo\n---\nline one\nline two\n");
  assert.ok(recordVersion(vault, "demo", { source: "vault-edit" }));
  write("demo", "SKILL.md", "---\r\nname: demo\r\n---\r\nline one\r\nline two\r\n");
  assert.equal(recordVersion(vault, "demo", { source: "external-edit" }), null);
  assert.equal(listVersions(vault, "demo").length, 1);
  // A real content change is still recorded.
  write("demo", "SKILL.md", "---\r\nname: demo\r\n---\r\nline one\r\nline 2\r\n");
  assert.ok(recordVersion(vault, "demo", { source: "external-edit" }));
});

const CORRUPT = '{\n<<<<<<< HEAD\n  "skill": "demo",\n=======\n>>>>>>> other\n';

function corrupt(name: string): string {
  const file = path.join(skillHistoryDir(vault, name), "versions.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CORRUPT);
  return file;
}

function quietly<T>(fn: () => T): T {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

test("corrupt versions.json is preserved byte-for-byte by every writer", () => {
  write("demo", "SKILL.md", "x");
  const file = corrupt("demo");
  quietly(() => {
    assert.equal(recordVersion(vault, "demo", { source: "vault-edit", always: true }), null);
    assert.equal(recordDeletionMarker(vault, "demo", "gone"), null);
    moveHistory(vault, "demo", "renamed");
    fs.rmSync(skill("demo"), { recursive: true });
    assert.deepEqual(listDeletedSkills(vault), []);
  });
  assert.equal(fs.readFileSync(file, "utf8"), CORRUPT);
  assert.equal(fs.existsSync(skillHistoryDir(vault, "renamed")), false);
  assert.throws(() => listVersions(vault, "demo"), /versions\.json is not valid JSON/);
  assert.throws(() => getVersion(vault, "demo", "x"), /not valid JSON/);
});

test("gcObjects deletes nothing when any versions.json is corrupt", () => {
  writeHistoryConfig(vault, { max_versions: 1 });
  write("a", "SKILL.md", "a1");
  recordVersion(vault, "a", { source: "vault-edit" });
  write("a", "SKILL.md", "a2");
  recordVersion(vault, "a", { source: "vault-edit" }); // a1 object now orphaned
  write("b", "SKILL.md", "b1");
  recordVersion(vault, "b", { source: "vault-edit" });
  corrupt("b");
  const objects = () =>
    fs.readdirSync(path.join(historyRoot(vault), "objects"), { recursive: true }).length;
  const before = objects();
  assert.equal(quietly(() => gcObjects(vault)), 0);
  assert.equal(objects(), before);
});

test("restoreVersion with a missing object throws and leaves the folder untouched", () => {
  write("demo", "SKILL.md", "old");
  const v = recordVersion(vault, "demo", { source: "vault-edit" })!;
  write("demo", "SKILL.md", "current");
  write("demo", "extra.md", "keep me");
  const sha = v.files["SKILL.md"];
  fs.rmSync(path.join(historyRoot(vault), "objects", sha.slice(0, 2), sha));
  const countBefore = listVersions(vault, "demo").length;
  assert.throws(() => restoreVersion(vault, "demo", v.id), /missing/);
  assert.equal(fs.readFileSync(path.join(skill("demo"), "SKILL.md"), "utf8"), "current");
  assert.equal(fs.readFileSync(path.join(skill("demo"), "extra.md"), "utf8"), "keep me");
  assert.deepEqual(fs.readdirSync(path.join(vault, "skills")), ["demo"]);
  assert.equal(listVersions(vault, "demo").length, countBefore);
});

test("materializeVersion and readObject reject unsafe paths and object ids", () => {
  write("demo", "SKILL.md", "x");
  const v = recordVersion(vault, "demo", { source: "vault-edit" })!;
  const sha = v.files["SKILL.md"];
  const dest = path.join(vault, "out");
  for (const rel of ["../escape.md", "a/../../b.md", "/abs.md", "C:/x.md", "c:x.md", "\\\\server\\x.md", "a\\..\\..\\b.md"]) {
    assert.throws(
      () => materializeVersion(vault, { ...v, files: { [rel]: sha } }, dest),
      /invalid file path/,
      rel,
    );
  }
  assert.throws(
    () => materializeVersion(vault, { ...v, files: { "SKILL.md": "../../etc" } }, dest),
    /invalid object id/,
  );
  assert.throws(() => readObject(vault, "ABC"), /invalid object id/);
  assert.equal(fs.existsSync(dest), false);
});
