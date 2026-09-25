import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHistoryRecorder, scanForUnrecordedChanges } from "./historyRecorder.ts";
import { listVersions, recordVersion } from "./history.ts";

let vault: string;
const write = (name: string, content: string) => {
  fs.mkdirSync(path.join(vault, "skills", name), { recursive: true });
  fs.writeFileSync(path.join(vault, "skills", name, "SKILL.md"), content);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "sv-rec-"));
});

test("a burst of changes becomes one external-edit version after quiet", async () => {
  const rec = createHistoryRecorder({ getVaultPath: () => vault, quietMs: 50 });
  write("demo", "a");
  rec.onSkillChanged("demo");
  await sleep(20);
  write("demo", "b");
  rec.onSkillChanged("demo");
  await sleep(20);
  write("demo", "c");
  rec.onSkillChanged("demo");
  assert.equal(listVersions(vault, "demo").length, 0);
  await sleep(120);
  const versions = listVersions(vault, "demo");
  assert.equal(versions.length, 1);
  assert.equal(versions[0].source, "external-edit");
  rec.close();
});

test("an external delete leaves a delete marker", async () => {
  write("gone", "x");
  recordVersion(vault, "gone", { source: "vault-edit" });
  const rec = createHistoryRecorder({ getVaultPath: () => vault, quietMs: 10 });
  fs.rmSync(path.join(vault, "skills", "gone"), { recursive: true });
  rec.onSkillChanged("gone");
  await sleep(50);
  assert.equal(listVersions(vault, "gone")[0].source, "delete");
  rec.close();
});

test("a debounce scheduled against vault A still fires against A after the active vault switches to B", async () => {
  const vaultA = fs.mkdtempSync(path.join(os.tmpdir(), "sv-rec-a-"));
  const vaultB = fs.mkdtempSync(path.join(os.tmpdir(), "sv-rec-b-"));
  const writeTo = (root: string, name: string, content: string) => {
    fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), content);
  };
  let current = vaultA;
  const rec = createHistoryRecorder({ getVaultPath: () => current, quietMs: 50 });
  writeTo(vaultA, "demo", "a");
  rec.onSkillChanged("demo");
  current = vaultB;
  await sleep(100);
  assert.equal(listVersions(vaultA, "demo").length, 1);
  assert.equal(fs.existsSync(path.join(vaultB, ".history")), false);
  rec.close();
});

test("startup scan records baseline and changed-while-closed skills", () => {
  write("a", "1");
  write("b", "1");
  recordVersion(vault, "b", { source: "vault-edit" });
  write("b", "2");
  const r = scanForUnrecordedChanges(vault);
  assert.equal(r.recorded, 2);
  assert.equal(listVersions(vault, "a")[0].note, "baseline");
  assert.equal(listVersions(vault, "b")[0].note, "changed while the app was closed");
  assert.equal(scanForUnrecordedChanges(vault).recorded, 0);
});

test("startup scan skips a skill whose versions.json is unreadable and keeps going", () => {
  write("broken", "x");
  write("fine", "y");
  const file = path.join(vault, ".history", "skills", "broken", "versions.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "<<<<<<< HEAD\n");
  const orig = console.error;
  console.error = () => {};
  let result;
  try {
    result = scanForUnrecordedChanges(vault);
  } finally {
    console.error = orig;
  }
  assert.equal(result.recorded, 1);
  assert.equal(result.gc, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "<<<<<<< HEAD\n");
  assert.equal(listVersions(vault, "fine").length, 1);
});
