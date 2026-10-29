import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_TARGETS, detectTargets } from "./targets.ts";

test("known tools are found, installed or not found; custom targets are kept", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-targets-"));
  try {
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor"));
    const custom = path.join(home, "repo", ".cursor", "skills");
    fs.mkdirSync(custom, { recursive: true });
    const list = detectTargets(home, {
      providers: [{ id: "claude", path: path.join(home, ".claude", "skills") }, { id: "Prompting BI", path: custom }],
      default_targets: ["claude"],
    });
    assert.deepEqual(list.slice(0, KNOWN_TARGETS.length).map((t) => t.id), ["claude", "openclaw", "cursor", "codex", "copilot", "windsurf"]);
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    assert.equal(byId.claude.status, "found");
    assert.equal(byId.claude.configured, true);
    assert.equal(byId.claude.is_default, true);
    assert.equal(byId.cursor.status, "installed");
    assert.equal(byId.cursor.path, path.join(home, ".cursor", "skills"));
    assert.equal(byId.codex.status, "not_found");
    assert.equal(byId["Prompting BI"].known, false);
    assert.equal(byId["Prompting BI"].status, "found");
    assert.equal(byId["Prompting BI"].label, "Prompting BI");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a configured known tool keeps its configured folder", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sv-targets-"));
  try {
    const list = detectTargets(home, { providers: [{ id: "copilot", path: "D:\\elsewhere\\skills" }] });
    assert.equal(list.find((t) => t.id === "copilot")?.path, "D:\\elsewhere\\skills");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
