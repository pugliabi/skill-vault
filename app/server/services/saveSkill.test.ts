import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SaveError, parseSaveRequest, saveSkill } from "./saveSkill.ts";
import { initVault, readManifest } from "./vault.ts";

let vault: string;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-save-"));
  initVault(vault);
});
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

const md = (name: string, body = "Body") => `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const file = (name: string, rel: string) => path.join(vault, "skills", name, ...rel.split("/"));
const read = (name: string, rel: string) => fs.readFileSync(file(name, rel), "utf-8");
function refused(fn: () => unknown, status: number, match?: RegExp): SaveError {
  let caught: unknown;
  assert.throws(fn, (e: unknown) => {
    caught = e;
    return e instanceof SaveError && e.status === status && (!match || match.test(e.message));
  });
  return caught as SaveError;
}
const create = (name: string, files = [{ path: "SKILL.md", content: md(name) }]) =>
  saveSkill(vault, name, { mode: "create", files }, "saved from Claude Desktop");

test("create writes every file and adds a staging manifest entry", () => {
  const r = create("demo", [
    { path: "SKILL.md", content: md("demo") },
    { path: "references/api.md", content: "API" },
  ]);
  assert.deepEqual(r, { name: "demo", mode: "create", written: ["SKILL.md", "references/api.md"], unchanged: [] });
  assert.equal(read("demo", "references/api.md"), "API");
  const entry = readManifest(vault).skills.demo;
  assert.deepEqual(entry.targets, []);
  assert.equal(entry.stage, "staging");
  assert.equal(entry.source, "saved from Claude Desktop");
});

test("create refuses a taken name, a bad name, a missing SKILL.md, and a mismatched frontmatter name", () => {
  create("demo");
  refused(() => create("demo"), 409);
  refused(() => create("Bad Name", [{ path: "SKILL.md", content: md("Bad Name") }]), 409);
  refused(() => create("other", [{ path: "notes.md", content: "x" }]), 400, /SKILL\.md/);
  refused(() => create("other", [{ path: "SKILL.md", content: md("different") }]), 400, /frontmatter name/);
  assert.equal(fs.existsSync(path.join(vault, "skills", "other")), false);
});

test("update changes files with matching hashes, adds new files, keeps the rest, reports unchanged", () => {
  create("demo", [
    { path: "SKILL.md", content: md("demo") },
    { path: "a.md", content: "A" },
    { path: "keep.md", content: "K" },
  ]);
  const r = saveSkill(
    vault,
    "demo",
    {
      mode: "update",
      files: [
        { path: "SKILL.md", content: md("demo"), expected_sha256: sha(md("demo")) },
        { path: "a.md", content: "A2", expected_sha256: sha("A") },
        { path: "new/b.md", content: "B" },
      ],
    },
    "saved from Claude Code",
  );
  assert.deepEqual(r.written, ["a.md", "new/b.md"]);
  assert.deepEqual(r.unchanged, ["SKILL.md"]);
  assert.equal(read("demo", "a.md"), "A2");
  assert.equal(read("demo", "new/b.md"), "B");
  assert.equal(read("demo", "keep.md"), "K");
  assert.equal(readManifest(vault).skills.demo.source, "saved from Claude Desktop");
});

test("update writes nothing when any hash is stale, and lists every conflict", () => {
  create("demo", [
    { path: "SKILL.md", content: md("demo") },
    { path: "a.md", content: "A" },
  ]);
  const err = refused(
    () =>
      saveSkill(vault, "demo", {
        mode: "update",
        files: [
          { path: "a.md", content: "A2", expected_sha256: "stale" },
          { path: "b.md", content: "B" },
          { path: "gone.md", content: "G", expected_sha256: sha("G") },
        ],
      }, "x"),
    409,
    /files changed/,
  );
  assert.deepEqual(err.conflicts, [
    { path: "a.md", current_sha256: sha("A") },
    { path: "gone.md", current_sha256: null },
  ]);
  assert.equal(read("demo", "a.md"), "A");
  assert.equal(fs.existsSync(file("demo", "b.md")), false);
});

test("update requires expected_sha256 for existing files and refuses unknown skills", () => {
  create("demo");
  refused(() => saveSkill(vault, "demo", { mode: "update", files: [{ path: "SKILL.md", content: md("demo") }] }, "x"), 400, /expected_sha256/);
  refused(() => saveSkill(vault, "nope", { mode: "update", files: [{ path: "a.md", content: "A" }] }, "x"), 404);
});

test("paths must be relative, /-separated, unique and not ignored", () => {
  for (const bad of ["../x.md", "/abs.md", "C:/x.md", "a\\b.md", "a//b.md", "./a.md", ".git/config"]) {
    refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: bad, content: "x" }]), 400, /invalid file path/);
  }
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: "skill.md", content: "x" }]), 400, /duplicate/);
});

test("binary content and size limits are refused", () => {
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: "b.bin", content: "a\0b" }]), 400, /binary/);
  const big = "x".repeat(1_048_577);
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, { path: "big.md", content: big }]), 413);
  const mb = "y".repeat(1_000_000);
  const many = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.md`, content: mb }));
  refused(() => create("demo", [{ path: "SKILL.md", content: md("demo") }, ...many]), 413, /5 MB/);
});

test("parseSaveRequest checks the body shape", () => {
  assert.throws(() => parseSaveRequest({ mode: "replace", files: [] }), SaveError);
  assert.throws(() => parseSaveRequest({ mode: "create", files: [] }), SaveError);
  assert.throws(() => parseSaveRequest({ mode: "create", files: [{ path: "a" }] }), SaveError);
  assert.throws(() => parseSaveRequest({ mode: "create", files: [{ path: "a", content: "b", expected_sha256: 1 }] }), SaveError);
  assert.deepEqual(parseSaveRequest({ mode: "update", files: [{ path: "a", content: "b", expected_sha256: "h" }] }), {
    mode: "update",
    files: [{ path: "a", content: "b", expected_sha256: "h" }],
  });
});
