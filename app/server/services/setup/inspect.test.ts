import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Run } from "../appUpdate.ts";
import { inspectFolder } from "./inspect.ts";

const notGit: Run = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-inspect-"));
const skill = (dir: string, name: string) => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), "---\nname: x\n---\n");
};

test("missing, file and empty folders", async () => {
  const root = tmp();
  try {
    const missing = await inspectFolder(path.join(root, "nope"), { run: notGit });
    assert.equal(missing.kind, "missing");
    assert.equal(missing.writable, true);
    assert.equal(missing.git, null);
    fs.writeFileSync(path.join(root, "f.txt"), "x");
    assert.equal((await inspectFolder(path.join(root, "f.txt"), { run: notGit })).kind, "not_dir");
    fs.mkdirSync(path.join(root, "empty"));
    assert.equal((await inspectFolder(path.join(root, "empty"), { run: notGit })).kind, "empty");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a vault counts manifest entries and skill folders once each", async () => {
  const v = tmp();
  try {
    skill(path.join(v, "skills"), "a");
    skill(path.join(v, "skills"), "b");
    fs.writeFileSync(path.join(v, "skills.json"), JSON.stringify({ skills: { a: { targets: [] }, c: { targets: [] } } }));
    fs.writeFileSync(
      path.join(v, "notion.json"),
      JSON.stringify({ data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills" }),
    );
    const info = await inspectFolder(v, { run: notGit });
    assert.equal(info.kind, "vault");
    assert.equal(info.skill_count, 3);
    assert.deepEqual(info.notion, { id: "11111111-2222-3333-4444-555555555555", name: "Skills" });
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test("skills/ without a manifest, a target's skills folder, and anything else", async () => {
  const root = tmp();
  try {
    skill(path.join(root, "nomanifest", "skills"), "a");
    assert.deepEqual(
      [(await inspectFolder(path.join(root, "nomanifest"), { run: notGit })).kind, (await inspectFolder(path.join(root, "nomanifest"), { run: notGit })).skill_count],
      ["vault_no_manifest", 1],
    );
    skill(path.join(root, "target"), "x");
    skill(path.join(root, "target"), "y");
    const t = await inspectFolder(path.join(root, "target"), { run: notGit });
    assert.equal(t.kind, "skills_folder");
    assert.equal(t.skill_count, 2);
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "other", "README.md"), "hi");
    assert.equal((await inspectFolder(path.join(root, "other"), { run: notGit })).kind, "other");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports the enclosing git repo and its origin", async () => {
  const root = tmp();
  try {
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === "rev-parse") return { code: 0, stdout: `${root}\n`, stderr: "" };
      return { code: 0, stdout: "https://github.com/me/vault.git\n", stderr: "" };
    };
    const info = await inspectFolder(root, { run });
    assert.deepEqual(info.git, { root: path.resolve(root), origin: "https://github.com/me/vault.git" });
    assert.deepEqual(calls[0], ["rev-parse", "--show-toplevel"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a folder that can't be read is reported as unreadable, without git", async () => {
  const root = tmp();
  try {
    const calls: string[][] = [];
    const run: Run = async (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const denied = (): string[] => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const info = await inspectFolder(root, { run, readdir: denied });
    assert.deepEqual(info, { path: path.resolve(root), kind: "unreadable", writable: false, skill_count: 0, git: null, notion: null });
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
