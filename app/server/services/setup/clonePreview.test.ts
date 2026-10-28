import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRun } from "../appUpdate.ts";
import { CloneError, findVaultManifests, friendlyGitError, isCloneUrl, previewClone } from "./clonePreview.ts";

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-repo-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  if (Object.keys(files).length > 0) {
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
  }
  return dir;
}

async function preview(repo: string) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-prev-"));
  try {
    const out = await previewClone(repo, { run: defaultRun, tmpRoot });
    assert.deepEqual(fs.readdirSync(tmpRoot), [], "temporary copy removed");
    return out;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const SKILL = "---\nname: x\n---\n";

test("URL check", () => {
  assert.equal(isCloneUrl("https://github.com/me/vault.git"), true);
  assert.equal(isCloneUrl("ssh://git@github.com/me/vault.git"), true);
  assert.equal(isCloneUrl("git@github.com:me/vault.git"), true);
  assert.equal(isCloneUrl("C:\\repos\\vault"), false);
  assert.equal(isCloneUrl("http://github.com/me/vault"), false);
});

test("findVaultManifests keeps the shallowest skills.json in the top two levels", () => {
  assert.deepEqual(findVaultManifests(["skills.json", "skills/skills.json"]), ["skills.json"]);
  assert.deepEqual(findVaultManifests(["a/skills.json", "b/skills.json", "a/b/skills.json"]), ["a/skills.json", "b/skills.json"]);
  assert.deepEqual(findVaultManifests(["a/b/skills.json", "README.md"]), []);
});

test("friendly git errors", () => {
  assert.match(friendlyGitError("remote: Repository not found.\nfatal: repository 'x' not found"), /wasn't found/);
  assert.match(friendlyGitError("x\ntimed out after 120s"), /Timed out/);
  assert.equal(friendlyGitError("Cloning into 'x'...\nfatal: something odd"), "fatal: something odd");
});

test("vault at the repo root", async () => {
  const repo = makeRepo({
    "skills.json": JSON.stringify({ skills: { a: { targets: [] }, c: { targets: [] } } }),
    "skills/a/SKILL.md": SKILL,
    "skills/b/SKILL.md": SKILL,
    "notion.json": JSON.stringify({ data_source_id: "11111111-2222-3333-4444-555555555555", data_source_name: "Skills" }),
  });
  assert.deepEqual(await preview(repo), [
    { subdir: "", skill_names: ["a", "b", "c"], notion: { id: "11111111-2222-3333-4444-555555555555", name: "Skills" } },
  ]);
});

test("vault in a subfolder (like agent-skills/skills)", async () => {
  const repo = makeRepo({ "README.md": "hi", "skills/skills.json": "{\"skills\":{}}", "skills/skills/z/SKILL.md": SKILL });
  assert.deepEqual(await preview(repo), [{ subdir: "skills", skill_names: ["z"], notion: null }]);
});

test("two candidates at the same depth, and no vault at all", async () => {
  const two = makeRepo({ "a/skills.json": "{}", "b/skills.json": "{}" });
  assert.deepEqual((await preview(two)).map((c) => c.subdir), ["a", "b"]);
  const none = makeRepo({ "README.md": "hi" });
  assert.deepEqual(await preview(none), []);
});

test("an empty repo has no vault", async () => {
  assert.deepEqual(await preview(makeRepo({})), []);
});

test("a repo that doesn't exist is a CloneError and leaves no temp folder", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sv-prev-"));
  try {
    await assert.rejects(previewClone(path.join(tmpRoot, "missing-repo"), { run: defaultRun, tmpRoot }), CloneError);
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((n) => n.startsWith("sv-clone-preview-")), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
