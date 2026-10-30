import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shimContents, shimDir, writeCommandShims } from "./commandShim.ts";

test("shimContents runs the bridge in command mode for cmd and sh", () => {
  const { cmd, sh } = shimContents("C:\\node\\node.exe", "C:\\app\\dist\\assistant-mcp.js");
  assert.equal(cmd, '@echo off\r\n"C:\\node\\node.exe" "C:\\app\\dist\\assistant-mcp.js" --client command %*\r\n');
  assert.equal(sh, '#!/bin/sh\nexec "C:/node/node.exe" "C:/app/dist/assistant-mcp.js" --client command "$@"\n');
});

test("shimDir is ~/.skill-vault/bin", () => {
  assert.equal(shimDir("H"), path.join("H", ".skill-vault", "bin"));
});

test("writeCommandShims writes both files and rewrites only on change", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sv-shim-")), "bin");
  try {
    assert.deepEqual(writeCommandShims("N1", "B", dir).map((f) => path.basename(f)).sort(), ["skill-vault", "skill-vault.cmd"]);
    assert.deepEqual(writeCommandShims("N1", "B", dir), []);
    assert.equal(writeCommandShims("N2", "B", dir).length, 2);
    assert.match(fs.readFileSync(path.join(dir, "skill-vault.cmd"), "utf-8"), /"N2"/);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
